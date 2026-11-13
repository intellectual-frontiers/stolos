// `deno task boot vault <sub>` (spec 029): the boot machine's secrets, copied
// as they are into the owner's OneDrive Personal Vault (which encrypts them and
// asks for a second sign-in to open), and restored from there onto a new PC
// (constitution Articles 13 and 22). Each backup is a folder: the secret files
// in their usual layout, and a manifest of names, SHA-256, and sizes.

import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { SECRETS, writeSecret } from "../core/secrets.ts";
import { readLedger } from "../core/secret-ledger.ts";
import { labelFor, SECRET_INVENTORY, secretFor } from "../model/secret-inventory.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import {
  assess,
  type LiveSecret,
  liveSecrets,
  markBackedUp,
  markRehearsed,
  sha256,
  UNLOCK_STEPS,
  vaultDir,
  vaultOpen,
  writePromptStatus,
} from "./state.ts";
import { installPrePushHook, pcName, preparePanel, remind } from "./reminder.ts";

const FORMAT = "archon-secrets/2";
export const MANIFEST = "manifest.json";

export interface Manifest {
  format: string;
  pc: string;
  created: string;
  commit: string;
  files: Array<{ name: string; sha256: string; size: number }>;
}

async function commit(): Promise<string> {
  return (await run(["git", "-C", P.repo, "rev-parse", "--short", "HEAD"])).stdout.trim() ||
    "unknown";
}

/** Compare a set of secrets with the live ones, by name and SHA-256. */
export function compare(
  want: Array<{ name: string; sha256: string }>,
  live: LiveSecret[],
): { missing: string[]; changed: string[]; extra: string[]; same: number } {
  const w = new Map(want.map((f) => [f.name, f.sha256]));
  const have = new Map(live.filter((s) => !s.ref?.ephemeral).map((s) => [s.name, s.sha256]));
  return {
    missing: [...w.keys()].filter((n) => !have.has(n)),
    changed: [...w.keys()].filter((n) => have.has(n) && have.get(n) !== w.get(n)),
    extra: [...have.keys()].filter((n) => !w.has(n)),
    same: [...w.keys()].filter((n) => have.get(n) === w.get(n)).length,
  };
}

const fmtDate = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "never";

/** The vault folder: --to, else OneDrive's Personal Vault; waits for it to be unlocked with --wait. */
async function target(o: { to?: string; wait?: boolean; quiet?: boolean }): Promise<string> {
  // The destination: --to, else ARCHON_VAULT_DIR, else OneDrive's Personal Vault.
  const chosen = o.to ?? Deno.env.get("ARCHON_VAULT_DIR");
  const dir = chosen ?? vaultDir();
  if (!dir) {
    throw new Error(
      "no OneDrive folder on this machine: pass --to <folder> (or set ARCHON_VAULT_DIR)",
    );
  }
  const where = () => {
    if (!o.quiet) {
      ui.say(
        `${ui.emoji ? "📁" : "*"} ${ui.dim("vault")}  ${dir}  ${
          ui.dim(chosen ? "" : "(another folder: --to <folder>, or set ARCHON_VAULT_DIR)")
        }`,
      );
    }
  };
  if (chosen) {
    await Deno.mkdir(dir, { recursive: true });
    where();
    // The files are copied as they are: only the Personal Vault encrypts them.
    if (!o.quiet && dir !== vaultDir()) {
      ui.say(
        ui.yellow(
          `${
            ui.emoji ? "⚠️ " : "!"
          } not the Personal Vault: the secrets are stored as they are; keep this folder private`,
        ),
      );
    }
    return dir;
  }
  if (!(await vaultOpen(dir))) {
    for (const l of UNLOCK_STEPS) ui.say(ui.yellow(l));
    if (!o.wait) {
      throw new Error(
        "the Personal Vault is locked: unlock it, then run this again (or add --wait)",
      );
    }
    ui.active().status("waiting up to 10 minutes for the Personal Vault to be unlocked");
    const until = Date.now() + 600_000;
    while (!(await vaultOpen(dir))) {
      if (Date.now() > until) throw new Error("the Personal Vault stayed locked for 10 minutes");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await Deno.mkdir(dir, { recursive: true });
  where();
  return dir;
}

/** Backups in a folder, newest first: the folders that hold a manifest. */
export async function backups(
  dir: string,
): Promise<Array<{ path: string; name: string; files: number; size: number; created: string }>> {
  const out: Array<{ path: string; name: string; files: number; size: number; created: string }> =
    [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isDirectory || !/^archon-secrets-/.test(e.name)) continue;
      const path = join(dir, e.name);
      const m = await readManifest(path);
      if (!m) continue;
      out.push({
        path,
        name: e.name,
        files: m.files.length,
        size: m.files.reduce((n, f) => n + f.size, 0),
        created: m.created,
      });
    }
  } catch { /* no folder yet */ }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

async function readManifest(backup: string): Promise<Manifest | undefined> {
  try {
    const m = JSON.parse((await readTextOr(join(backup, MANIFEST))) ?? "") as Manifest;
    return Array.isArray(m.files) ? m : undefined;
  } catch {
    return undefined;
  }
}

async function newest(o: { file?: string; to?: string; wait?: boolean }): Promise<string> {
  if (o.file) return o.file;
  const list = await backups(await target(o));
  if (!list.length) throw new Error("no backup in the vault yet: deno task boot vault backup");
  return list[0].path;
}

/** Copy the non-ephemeral live secrets into `dest` and write its manifest. */
async function copyOut(dest: string): Promise<Manifest> {
  const files = (await liveSecrets()).filter((s) => !s.ref?.ephemeral);
  for (const f of files) {
    const to = join(dest, ...f.name.split("/"));
    await Deno.mkdir(join(to, ".."), { recursive: true });
    await Deno.copyFile(f.path, to);
  }
  const m: Manifest = {
    format: FORMAT,
    pc: pcName(),
    created: new Date().toISOString(),
    commit: await commit(),
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size })),
  };
  await Deno.writeTextFile(join(dest, MANIFEST), JSON.stringify(m, null, 2) + "\n");
  return m;
}

