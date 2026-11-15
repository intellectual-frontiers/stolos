/**
 * Backups (spec 016, Article 14): zstd tar archives of the host's own state and its durable data (spec 044),
 * kept to a retention count, with a restore test. Never restores in place:
 * a restore extracts into a directory for you to inspect.
 *
 * @module
 */

import { fs, path } from "@intellectual-frontiers/ifc-ts/runtime";
import { run } from "../core/exec.ts";
import { journal } from "../core/log.ts";
import { planFor } from "../build.ts";
import type { BackupDef, HostDef } from "../model/types.ts";
import { backupPolicy } from "../capabilities/backup.ts";
import { durableGuests } from "../model/durable.ts";

/** One durable guest's export (spec 044): its file, or why it failed. */
export interface GuestExport {
  /** The LXD instance's name. */
  guest: string;
  /** The `lxc export` file written next to the archives, when it worked. */
  file?: string;
  /** lxc's error output, when the export failed. */
  error?: string;
}

/** What a backup run wrote. */
export interface BackupResult {
  /** Path of the new archive (`<target>/<host>-<timestamp>.tar.zst`). */
  archive: string;
  /** How many archives are kept after pruning (at most the policy's `keep`). */
  kept: number;
  /** Each durable guest's export, in model order. */
  guests: GuestExport[];
}

/** The outcome of a restore test of the newest archive. */
export interface VerifyResult {
  /** True when the archive lists and its host marker restores to this host's name. */
  ok: boolean;
  /** Why the test failed; empty when it passed. */
  reason: string;
  /** Path of the archive tested; empty when there is none yet. */
  archive: string;
  /** How many lines the archive's listing has (set only when the test passed). */
  entries?: number;
}

/** Where a restore put an archive. */
export interface RestoreResult {
  /** Path of the archive extracted. */
  archive: string;
  /** The directory it was extracted into (`<to>/<archive name>`). */
  dir: string;
}

async function policy(host: HostDef): Promise<BackupDef> {
  await planFor(host); // the model must be valid
  return backupPolicy(host);
}

async function archives(p: BackupDef, host: string): Promise<string[]> {
  return (await fs.listFiles(p.target, ".tar.zst")).filter((f) => f.startsWith(`${host}-`));
}

/**
 * Write a zstd tar archive of the host's backup paths (those that exist), prune
 * old archives to the policy's `keep`, journal it, then export each durable
 * guest (spec 044). Throws when tar fails (exit code above 1).
 */
export async function backupRun(host: HostDef): Promise<BackupResult> {
  const p = await policy(host);
  await fs.ensureDir(p.target);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = path.join(p.target, `${host.name}-${stamp}.tar.zst`);
  const paths: string[] = [];
  for (const x of p.paths) if (await fs.exists(x)) paths.push(x);
  const r = await run([
    "tar",
    "--zstd",
    "--create",
    "--preserve-permissions",
    "--xattrs",
    "--acls",
    "--one-file-system",
    "--warning=no-file-ignored",
    "--exclude=*.archon-tmp",
    "--file",
    archive,
    ...paths,
  ]);
  // tar exits 1 when files changed while reading; the archive is still usable.
  if (r.code > 1) throw new Error(`tar failed: ${r.stderr.trim()}`);
  const all = await archives(p, host.name);
  for (const old of all.slice(0, Math.max(0, all.length - p.keep))) {
    await fs.remove(path.join(p.target, old));
  }

  await journal("archon-backup", `backup written: ${archive}`);
  const guests = await exportGuests(host, p, stamp);
  return { archive, kept: Math.min(all.length, p.keep), guests };
}

/**
 * Spec 044: each durable guest is exported (lxc export, the instance and its
 * snapshots) next to the archives, keeping the newest N of each.
 */
async function exportGuests(host: HostDef, p: BackupDef, stamp: string): Promise<GuestExport[]> {
  const out: GuestExport[] = [];
  for (const g of durableGuests(host)) {
    const prefix = `${host.name}-guest-${g}-`;
    const file = path.join(p.target, `${prefix}${stamp}.tar.gz`);
    const r = await run(["lxc", "export", g, file]);
    if (!r.ok) {
      out.push({ guest: g, error: r.stderr.trim() });
      await journal("archon-backup", `lxc export ${g} failed: ${r.stderr.trim()}`);
      continue;
    }
    const all = (await fs.listFiles(p.target, ".tar.gz")).filter((f) => f.startsWith(prefix));
    for (const old of all.slice(0, Math.max(0, all.length - p.keep))) {
      await fs.remove(path.join(p.target, old));
    }
    out.push({ guest: g, file });
  }
  return out;
}

/**
 * Restore-test the newest archive (Article 14): list it, then extract
 * `etc/archon/host` into a temporary directory and check it names this host.
 * Changes nothing on the live system.
 */
export async function backupVerify(host: HostDef): Promise<VerifyResult> {
  const p = await policy(host);
  const all = await archives(p, host.name);
  const newest = all.pop();
  if (!newest) return { ok: false, reason: "no archives yet", archive: "" };
  const archive = path.join(p.target, newest);
  const list = await run(["tar", "--zstd", "-tf", archive]);
  if (!list.ok) return { ok: false, reason: `cannot list archive: ${list.stderr.trim()}`, archive };
  const tmp = await fs.makeTempDir({ prefix: "archon-restore-test-" });
  try {
    const x = await run(["tar", "--zstd", "-xf", archive, "-C", tmp, "etc/archon/host"]);
    if (!x.ok) {
      return { ok: false, reason: `cannot extract etc/archon/host: ${x.stderr.trim()}`, archive };
    }
    const restored = (await fs.readTextFile(path.join(tmp, "etc/archon/host"))).trim();
    if (restored !== host.name) {
      return { ok: false, reason: `restored host marker '${restored}' != '${host.name}'`, archive };
    }
    return { ok: true, reason: "", archive, entries: list.stdout.split("\n").length };
  } finally {
    await fs.remove(tmp, { recursive: true });
  }
}

/**
 * Extract an archive (`name`, or the newest) into `<to>/<archive name>` to
 * inspect. Never restores in place. Throws when there is no archive or tar fails.
 */
export async function backupRestore(
  host: HostDef,
  name: string | undefined,
  to: string,
): Promise<RestoreResult> {
  const p = await policy(host);
  const pick = name ?? (await archives(p, host.name)).pop();
  if (!pick) throw new Error("no archives to restore");
  const archive = path.join(p.target, pick);
  const dir = path.join(to, pick.replace(/\.tar\.zst$/, ""));
  await fs.ensureDir(dir);
  const r = await run(["tar", "--zstd", "-xpf", archive, "-C", dir]);
  if (!r.ok) throw new Error(`extract failed: ${r.stderr.trim()}`);
  return { archive, dir };
}
