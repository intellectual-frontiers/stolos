/**
 * `deno task stolos boot reinstall <host>` (spec 004): one command from the boot
 * machine re-installs a running host, with no one at its console:
 *   1. the boot server must be running (it serves the install);
 *   2. (spec 048: the host keeps its own records; nothing is pushed);
 *   3. the host is armed for one install;
 *   4. over SSH, `archon reboot --netboot` boots it from the network once;
 *   5. this PC trusts the host's SSH host keys, which the install brings back.
 * A host that cannot be reached is armed anyway, with what to do at its console.
 * Article 23 (spec 044): a durable host (asked over SSH with `archon data`),
 * or one whose data class cannot be read, is reinstalled only with
 * --confirm-destroy <host>, typed by a person.
 *
 * @module
 */

import { ui } from "../archon/core/ui.ts";
import { armHost, loadTokens, readSecret, SECRETS, writeSecret } from "../archon/core/secrets.ts";
import { type AcmeCarry, deliverable, describeCarry } from "../archon/web/acme.ts";
import { loadFleet, loadServers } from "../archon/model/load.ts";
import { trustHost } from "../archon/install/host-keys.ts";
import { describeData, type HostData, hostData } from "../archon/model/durable.ts";
import type { HostDef } from "../archon/model/types.ts";

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** Extra options once a host turned out to still have an older install's host keys. */
let legacyKeys: string[] = [];

async function ssh(
  target: string,
  command: string,
  show: boolean,
): Promise<{ code: number; stderr: string }> {
  try {
    const r = await new Deno.Command("ssh", {
      args: [...SSH_OPTS, ...legacyKeys, target, command],
      stdin: "null",
      stdout: show ? "inherit" : "null",
      stderr: show ? "inherit" : "piped",
    }).output();
    return { code: r.code, stderr: show ? "" : new TextDecoder().decode(r.stderr) };
  } catch {
    return { code: 255, stderr: "" }; // no ssh client
  }
}

