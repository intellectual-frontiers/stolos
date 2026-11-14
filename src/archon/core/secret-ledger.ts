/**
 * The secret ledger (spec 029): when each boot-machine secret last changed,
 * by name only. It holds no secret: it is what tells `deno task stolos vault
 * status` (and the reminders) that something is newer than the last backup.
 * %LOCALAPPDATA%\archon\vault\ledger.json (Linux: ~/.local/share/archon/vault).
 *
 * @module
 */

import { P } from "./paths.ts";
import { join, relative } from "./path.ts";
import { ensureDir, readTextOr } from "./fsx.ts";

/** The vault's local folder on the boot machine (holds the ledger; no secret). */
export const VAULT_LOCAL: string = join(P.bootCache, "..", "vault");
/** The ledger file: `ledger.json` in `VAULT_LOCAL`. */
export const LEDGER: string = join(VAULT_LOCAL, "ledger.json");

/** The record of the last backup (spec 056): its ZIP, where it was written, and what it held. */
export interface LedgerBackup {
  /** When it was made (ISO 8601). */
  at: string;
  /** The backup's file name (spec 056: a ZIP; spec 029's backups were folders). */
  file: string;
  /** The folder it was written to (the backup folder); older records lack it. */
  dir?: string;
  /** Path inside the secrets folder -> SHA-256 of what was backed up. */
  names: Record<string, string>;
}

/** The ledger's contents: secrets' change times and the last backup, by name only. */
export interface Ledger {
  /** Path inside the secrets folder (forward slashes) -> when it was written or removed. */
  changes: Record<string, { changedAt: string; removed?: boolean }>;
  /** The last backup recorded; absent before the first one. */
  lastBackup?: LedgerBackup;
  /** The last "N secrets not backed up" email (spec 025). */
  remindedAt?: string;
}

/** Read the ledger; a missing or unreadable file reads as an empty one. */
export async function readLedger(path = LEDGER): Promise<Ledger> {
  try {
    return { changes: {}, ...JSON.parse((await readTextOr(path)) ?? "{}") };
  } catch {
    return { changes: {} };
  }
}

/** Write the ledger (as formatted JSON), creating the vault folder first. */
export async function writeLedger(l: Ledger, path = LEDGER): Promise<void> {
  await ensureDir(VAULT_LOCAL);
  await Deno.writeTextFile(path, JSON.stringify(l, null, 2) + "\n");
}

/** The secret's name: its path inside the secrets folder, with forward slashes. */
export const secretName = (path: string): string => relative(P.secrets, path).replace(/\\/g, "/");

/** Secrets changed by this process (for the closing panel). */
export const changedThisRun = new Set<string>();

/**
 * Record that a secret was written (or removed) now, then prepare the
 * closing panel. Never throws: the ledger is advisory.
 */
export async function recordChange(path: string, removed = false): Promise<void> {
  const name = secretName(path);
  changedThisRun.add(name);
  try {
    const l = await readLedger();
    l.changes[name] = {
      changedAt: new Date().toISOString(),
      ...(removed ? { removed: true } : {}),
    };
    await writeLedger(l);
    // The closing panel (spec 029): what is now newer than the last backup.
    const { preparePanel } = await import("../vault/reminder.ts");
    await preparePanel();
  } catch { /* the ledger is advisory: a secret write never fails on it */ }
}
