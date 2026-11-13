// The vault's view of the boot machine's secrets (spec 029): what is there,
// what the inventory says each one is, and whether the last backup holds it
// as it is now. Names, sizes, and SHA-256 only; never a value.

import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { type Ledger, readLedger, VAULT_LOCAL, writeLedger } from "../core/secret-ledger.ts";
import { secretFor, type SecretRef } from "../model/secret-inventory.ts";

export interface LiveSecret {
  /** Path inside the secrets folder, forward slashes. */
  name: string;
  path: string;
  ref?: SecretRef;
  sha256: string;
  size: number;
  changedAt: string;
}

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
 * Is the recorded last backup really there? "ok": its folder and manifest are
 * at the destination and match the record; "missing": the destination is
 * reachable but the backup is gone or different (it does not count);
 * "unverifiable": the destination cannot be read now (the Personal Vault is
 * locked); "none": nothing recorded.
 */
export interface BackupCheck {
  state: "ok" | "missing" | "unverifiable" | "none";
  why?: string;
}

/** Reachable: the Personal Vault unlocked, or another folder's parent present. */
async function reachable(dir: string): Promise<boolean> {
  const pv = vaultDir();
  if (pv && dir === pv) return await vaultOpen(dir);
  return await Deno.stat(join(dir, "..")).then((s) => s.isDirectory).catch(() => false);
}

export async function checkLastBackup(lb: Ledger["lastBackup"]): Promise<BackupCheck> {
  if (!lb) return { state: "none" };
  const dir = lb.dir ?? vaultDir();
  if (!dir) {
    return {
      state: "unverifiable",
      why: "its folder is not recorded and there is no OneDrive here",
    };
  }
  if (!(await reachable(dir))) {
    return {
      state: "unverifiable",
      why: dir === vaultDir() ? "Personal Vault locked" : `${dir} cannot be reached`,
    };
  }
  let manifest: { files?: Array<{ name: string; sha256: string }> } | undefined;
  try {
    manifest = JSON.parse(await Deno.readTextFile(join(dir, lb.file, "manifest.json")));
  } catch {
    return { state: "missing", why: `${lb.file} is not in ${dir}` };
  }
  const recorded = Object.entries(lb.names).sort().join("|");
  const there = (manifest?.files ?? []).map((f) => [f.name, f.sha256]).sort().join("|");
  if (recorded !== there) {
    return { state: "missing", why: `${lb.file} in ${dir} is not the backup recorded` };
  }
  return { state: "ok" };
}

export interface Assessment {
  items: Array<LiveSecret & { backedUp: boolean }>;
  /** Not ephemeral, and not in the last backup as it is now. */
  unbacked: Array<LiveSecret & { backedUp: boolean }>;
  /** In the last backup but no longer here (removed since). */
  removed: string[];
  /** The last backup, only when it was found where it was written (or could not be checked). */
  lastBackup?: Ledger["lastBackup"];
  /** Whether the recorded last backup was found. */
  backupCheck: BackupCheck;
  rehearsedAt?: string;
  /** Red: something unbacked for more than 7 days, or host identity keys never backed up. */
  severity: "ok" | "amber" | "red";
}

const DAY = 86_400_000;

export async function assess(dir = P.secrets, now = Date.now()): Promise<Assessment> {
  const ledger = await readLedger();
  // The record counts only if the backup is really there (spec 029 FR-014).
  const check = await checkLastBackup(ledger.lastBackup);
  const recorded = check.state === "ok" || check.state === "unverifiable"
    ? ledger.lastBackup
    : undefined;
  const items = (await liveSecrets(dir, ledger)).map((s) => ({
    ...s,
    backedUp: check.state === "ok" && recorded?.names[s.name] === s.sha256,
  }));
  const unbacked = items.filter((s) => !s.ref?.ephemeral && !s.backedUp);
  // Changed since the record (whether or not the backup can be checked now).
  const changed = items.filter((s) => !s.ref?.ephemeral && recorded?.names[s.name] !== s.sha256);
  const live = new Set(items.map((s) => s.name));
  const removed = Object.keys(recorded?.names ?? {}).filter((n) => !live.has(n));
  // Red: changed for more than 7 days, or host identity keys with no backup at all.
  // A backup that only cannot be checked now (the vault locked) stays amber.
  const red = changed.some((s) => now - Date.parse(s.changedAt) > 7 * DAY) ||
    (!recorded && unbacked.some((s) => s.ref?.identity));
  return {
    items,
    unbacked,
    removed,
    lastBackup: recorded,
    backupCheck: check,
    rehearsedAt: ledger.rehearsedAt,
    severity: unbacked.length || removed.length ? (red ? "red" : "amber") : "ok",
  };
}

// ------------------------------------------------------------ the vault

/** OneDrive's Personal Vault, Archon's folder in it (Windows). */
export function vaultDir(): string | undefined {
  const od = Deno.env.get("OneDrive") ?? Deno.env.get("OneDriveConsumer");
  return od ? join(od, "Personal Vault", "Archon") : undefined;
}

/** Is the Personal Vault unlocked (its folder present and readable)? */
export async function vaultOpen(dir: string): Promise<boolean> {
  const parent = join(dir, "..");
  try {
    const st = await Deno.stat(parent);
    if (!st.isDirectory) return false;
    for await (const _ of Deno.readDir(parent)) break;
    return true;
  } catch {
    return false;
  }
}

export const UNLOCK_STEPS = [
  "Unlock OneDrive's Personal Vault: File Explorer > OneDrive > Personal Vault, then verify",
  "your identity (Windows Hello, or the code Microsoft sends). It locks again after 20 minutes.",
];

// ------------------------------------------------------------ the prompt

/** The prompt's vault token (spec 011): "🔐 backup" while anything is unbacked, else empty. */
export const PROMPT_STATUS = join(P.bootCache, "..", "status", "prompt-vault");

export async function writePromptStatus(a: Assessment): Promise<void> {
  try {
    await Deno.mkdir(join(PROMPT_STATUS, ".."), { recursive: true });
    await Deno.writeTextFile(PROMPT_STATUS, a.severity === "ok" ? "" : "🔐 backup");
  } catch { /* the prompt is best effort */ }
}

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

export async function markRehearsed(): Promise<void> {
  const l = await readLedger();
  l.rehearsedAt = new Date().toISOString();
  await writeLedger(l);
}

export { exists, readTextOr, VAULT_LOCAL };