/** Run a command on the host over SSH and capture its stdout. */
async function sshOutput(
  target: string,
  command: string,
  anyExit = false,
): Promise<string | undefined> {
  try {
    const r = await new Deno.Command("ssh", {
      args: [...SSH_OPTS, ...legacyKeys, target, command],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return r.code === 0 || (anyExit && r.code !== 255)
      ? new TextDecoder().decode(r.stdout)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spec 032: copy the host's Let's Encrypt store to this PC before its disk is
 * erased, so the new install serves the same certificate at once. Returns the
 * sentence the log, the boot window, and the email use.
 */
async function carryCertificates(name: string, target: string): Promise<string> {
  const c = ui.phase("Certificate");
  const raw = await sshOutput(target, "archon web acme-export");
  let carry: AcmeCarry | undefined;
  try {
    carry = raw ? JSON.parse(raw.trim().split("\n").at(-1)!) as AcmeCarry : undefined;
  } catch {
    carry = undefined;
  }
  if (!carry) {
    const kept = await readSecret(SECRETS.acme(name));
    let prev: AcmeCarry | undefined;
    try {
      prev = kept ? JSON.parse(kept) as AcmeCarry : undefined;
    } catch {
      prev = undefined;
    }
    if (prev && deliverable(prev)) {
      const line =
        `Let's Encrypt certificate: could not read it from ${name}; the copy from the previous reinstall is reused (${
          describeCarry(prev)
        })`;
      c.warn(line, `ssh ${target} sudo archon web acme-export`);
      return line;
    }
    const line =
      `Let's Encrypt certificate: could not read it from ${name}; the new install asks Let's Encrypt for one (a minute or two of a self-signed certificate)`;
    c.warn(line, `ssh ${target} sudo archon web acme-export`);
    return line;
  }
  if (!carry.certificates.length) {
    const line =
      `Let's Encrypt certificate: ${name} has none yet; the new install asks Let's Encrypt for one`;
    c.done(line);
    return line;
  }
  await writeSecret(SECRETS.acme(name), JSON.stringify(carry, null, 2) + "\n");
  if (!deliverable(carry)) {
    const line = `Let's Encrypt certificate: ${
      describeCarry(carry)
    } expires within a day; the new install asks Let's Encrypt for a new one`;
    c.warn(line, `journalctl -u traefik on ${name} (why was it not renewed?)`);
    return line;
  }
  const line = `Let's Encrypt certificate carried over (${
    describeCarry(carry)
  }): the new install serves it from its first minute, with no new request to Let's Encrypt`;
  c.done(line);
  return line;
}

/** The MAC of a running host's default-route interface, over SSH. */
async function macOf(target: string): Promise<string | undefined> {
  try {
    const r = await new Deno.Command("ssh", {
      args: [
        ...SSH_OPTS,
        ...legacyKeys,
        target,
        "cat /sys/class/net/$(ip route show default | awk '{print $5; exit}')/address",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    const mac = new TextDecoder().decode(r.stdout).trim().toLowerCase();
    return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) ? mac : undefined;
  } catch {
    return undefined;
  }
}

/** What a host says of its data (archon data --json), or undefined when it cannot be read. */
export function parseData(
  raw: string | undefined,
): { class: string; reasons: string[] } | undefined {
  try {
    const j = JSON.parse(raw ?? "");
    if (j?.class === "durable" || j?.class === "ephemeral") {
      return { class: j.class, reasons: Array.isArray(j.reasons) ? j.reasons.map(String) : [] };
    }
  } catch { /* not JSON */ }
  return undefined;
}

/**
 * Article 23: refuse to erase a durable host (or one whose class is unknown)
 * unless a person repeated its name with --confirm-destroy. Returns the
 * refusal, or undefined when it may go ahead.
 */
export function destroyRefusal(
  name: string,
  data: { class: string; reasons: string[] } | undefined,
  confirm: string | undefined,
  agent = Deno.env.get("ARCHON_AGENT"),
): string | undefined {
  if (confirm !== undefined && agent) {
    return `--confirm-destroy is typed by a person, not an agent (${agent})`;
  }
  if (data?.class === "ephemeral") return undefined;
  if (confirm === name) return undefined;
  const why = data
    ? describeData({ class: "durable", reasons: data.reasons })
    : "of unknown data class (it could not be asked), so it counts as durable";
  return confirm === undefined
    ? `${name} is ${why}: its disk would be erased. Repeat its name with --confirm-destroy ${name} once its data is safe elsewhere`
    : `--confirm-destroy ${confirm} does not name ${name}`;
}

/** The class the repository's records give (no SSH): for arming a host that may not answer. */
export function recordedData(
  host: HostDef | undefined,
): Pick<HostData, "class" | "reasons"> | undefined {
  if (!host) return undefined;
  const d = hostData(host);
  return { class: d.class, reasons: d.reasons };
}

const KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/;

/**
 * `deno task stolos boot reinstall <host>`: re-install a running host over the
 * network in the steps the module describes. `port` is the boot server's HTTP
 * port and `confirmDestroy` is the repeated name a durable host needs. A host
 * that cannot be asked needs it too. Returns the exit code (2 for an
 * unknown host).
 */
export async function reinstall(
  name: string | undefined,
  o: { port: number; confirmDestroy?: string },
): Promise<number> {
  const hosts = await loadServers();
  if (!name || !hosts.some((h) => h.name === name)) {
    console.error(
      `usage: deno task stolos boot reinstall <host> [--confirm-destroy <host>]  (known: ${
        hosts.map((h) => h.name).join(", ") || "none"
      })`,
    );
    return 2;
  }
  ui.header("Archon reinstall", name);

  const b = ui.phase("Boot server");
  const up = await fetch(`http://127.0.0.1:${o.port}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok).catch(() => false);
  if (!up) {
    b.fail(
      `the boot server is not running on port ${o.port}`,
      "start it in another window: deno task stolos boot serve (leave it running), then run this again",
    );
    return ui.finish();
  }
  b.done(`running on port ${o.port}`);

  const fleet = await loadFleet();
  const known = (await loadTokens()).find((t) => t.host === name)?.addresses ?? [];
  const s = ui.phase("Reach");
  let target: string | undefined;
  for (const addr of [name, ...known]) {
    s.status(`ssh ${fleet.admin.user}@${addr}`);
    const t = `${fleet.admin.user}@${addr}`;
    let r = await ssh(t, "true", false);
    if (r.code !== 0 && KEY_CHANGED.test(r.stderr)) {
      // It still runs an install from before stable SSH identities: its keys
      // are not the ones this PC now trusts. This connection only pushes its
      // state and reboots it, and the re-install brings the real keys.
      legacyKeys = [
        "-o",
        `UserKnownHostsFile=${await Deno.makeTempFile({ prefix: "archon-known-hosts-" })}`,
        "-o",
        "StrictHostKeyChecking=accept-new",
      ];
      r = await ssh(t, "true", false);
      if (r.code === 0) {
        s.note(`${name} still has an older install's SSH host keys; the re-install replaces them`);
      }
    }
    if (r.code === 0) {
      target = t;
      break;
    }
    legacyKeys = [];
  }
  if (!target) {
    const refusal = destroyRefusal(name, undefined, o.confirmDestroy);
    if (refusal) {
      s.fail(
        refusal,
        `or reach it first (ssh ${fleet.admin.user}@${name}) so it can say whether it is durable`,
      );
      return ui.finish();
    }
    s.warn(
      `${name} does not answer over SSH (as ${fleet.admin.user}, at ${
        [name, ...known].join(", ")
      })`,
      `it is armed anyway: power it on and pick network boot once from its boot menu (F7 on an MS-01)`,
    );
    // Not reached: nothing proves which machine boots next, so its installer
    // keeps the blank-disk guard unless a person confirmed (spec 051).
    const t = await armHost(name, 0, undefined, { confirmDestroy: o.confirmDestroy === name });
    await trustHost(name, t.addresses ?? []);
    return ui.finish({ next: [`then watch the boot server window for ${name}`] });
  }
  s.done(target);

  const dp = ui.phase("Data");
  const data = parseData((await sshOutput(target, "archon data --json", true))?.trim());
  const refusal = destroyRefusal(name, data, o.confirmDestroy);
  if (refusal) {
    dp.fail(refusal, `ssh ${target} archon data (what it holds, and its backups)`);
    return ui.finish();
  }
  dp.done(
    data?.class === "ephemeral"
      ? `${name} is ephemeral: nothing on it holds end users' data that exists nowhere else`
      : `${name} is ${
        data ? describeData({ class: "durable", reasons: data.reasons }) : "of unknown data class"
      }: erasing it as confirmed (--confirm-destroy ${name})`,
  );

  // Spec 048: what the host recorded about itself stays on it and goes with
  // the re-install; nothing is pushed. Durable data is guarded above.
  const certificate = await carryCertificates(name, target);

  // Spec 025: the reinstall started (the host reports Ready when it is done).
  const { notify } = await import("../archon/notify/events.ts");
  await notify({
    event: `↻ reinstall of ${name} started`,
    level: "warn",
    what:
      `deno task stolos boot reinstall ${name}: its state was pushed, it is armed and rebooting from the network. Its disk is erased and Ubuntu installed again.\n\n${certificate}.`,
    todo: `Nothing, unless no "${name}: ✓ Ready" message follows within about 30 minutes.`,
    key: `reinstall:${name}:${new Date().toISOString().slice(0, 13)}`,
  });
  const a = ui.phase("Arm");
  // The MAC it network-boots from (its default route's interface), so the boot
  // server knows it even when this PC has no record of it (a rebuilt boot machine).
  const model = hosts.find((h) => h.name === name)!;
  const mac = model.mac ?? await macOf(target);
  const t = await armHost(name, 0, mac, { reinstall: !!mac });
  a.done(`${name} is armed for one install${mac ? ` (MAC ${mac})` : ""}`);

  const r = ui.phase("Reboot");
  const { announce } = await import("../archon/core/announce.ts");
  await announce({
    name: "boot.reboot",
    host: name,
    message:
      "rebooting from the network (boot reinstall); its install starts when it network-boots",
  }, o.port);
  await announce({ name: "boot.certificate", host: name, message: certificate }, o.port);
  ui.pause();
  const rebooted = (await ssh(target, "archon reboot --netboot", true)).code;
  ui.resume();
  // The install brings back its own SSH host keys: trust them from now on.
  const names = await trustHost(name, t.addresses ?? []);
  if (rebooted !== 0) {
    r.warn(
      `${name} could not be told to network-boot`,
      "reboot it and pick network boot once from its boot menu (F7 on an MS-01)",
    );
  } else r.done(`${name} reboots from the network now · this PC trusts ${names.join(", ")}`);
  return ui.finish({
    next: [
      `watch the boot server window: installer steps, first boot, then "${name}: ready. Next:" with how to reach and observe it`,
      "or later: deno task stolos fleet status",
    ],
  });
}
