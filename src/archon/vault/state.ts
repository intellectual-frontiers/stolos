/**
 * The vault's view of the boot machine's secrets (spec 029): what is there,
 * what the inventory says each one is, and whether the last backup holds it
 * as it is now. Names, sizes, and SHA-256 only; never a value.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { type Ledger, readLedger, VAULT_LOCAL, writeLedger } from "../core/secret-ledger.ts";
import { secretFor, type SecretRef } from "../model/secret-inventory.ts";

/** One secret file as it is now on the boot machine (no value: only its name, size and digest). */
export interface LiveSecret {
  /** Path inside the secrets folder, forward slashes. */
  name: string;
  /** Its full path on this machine. */
  path: string;
  /** Its inventory entry, when the inventory knows the path. */
  ref?: SecretRef;
  /** SHA-256 of its contents, hex. */
  sha256: string;
  /** Its size in bytes. */
  size: number;
  /** When it last changed (ISO 8601): the ledger's record, else the file's mtime. */
  changedAt: string;
}

/** SHA-256 of some bytes, as lowercase hex. */
export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every file in the secrets folder, with its inventory entry. */
export async function liveSecrets(dir = P.secrets, ledger?: Ledger): Promise<LiveSecret[]> {
  const out: LiveSecret[] = [];
  const walk = async (d: string, prefix: string) => {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(d)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory) await walk(join(d, e.name), rel);
      else if (e.isFile) {
        const path = join(d, e.name);
        const data = await Deno.readFile(path);
        const st = await Deno.stat(path);
        out.push({
          name: rel,
          path,
          ref: secretFor(rel),
          sha256: await sha256(data),
          size: data.length,
          changedAt: ledger?.changes[rel]?.changedAt ?? (st.mtime ?? new Date(0)).toISOString(),
        });
      }
    }
  };
  await walk(dir, "");
  return out;
}

/**
 * The recorded last backup (spec 056). A backup is a ZIP you move wherever you
 * keep important things, so archon cannot look for it there: the record counts.
 * "ok": a backup was made and read back; "none": nothing recorded. `where` says
 * whether the ZIP is still in the backup folder (not yet moved somewhere safe).
 */
export interface BackupCheck {
  /** "ok" (recorded), or "none". */
  state: "ok" | "none";
  /** "here": still in the backup folder; "moved": moved out (where you keep it). */
  where?: "here" | "moved";
}

/** The last backup's state (spec 056): recorded or not, and whether its ZIP is still here. */
export async function checkLastBackup(lb: Ledger["lastBackup"]): Promise<BackupCheck> {
  if (!lb) return { state: "none" };
  const here = lb.dir ? await exists(join(lb.dir, lb.file)) : false;
  return { state: "ok", where: here ? "here" : "moved" };
}

/** The vault's state: every secret, what the last backup lacks, and how urgent that is. */
export interface Assessment {
  /** Every secret, with whether the last recorded backup holds it as it is now. */
  items: Array<LiveSecret & { backedUp: boolean }>;
  /** Not ephemeral, and not in the last backup as it is now. */
  unbacked: Array<LiveSecret & { backedUp: boolean }>;
  /** In the last backup but no longer here (removed since). */
  removed: string[];
  /** The last backup recorded. */
  lastBackup?: Ledger["lastBackup"];
  /** Whether a backup is recorded, and whether its ZIP is still in the backup folder. */
  backupCheck: BackupCheck;
  /** Red: something unbacked for more than 7 days, or host identity keys never backed up. */
  severity: "ok" | "amber" | "red";
}

const DAY = 86_400_000;

/**
 * Compare the secrets folder with the ledger's last backup record (spec 056:
 * the record counts, wherever the ZIP is kept). Amber when anything is
 * unbacked or removed; red when a change is more than 7 days old, or host
 * identity keys have never been backed up.
 */
export async function assess(dir = P.secrets, now = Date.now()): Promise<Assessment> {
  const ledger = await readLedger();
  // Spec 056: the ZIP lives wherever you keep it; the record counts.
  const check = await checkLastBackup(ledger.lastBackup);
  const recorded = check.state === "ok" ? ledger.lastBackup : undefined;
  const items = (await liveSecrets(dir, ledger)).map((s) => ({
    ...s,
    backedUp: check.state === "ok" && recorded?.names[s.name] === s.sha256,
  }));
  const unbacked = items.filter((s) => !s.ref?.ephemeral && !s.backedUp);
  // Changed since the record.
  const changed = items.filter((s) => !s.ref?.ephemeral && recorded?.names[s.name] !== s.sha256);
  const live = new Set(items.map((s) => s.name));
  const removed = Object.keys(recorded?.names ?? {}).filter((n) => !live.has(n));
  // Red: changed for more than 7 days, or host identity keys with no backup at all.
  const red = changed.some((s) => now - Date.parse(s.changedAt) > 7 * DAY) ||
    (!recorded && unbacked.some((s) => s.ref?.identity));
  return {
    items,
    unbacked,
    removed,
    lastBackup: recorded,
    backupCheck: check,
    severity: unbacked.length || removed.length ? (red ? "red" : "amber") : "ok",
  };
}

// ------------------------------------------------------------ the prompt

/** The prompt's vault token (spec 011): "🔐 backup" while anything is unbacked, else empty. */
export const PROMPT_STATUS: string = join(P.bootCache, "..", "status", "prompt-vault");

/** Write the prompt's vault token from an assessment. Best effort: errors are ignored. */
export async function writePromptStatus(a: Assessment): Promise<void> {
  try {
    await Deno.mkdir(join(PROMPT_STATUS, ".."), { recursive: true });
    await Deno.writeTextFile(PROMPT_STATUS, a.severity === "ok" ? "" : "🔐 backup");
  } catch { /* the prompt is best effort */ }
}

/** Record a backup: its file, the folder it was written to, and every secret's SHA-256 in it. */
export async function markBackedUp(
  file: string,
  names: Record<string, string>,
  at = new Date().toISOString(),
  dir?: string,
): Promise<void> {
  const l = await readLedger();
  l.lastBackup = { at, file, names, ...(dir ? { dir } : {}) };
  await writeLedger(l);
}

export { exists, readTextOr, VAULT_LOCAL };
