/**
 * `bun run stolos vault <sub>` (specs 029 and 056): the boot machine's secrets,
 * and their backup. A backup is one ZIP file (see {@link writeBackupZip}),
 * written into stolos's backup folder; you then move it wherever you keep
 * important things safe. `vault restore <zip>` (spec 061) puts it back on a
 * freshly cloned PC; without a ZIP it prints the steps (constitution Article 22).
 *
 * ```mermaid
 * flowchart LR
 *   status["vault status<br/>what changed since the last backup"] --> backup["vault backup<br/>a ZIP in the backup folder"]
 *   backup --> move["you move the ZIP<br/>somewhere safe"]
 *   move -. "after a disaster" .-> restore["vault restore &lt;zip&gt;<br/>on the new PC"]
 * ```
 *
 * @module
 */

import { stdio } from "@intellectual-frontiers/system";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { SECRETS, writeSecret } from "../core/secrets.ts";
import { labelFor, SECRET_INVENTORY, secretFor } from "../model/secret-inventory.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { assess, writePromptStatus } from "./state.ts";
import { installPrePushHook, pcName, preparePanel, remind } from "./reminder.ts";
import { BACKUP_DIR, backupZips, restoreText, writeBackupZip } from "./zip.ts";

const fmtDate = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "never";

// ------------------------------------------------------------------ status

/** `vault status`: every secret, when it changed, and whether the last backup holds it. */
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
  const rows = a.items.map((s): [string, string, string, string, string] => [
    s.backedUp ? "✓" : s.ref?.ephemeral ? "·" : "⚠",
    s.name,
    s.ref ? labelFor(s.ref, s.name) : "NOT IN THE INVENTORY",
    fmtDate(s.changedAt),
    s.ref?.ephemeral
      ? "never (ephemeral)"
      : s.backedUp
        ? fmtDate(a.lastBackup?.at)
        : "not backed up",
  ]);
  const widest = (i: 1 | 2 | 3): number => Math.max(...rows.map((r) => r[i].length), 8);
  const w = [1, widest(1), widest(2), widest(3)] as const;
  stdio.stdout.writeSync(
    `${ui.emoji ? "🔐 " : ""}${ui.bold(ui.cyan(`Secrets on ${pcName()}`))} ${ui.dim(
      `(${SECRETS.dir})`,
    )}\n\n`,
  );
  stdio.stdout.writeSync(
    `${ui.dim(
      `  ${"".padEnd(ui.emoji ? 2 : w[0] + 1)} ${"Secret".padEnd(w[1])}  ${"What".padEnd(w[2])}  ${"Changed".padEnd(
        w[3],
      )}  Last backed up`,
    )}\n`,
  );
  for (const r of rows) {
    // ✓ green, ⚠ amber (the line's last column too), · dim for ephemeral.
    const tone = r[0] === "✓" ? ui.green : r[0] === "⚠" ? ui.yellow : ui.dim;
    const mark = ui.emoji ? (r[0] === "✓" ? "✅" : r[0] === "⚠" ? "🔐" : "⏳") : r[0];
    stdio.stdout.writeSync(
      `  ${mark}${ui.emoji ? "" : " "} ${r[1].padEnd(w[1])}  ${ui.dim(r[2].padEnd(w[2]))}  ${ui.dim(
        r[3].padEnd(w[3]),
      )}  ${tone(r[4])}\n`,
    );
  }
  const c = a.backupCheck;
  const last =
    c.state === "ok" && a.lastBackup
      ? `${fmtDate(a.lastBackup.at)} (${a.lastBackup.file})`
      : "none";
  stdio.stdout.writeSync(`\nLast backup: ${last}\n`);
  if (c.where === "here") {
    stdio.stdout.writeSync(
      `${ui.yellow(
        `  it is still in ${BACKUP_DIR}: move it somewhere safe (see: bun run stolos vault backup)`,
      )}\n`,
    );
  }
  for (const n of a.removed) stdio.stdout.writeSync(`  removed since the last backup: ${n}\n`);
  if (o.lost) {
    stdio.stdout.writeSync(
      `\nIf ${pcName()} were lost without a backup, each would be made again like this:\n\n`,
    );
    const hosts = (await loadHosts().catch(() => []))
      .filter((h) => h.kind !== "workstation")
      .map((h) => h.name);
    for (const ref of SECRET_INVENTORY) {
      const label = ref.label.includes("<host>")
        ? ref.label.replace("<host>", hosts.join(", ") || "<host>")
        : ref.label;
      stdio.stdout.writeSync(
        `  ${ref.holder === "owner" ? "owner" : "boot "}  ${label.replace("<type>", "each type")}\n`,
      );
      stdio.stdout.writeSync(
        `         ${ref.recreate.replace(/<host>/g, hosts.length === 1 ? (hosts[0] ?? "<host>") : "<host>")}\n`,
      );
    }
  }
  await preparePanel(a);
  ui.printPanel();
  await remind();
  return a.unbacked.length || a.removed.length ? 1 : 0;
}