/** Read a backup back: every file in its manifest present with its SHA-256. */
async function check(backup: string, m: Manifest): Promise<string[]> {
  const bad: string[] = [];
  for (const f of m.files) {
    const data = await Deno.readFile(join(backup, ...f.name.split("/"))).catch(() => undefined);
    if (!data || (await sha256(data)) !== f.sha256) bad.push(f.name);
  }
  return bad;
}

// ------------------------------------------------------------------ status

export async function vaultStatus(o: { lost?: boolean; hook?: boolean }): Promise<number> {
  const a = await assess();
  await writePromptStatus(a);
  if (o.hook) {
    // The pre-push hook: the panel only, and never a failure.
    await preparePanel(a);
    ui.printPanel();
    return 0;
  }
  await installPrePushHook().catch(() => false);
  const ledger = await readLedger();
  const rows = a.items.map((s) => [
    s.backedUp ? "✓" : s.ref?.ephemeral ? "·" : "⚠",
    s.name,
    s.ref ? labelFor(s.ref, s.name) : "NOT IN THE INVENTORY",
    fmtDate(s.changedAt),
    s.ref?.ephemeral
      ? "never (ephemeral)"
      : s.backedUp
      ? fmtDate(a.lastBackup?.at)
      : a.backupCheck.state === "unverifiable" && a.lastBackup?.names[s.name] === s.sha256
      ? "recorded, not verifiable"
      : "not backed up",
  ]);
  const w = [1, ...[1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length), 8))];
  console.log(
    `${ui.emoji ? "🔐 " : ""}${ui.bold(ui.cyan(`Secrets on ${pcName()}`))} ${
      ui.dim(`(${SECRETS.dir})`)
    }\n`,
  );
  console.log(
    ui.dim(
      `  ${"".padEnd(ui.emoji ? 2 : w[0] + 1)} ${"Secret".padEnd(w[1])}  ${"What".padEnd(w[2])}  ${
        "Changed".padEnd(w[3])
      }  Last backed up`,
    ),
  );
  for (const r of rows) {
    // ✓ green, ⚠ amber (the line's last column too), · dim for ephemeral.
    const tone = r[0] === "✓" ? ui.green : r[0] === "⚠" ? ui.yellow : ui.dim;
    const mark = ui.emoji ? (r[0] === "✓" ? "✅" : r[0] === "⚠" ? "🔐" : "⏳") : r[0];
    console.log(
      `  ${mark}${ui.emoji ? "" : " "} ${r[1].padEnd(w[1])}  ${ui.dim(r[2].padEnd(w[2]))}  ${
        ui.dim(r[3].padEnd(w[3]))
      }  ${tone(r[4])}`,
    );
  }
  const c = a.backupCheck;
  const last = c.state === "ok"
    ? `${fmtDate(a.lastBackup!.at)} (${a.lastBackup!.file})`
    : c.state === "unverifiable"
    ? ui.yellow(`recorded ${fmtDate(a.lastBackup!.at)}, not verifiable: ${c.why}`)
    : c.state === "missing"
    ? ui.yellow(`none (the recorded backup is gone: ${c.why})`)
    : "none";
  console.log(`\nLast backup: ${last} · last rehearse: ${fmtDate(ledger.rehearsedAt)}`);
  for (const n of a.removed) console.log(`  removed since the last backup: ${n}`);
  if (o.lost) {
    console.log(
      `\nIf ${pcName()} were lost without a backup, each would be made again like this:\n`,
    );
    const hosts = (await loadHosts().catch(() => [])).filter((h) => h.kind !== "workstation").map((
      h,
    ) => h.name);
    for (const ref of SECRET_INVENTORY) {
      const label = ref.label.includes("<host>")
        ? ref.label.replace("<host>", hosts.join(", ") || "<host>")
        : ref.label;
      console.log(
        `  ${ref.holder === "owner" ? "owner" : "boot "}  ${label.replace("<type>", "each type")}`,
      );
      console.log(
        `         ${ref.recreate.replace(/<host>/g, hosts.length === 1 ? hosts[0] : "<host>")}`,
      );
    }
  }
  await preparePanel(a);
  ui.printPanel();
  await remind();
  return a.unbacked.length || a.removed.length ? 1 : 0;
}

