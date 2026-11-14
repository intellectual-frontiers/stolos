/**
 * Backups (spec 016, Article 14): zstd tar archives of the host's own state and its durable data (spec 044),
 * kept to a retention count, with a restore test. Never restores in place:
 * a restore extracts into a directory for you to inspect.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { ensureDir, exists, listFiles } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { journal } from "../core/log.ts";
import { planFor } from "../build.ts";
import type { BackupDef, HostDef } from "../model/types.ts";
import { backupPolicy } from "../capabilities/backup.ts";
import { durableGuests } from "../model/durable.ts";

async function policy(host: HostDef): Promise<BackupDef> {
  await planFor(host); // the model must be valid
  return backupPolicy(host);
}

async function archives(p: BackupDef, host: string): Promise<string[]> {
  return (await listFiles(p.target, ".tar.zst")).filter((f) => f.startsWith(`${host}-`));
}

export async function backupRun(host: HostDef) {
  const p = await policy(host);
  await ensureDir(p.target);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = join(p.target, `${host.name}-${stamp}.tar.zst`);
  const paths: string[] = [];
  for (const x of p.paths) if (await exists(x)) paths.push(x);
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
    await Deno.remove(join(p.target, old));
  }

  await journal(
    "archon-backup",
    `backup written: ${archive}`,
  );
  const guests = await exportGuests(host, p, stamp);
  return { archive, kept: Math.min(all.length, p.keep), guests };
}

/**
 * Spec 044: each durable guest is exported (lxc export, the instance and its
 * snapshots) next to the archives, keeping the newest N of each.
 */
async function exportGuests(host: HostDef, p: BackupDef, stamp: string) {
  const out: Array<{ guest: string; file?: string; error?: string }> = [];
  for (const g of durableGuests(host)) {
    const prefix = `${host.name}-guest-${g}-`;
    const file = join(p.target, `${prefix}${stamp}.tar.gz`);
    const r = await run(["lxc", "export", g, file]);
    if (!r.ok) {
      out.push({ guest: g, error: r.stderr.trim() });
      await journal("archon-backup", `lxc export ${g} failed: ${r.stderr.trim()}`);
      continue;
    }
    const all = (await listFiles(p.target, ".tar.gz")).filter((f) => f.startsWith(prefix));
    for (const old of all.slice(0, Math.max(0, all.length - p.keep))) {
      await Deno.remove(join(p.target, old));
    }
    out.push({ guest: g, file });
  }
  return out;
}

export async function backupVerify(host: HostDef) {
  const p = await policy(host);
  const all = await archives(p, host.name);
  const newest = all.pop();
  if (!newest) return { ok: false, reason: "no archives yet", archive: "" };
  const archive = join(p.target, newest);
  const list = await run(["tar", "--zstd", "-tf", archive]);
  if (!list.ok) return { ok: false, reason: `cannot list archive: ${list.stderr.trim()}`, archive };
  const tmp = await Deno.makeTempDir({ prefix: "archon-restore-test-" });
  try {
    const x = await run(["tar", "--zstd", "-xf", archive, "-C", tmp, "etc/archon/host"]);
    if (!x.ok) {
      return { ok: false, reason: `cannot extract etc/archon/host: ${x.stderr.trim()}`, archive };
    }
    const restored = (await Deno.readTextFile(join(tmp, "etc/archon/host"))).trim();
    if (restored !== host.name) {
      return { ok: false, reason: `restored host marker '${restored}' != '${host.name}'`, archive };
    }
    return { ok: true, reason: "", archive, entries: list.stdout.split("\n").length };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

export async function backupRestore(host: HostDef, name: string | undefined, to: string) {
  const p = await policy(host);
  const pick = name ?? (await archives(p, host.name)).pop();
  if (!pick) throw new Error("no archives to restore");
  const archive = join(p.target, pick);
  const dir = join(to, pick.replace(/\.tar\.zst$/, ""));
  await ensureDir(dir);
  const r = await run(["tar", "--zstd", "-xpf", archive, "-C", dir]);
  if (!r.ok) throw new Error(`extract failed: ${r.stderr.trim()}`);
  return { archive, dir };
}
