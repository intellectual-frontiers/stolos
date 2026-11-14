/**
 * The secret ledger (spec 029): when each boot-machine secret last changed,
 * by name only. It holds no secret: it is what tells `deno task boot vault
 * status` (and the reminders) that something is newer than the last backup.
 * %LOCALAPPDATA%\archon\vault\ledger.json (Linux: ~/.local/share/archon/vault).
 *
 * @module
 */

import { P } from "./paths.ts";
import { join, relative } from "./path.ts";
import { ensureDir, readTextOr } from "./fsx.ts";

export const VAULT_LOCAL = join(P.bootCache, "..", "vault");
export const LEDGER = join(VAULT_LOCAL, "ledger.json");

export interface LedgerBackup {
  at: string;
  /** The backup's folder name. */
  file: string;
  /** The folder it was written to (the vault); older records lack it. */
  dir?: string;
  /** Path inside the secrets folder -> SHA-256 of what was backed up. */
  names: Record<string, string>;
}

export interface Ledger {
  /** Path inside the secrets folder (forward slashes) -> when it was written or removed. */
  changes: Record<string, { changedAt: string; removed?: boolean }>;
  lastBackup?: LedgerBackup;
  rehearsedAt?: string;
  /** The last "N secrets not backed up" email (spec 025), and the last rehearse reminder. */
  remindedAt?: string;
  rehearseRemindedAt?: string;
}

export async function readLedger(path = LEDGER): Promise<Ledger> {
  try {
    return { changes: {}, ...JSON.parse((await readTextOr(path)) ?? "{}") };
  } catch {
    return { changes: {} };
  }
}

export async function writeLedger(l: Ledger, path = LEDGER): Promise<void> {
  await ensureDir(VAULT_LOCAL);
  await Deno.writeTextFile(path, JSON.stringify(l, null, 2) + "\n");
}

/** The secret's name: its path inside the secrets folder, with forward slashes. */
export const secretName = (path: string) => relative(P.secrets, path).replace(/\\/g, "/");

/** Secrets changed by this process (for the closing panel). */
export const changedThisRun = new Set<string>();

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