// ------------------------------------------------------------------ backup

export async function vaultBackup(o: { to?: string; wait?: boolean }): Promise<number> {
  const p = ui.phase("Vault backup");
  p.status("looking for the vault");
  const dir = await target(o);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = `archon-secrets-${pcName()}-${stamp}`;
  const dest = join(dir, name);
  p.status("copying the secrets");
  const m = await copyOut(dest);
  // Read it back and check every secret before saying it worked.
  p.status("reading the backup back");
  const bad = await check(dest, m);
  if (bad.length) {
    p.fail(
      `the backup does not read back correctly (${bad.join(", ")}); it is not counted`,
      "run vault backup again",
    );
    return 1;
  }
  await markBackedUp(
    name,
    Object.fromEntries(m.files.map((f) => [f.name, f.sha256])),
    m.created,
    dir,
  );
  await writePromptStatus(await assess());
  ui.panel = undefined;
  const n = m.files.length;
  p.done(`${n} secret${n === 1 ? "" : "s"} in ${dest} (read back and verified)`);
  return 0;
}

// ------------------------------------------------------------------ verify

export async function vaultVerify(o: { file?: string; to?: string }): Promise<number> {
  const p = ui.phase("Vault verify");
  const backup = await newest(o);
  const m = await readManifest(backup);
  if (!m) {
    p.fail(`${backup} has no ${MANIFEST}`, "pick another backup with --file");
    return 1;
  }
  const bad = await check(backup, m);
  for (const n of bad) {
    p.fail(`${n}: missing or damaged in the backup`, "deno task boot vault backup");
  }
  const c = compare(m.files, await liveSecrets());
  for (const n of c.missing) {
    p.warn(`${n}: in the backup, not on this machine`, "deno task boot vault restore");
  }
  for (const n of c.changed) p.warn(`${n}: differs from the backup`, "deno task boot vault backup");
  for (const n of c.extra) {
    p.warn(`${n}: on this machine, not in the backup`, "deno task boot vault backup");
  }
  p.done(`${backup}: ${c.same}/${m.files.length} match the live secrets`);
  return bad.length || c.missing.length || c.changed.length || c.extra.length ? 1 : 0;
}

// ------------------------------------------------------------------ restore