// ------------------------------------------------------------------ backup

/** What to tell the person once the ZIP is written: where it is, and where to put it. */
export function afterBackup(path: string, signingKey?: string, recovery = false): string[] {
  const keys =
    signingKey && recovery
      ? "both signing keys (daily and recovery, each locked by its own passphrase)"
      : signingKey
        ? `your daily signing key (${signingKey}, locked by its passphrase)`
        : "";
  return [
    `Your backup is ${path}`,
    "",
    "It is everything a disaster needs: every secret of every fleet on this PC" +
      (keys ? `, and ${keys}` : "") +
      ".",
    "Move it wherever you keep important things safe and encrypted (your OneDrive",
    "Personal Vault, a password manager, an encrypted USB drive), and keep an older one",
    "too. The ZIP itself is not encrypted: anyone with it and your passphrases could",
    "change your servers, so treat it like the keys to them.",
    "",
    "After a disaster, on the new PC, in the cloned fleet repository:",
    "  bun run stolos vault restore <this ZIP>   (RESTORE.txt in the ZIP says the same)",
  ];
}

/** `vault backup`: one ZIP with every secret and both signing keys, read back and recorded. */
export async function vaultBackup(): Promise<number> {
  const p = ui.phase("Backup");
  p.status("zipping the secrets and both signing keys");
  let r;
  try {
    r = await writeBackupZip(pcName());
  } catch (e) {
    p.fail((e as Error).message, "run bun run stolos vault backup again");
    return 1;
  }
  if (!r.signingKey) {
    p.warn(
      "no signing key in Git's settings (git config user.signingkey), so none is in the ZIP",
      "set up signing (the fleet repository's README), then back up again",
    );
  }
  await writePromptStatus(await assess());
  delete ui.panel;
  const n = r.manifest.files.length;
  p.done(
    `${n} file${n === 1 ? "" : "s"} (${
      r.fleets.join(", ") || "no fleet secrets yet"
    }), read back and checked`,
  );
  stdio.stdout.writeSync("\n");
  if (r.movedRecoveryTo) {
    p.note(
      `the recovery key was moved into the key store (${r.movedRecoveryTo}): every backup holds it now`,
    );
  }
  for (const l of afterBackup(r.path, r.signingKey, r.recovery))
    stdio.stdout.writeSync(`${l ? `  ${l}` : ""}\n`);
  return 0;
}

// ------------------------------------------------------------------ restore

/** `vault restore` without a ZIP: the steps (the command, and by hand); it changes nothing. */
export async function vaultRestore(): Promise<number> {
  const { repoSlug } = await import("../fleet/bootstrap.ts");
  stdio.stdout.writeSync(`${restoreText([], await repoSlug(P.repo))}\n`);
  return 0;
}

// ------------------------------------------------------------------ list

/** `vault list`: the backup ZIPs still in the backup folder (moved ones are wherever you put them). */
export async function vaultList(): Promise<number> {
  const list = await backupZips();
  stdio.stdout.writeSync(`${ui.dim(`backup folder: ${BACKUP_DIR}`)}\n`);
  if (!list.length) {
    stdio.stdout.writeSync(
      "no backup ZIPs here (moved, or none yet: bun run stolos vault backup)\n",
    );
  }
  for (const b of list) {
    stdio.stdout.writeSync(
      `${b.name}  ${b.files} files  ${(b.size / 1024).toFixed(1)} KB  ${fmtDate(b.created)}\n`,
    );
  }
  if (list.length)
    stdio.stdout.writeSync("Move them somewhere safe; once moved, they are not listed here.\n");
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
  const x = parseHostExport(r.stdout.trim().split("\n").pop() ?? "");
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
      `bun run stolos host add ${host} (registers a new one), then bun run stolos boot reinstall ${host}`,
    );
  }
  // This PC trusts the recovered host keys again (known_hosts), for every name it uses.
  const h = (await loadHosts().catch(() => [])).find((x) => x.name === host);
  await trustHost(host, [h?.ip, h?.dnsName].filter(Boolean) as string[]).catch(() => []);
  p.done(
    `${host}: ${x.hostKeys.length} host keys (${x.hostKeys.map((k) => k.type).join(", ")})${
      x.deployKey ? " and its deploy key" : ""
    } recovered; back them up: bun run stolos vault backup`,
  );
  return 0;
}

export { secretFor };
