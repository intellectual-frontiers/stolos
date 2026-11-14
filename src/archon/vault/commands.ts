/**
 * `deno task stolos vault <sub>` (specs 029 and 056): the boot machine's secrets,
 * and their backup. A backup is one ZIP file (see {@link writeBackupZip}),
 * written into stolos's backup folder; you then move it wherever you keep
 * important things safe. A restore is never done by a command: `vault restore`
 * prints what to do with the ZIP, by hand (constitution Articles 13 and 22).
 *
 * ```mermaid
 * flowchart LR
 *   status["vault status<br/>what changed since the last backup"] --> backup["vault backup<br/>a ZIP in the backup folder"]
 *   backup --> move["you move the ZIP<br/>somewhere safe"]
 *   move -. "after a disaster" .-> restore["vault restore<br/>prints the steps"]
 * ```
 *
 * @module
 */

import { run } from "../core/exec.ts";
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
  const rows = a.items.map((s) => [
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
  const last = c.state === "ok" ? `${fmtDate(a.lastBackup!.at)} (${a.lastBackup!.file})` : "none";
  console.log(`\nLast backup: ${last}`);
  if (c.where === "here") {
    console.log(
      ui.yellow(
        `  it is still in ${BACKUP_DIR}: move it somewhere safe (see: deno task stolos vault backup)`,
      ),
    );
  }
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

/** What to tell the person once the ZIP is written: where it is, and where to put it. */
export function afterBackup(path: string, signingKey?: string, recovery = false): string[] {
  const keys = signingKey && recovery
    ? "both signing keys (daily and recovery, each locked by its own passphrase)"
    : signingKey
    ? `your daily signing key (${signingKey}, locked by its passphrase)`
    : "";
  return [
    `Your backup is ${path}`,
    "",
    "It is everything a disaster needs: every secret of every fleet on this PC" +
    (keys ? `, and ${keys}` : "") + ".",
    "Move it wherever you keep important things safe and encrypted (your OneDrive",
    "Personal Vault, a password manager, an encrypted USB drive), and keep an older one",
    "too. The ZIP itself is not encrypted: anyone with it and your passphrases could",
    "change your servers, so treat it like the keys to them.",
    "",
    "To use it after a disaster: deno task stolos vault restore (it only explains;",
    "the same steps are RESTORE.txt in the ZIP).",
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
    p.fail((e as Error).message, "run deno task stolos vault backup again");
    return 1;
  }
  if (!r.signingKey) {
    p.warn(
      "no signing key in Git's settings (git config user.signingkey), so none is in the ZIP",
      "set up signing (the fleet repository's README), then back up again",
    );
  }
  await writePromptStatus(await assess());
  ui.panel = undefined;
  const n = r.manifest.files.length;
  p.done(
    `${n} file${n === 1 ? "" : "s"} (${
      r.fleets.join(", ") || "no fleet secrets yet"
    }), read back and checked`,
  );
  console.log("");
  if (r.movedRecoveryTo) {
    p.note(
      `the recovery key was moved into the key store (${r.movedRecoveryTo}): every backup holds it now`,
    );
  }
  for (const l of afterBackup(r.path, r.signingKey, r.recovery)) console.log(l ? `  ${l}` : "");
  return 0;
}

// ------------------------------------------------------------------ restore

/** `vault restore`: the steps to restore a backup ZIP by hand (it changes nothing). */
export function vaultRestore(): number {
  console.log(restoreText());
  return 0;
}

// ------------------------------------------------------------------ list

/** `vault list`: the backup ZIPs still in the backup folder (moved ones are wherever you put them). */
export async function vaultList(): Promise<number> {
  const list = await backupZips();
  console.log(ui.dim(`backup folder: ${BACKUP_DIR}`));
  if (!list.length) {
    console.log("no backup ZIPs here (moved, or none yet: deno task stolos vault backup)");
  }
  for (const b of list) {
    console.log(
      `${b.name}  ${b.files} files  ${(b.size / 1024).toFixed(1)} KB  ${fmtDate(b.created)}`,
    );
  }
  if (list.length) console.log("Move them somewhere safe; once moved, they are not listed here.");
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
      `deno task stolos host add ${host} (registers a new one), then deno task stolos boot reinstall ${host}`,
    );
  }
  // This PC trusts the recovered host keys again (known_hosts), for every name it uses.
  const h = (await loadHosts().catch(() => [])).find((x) => x.name === host);
  await trustHost(host, [h?.ip, h?.dnsName].filter(Boolean) as string[]).catch(() => []);
  p.done(
    `${host}: ${x.hostKeys.length} host keys (${x.hostKeys.map((k) => k.type).join(", ")})${
      x.deployKey ? " and its deploy key" : ""
    } recovered; back them up: deno task stolos vault backup`,
  );
  return 0;
}

export { secretFor };