export async function vaultRestore(
  o: { file?: string; dryRun?: boolean; force?: boolean; into?: string; to?: string },
): Promise<number> {
  const p = ui.phase(o.into ? "Rehearse" : "Vault restore");
  p.status("looking for the newest backup");
  const backup = await newest(o);
  ui.say(`${ui.emoji ? "📦" : "*"} ${ui.dim("backup")} ${backup.split(/[\\/]/).pop()}`);
  const m = await readManifest(backup);
  if (!m) {
    p.fail(`${backup} has no ${MANIFEST}`, "pick another backup with --file");
    return 1;
  }
  const bad = await check(backup, m);
  if (bad.length) {
    p.fail(
      `missing or damaged in the backup: ${bad.join(", ")}`,
      "pick another backup with --file",
    );
    return 1;
  }
  const root = o.into ?? P.secrets;
  const live = await liveSecrets(root);
  const plan: Array<{ name: string; act: "write" | "same" | "keep-newer" }> = [];
  for (const f of m.files) {
    const l = live.find((x) => x.name === f.name);
    const act = !l
      ? "write"
      : l.sha256 === f.sha256
      ? "same"
      : Date.parse(l.changedAt) > Date.parse(m.created) && !o.force
      ? "keep-newer"
      : "write";
    plan.push({ name: f.name, act });
  }
  for (const x of plan) p.note(`${x.act.padEnd(10)} ${x.name}`);
  const newer = plan.filter((x) => x.act === "keep-newer");
  for (const x of newer) {
    p.warn(
      `${x.name} on this machine is newer than the backup: kept`,
      "add --force to overwrite it with the backup",
    );
  }
  const writes = plan.filter((x) => x.act === "write");
  if (o.dryRun) {
    p.done(
      `dry run: ${writes.length} to write, ${
        plan.filter((x) => x.act === "same").length
      } already the same`,
    );
    return 0;
  }
  for (const x of writes) {
    const from = join(backup, ...x.name.split("/"));
    const path = join(root, ...x.name.split("/"));
    if (o.into) {
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.copyFile(from, path);
    } else await writeSecret(path, await Deno.readTextFile(from));
  }
  if (o.into) {
    p.done(`restored into ${o.into}`);
    return 0;
  }
  // known_hosts from the hosts' public keys, as the boot machine had it.
  const { trustHost } = await import("../install/host-keys.ts");
  for (const h of (await loadHosts().catch(() => [])).filter((x) => x.kind !== "workstation")) {
    if (await exists(SECRETS.hostKey(h.name, "ed25519"))) {
      const names = await trustHost(h.name, [h.ip, h.dnsName].filter(Boolean) as string[]).catch(
        () => [],
      );
      p.note(`known_hosts: ${h.name} (${names.join(", ")})`);
    }
  }
  // The backup now matches the live secrets.
  await markBackedUp(
    backup.split(/[\\/]/).pop()!,
    Object.fromEntries(m.files.map((f) => [f.name, f.sha256])),
    m.created,
    join(backup, ".."),
  );
  // The panel was computed as each secret was written, before the backup was
  // recorded: what was just restored is what the backup holds.
  await preparePanel();
  p.done(`${writes.length} written, ${newer.length} kept (newer), from ${backup}`);
  const { doctor } = await import("../../archon-boot/doctor.ts");
  return Math.max(newer.length ? 1 : 0, await doctor({ port: 8080, embedded: true }));
}

// ----------------------------------------------------------------- rehearse

export async function vaultRehearse(o: { file?: string; to?: string }): Promise<number> {
  const tmp = await Deno.makeTempDir({ prefix: "archon-rehearse-" });
  try {
    // An empty vault: rehearse the round trip with the live secrets (copy out,
    // read back, restore into a temporary folder, compare), before the first backup.
    if (!o.file) {
      const p = ui.phase("Rehearse");
      p.status("looking for the vault");
      const dir = await target(o);
      if (!(await backups(dir)).length) {
        p.status("copying the live secrets into a temporary backup");
        const backup = join(tmp, "backup");
        const m = await copyOut(backup);
        const bad = await check(backup, m);
        const c = compare(m.files, await liveSecrets());
        if (bad.length || c.changed.length || c.missing.length) {
          p.fail(
            `the round trip lost or changed ${[...bad, ...c.changed, ...c.missing].join(", ")}`,
            "report this: the backup would not restore",
          );
          return 1;
        }
        p.warn(`no backup in ${dir} yet`, "deno task boot vault backup");
        p.done(
          `the round trip works: ${m.files.length} secrets copied, read back, and compared in a temporary folder; nothing was changed`,
        );
        return 0;
      }
    }
    const into = join(tmp, "restored");
    const code = await vaultRestore({ file: o.file, to: o.to, into });
    if (code) return code;
    const p = ui.phase("Compare");
    const restored = await liveSecrets(into);
    const c = compare(
      restored.map((s) => ({ name: s.name, sha256: s.sha256 })),
      await liveSecrets(),
    );
    for (const n of c.changed) {
      p.warn(`${n}: the backup differs from the live secret`, "deno task boot vault backup");
    }
    for (const n of c.extra) p.warn(`${n}: not in the backup`, "deno task boot vault backup");
    await markRehearsed();
    p.done(
      `a restore works: ${c.same} of ${restored.length} secrets match the live ones; nothing was changed`,
    );
    return c.changed.length || c.extra.length ? 1 : 0;
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

// ------------------------------------------------------------- list, prune

export async function vaultList(o: { to?: string }): Promise<number> {
  const list = await backups(await target(o));
  if (!list.length) console.log("no backups yet: deno task boot vault backup");
  for (const b of list) {
    console.log(
      `${b.name}  ${b.files} files  ${(b.size / 1024).toFixed(1)} KB  ${fmtDate(b.created)}`,
    );
  }
  return 0;
}

export async function vaultPrune(o: { keep: number; to?: string }): Promise<number> {
  const keep = Math.max(1, o.keep); // never the newest
  const list = await backups(await target(o));
  for (const b of list.slice(keep)) {
    await Deno.remove(b.path, { recursive: true });
    console.log(`removed ${b.name}`);
  }
  console.log(`${Math.min(list.length, keep)} kept`);
  return 0;
}

// ------------------------------------------------- recover host keys

/**
 * Pull a running host's identities back over SSH (a boot machine lost without
 * a backup): its SSH host keys and ops' deploy key, so the rebuilt boot machine
 * holds the same ones (nothing changes on GitHub, and clients see the same host).
 */
export async function recoverHostKeys(host: string): Promise<number> {
  const p = ui.phase("Recover host keys");
  const fleet = await loadFleet();
  const target = `${fleet.admin.user}@${host}`;
  p.status(`ssh ${target} archon host-keys export`);
  ui.pause(); // ssh may ask to trust the host (this PC lost its known_hosts too)
  const r = await run([
    "ssh",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    target,
    "archon host-keys export",
  ]);
  ui.resume();
  if (!r.ok) {
    p.fail(
      `ssh ${target}: ${r.stderr.trim().split("\n").pop()}`,
      `can this PC ssh to ${host}? (your own key on GitHub, or the admin password from a local network)`,
    );
    return 1;
  }
  const { parseHostExport, trustHost } = await import("../install/host-keys.ts");
  const x = parseHostExport(r.stdout.trim().split("\n").pop()!);
  for (const k of x.hostKeys) {
    await writeSecret(SECRETS.hostKey(host, k.type), k.private);
    await writeSecret(`${SECRETS.hostKey(host, k.type)}.pub`, `${k.public} root@${host}\n`);
  }
  if (x.deployKey) {
    await writeSecret(SECRETS.deployKey(host), x.deployKey.private);
    await writeSecret(SECRETS.deployKeyPub(host), `${x.deployKey.public} archon-${host}\n`);
  } else {
    p.warn(
      `${host} sent no deploy key`,
      `deno task archon host add ${host} (registers a new one), then deno task boot reinstall ${host}`,
    );
  }
  // This PC trusts the recovered host keys again (known_hosts), for every name it uses.
  const h = (await loadHosts().catch(() => [])).find((x) => x.name === host);
  await trustHost(host, [h?.ip, h?.dnsName].filter(Boolean) as string[]).catch(() => []);
  p.done(
    `${host}: ${x.hostKeys.length} host keys (${x.hostKeys.map((k) => k.type).join(", ")})${
      x.deployKey ? " and its deploy key" : ""
    } recovered; back them up: deno task boot vault backup`,
  );
  return 0;
}

export { secretFor };
