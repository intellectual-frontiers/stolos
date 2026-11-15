/**
 * archon notify watch (spec 025, user story 2): the events an operator must
 * hear about even when nothing in Archon ran. It follows the journal (Ubuntu
 * already records every one of them: sshd, sudo, su, login, useradd, the kernel,
 * systemd) and turns the few that matter into messages; nothing is added to
 * sshd, PAM, or auditd (Article 2). Every ten minutes it also looks at what the
 * journal cannot say: disk space and the authorized_keys files.
 *
 * Signals, and how loud:
 *   ssh login            info, once per user, address, and method an hour; warn from
 *                        outside the local networks or from an address never seen for that user
 *   root login           fail (sshd forbids it; one means the configuration was changed)
 *   failed ssh logins    warn, one summary an hour (per address: count and users tried)
 *   console login, su    warn (someone at the keyboard or AMT; a root shell)
 *   sudo refused         fail (wrong passwords, not in sudoers)
 *   accounts changed     warn (useradd, usermod, groups, passwd outside archon apply)
 *   authorized_keys      warn when a file changes (which keys came and went)
 *   kernel               fail: out of memory kills, disk and filesystem errors, read-only
 *                        remounts, machine-check (hardware) errors
 *   a unit failed        warn, once per unit an hour (archon's own: apply reports those)
 *   booted               info, warn if the previous run did not shut down cleanly
 *   disk space           warn at 90% used, fail at 97%, once per mount a day
 *   mail bounced         warn: Postfix could not deliver (spec 027), once per recipient an hour
 *
 * @module
 */

import { absurd } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path as paths, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { run } from "../core/exec.ts";
import { loadFleet } from "../model/load.ts";
import { localNetworks } from "../capabilities/ssh.ts";
import type { Event } from "./notify.ts";
import { notify } from "./events.ts";

/** Where the watch keeps its state, and the systemd service that runs it. */
export const WATCH = {
  /** Its state file (root only): journal cursor, seen addresses, pending summaries. */
  state: "/var/lib/archon/status/watch.json",
  /** The service that runs `archon notify watch`. */
  unit: "archon-notify-watch.service",
};

/** One journal entry, as journalctl -o json prints it (only the fields used). */
export interface Entry {
  /** The message text, or its bytes when it is not valid UTF-8. */
  MESSAGE?: string | number[];
  /** The program that logged it (for example `sshd`, `sudo`, `postfix/smtp`). */
  SYSLOG_IDENTIFIER?: string;
  /** The process name: used when there is no SYSLOG_IDENTIFIER. */
  _COMM?: string;
  /** How it reached the journal (`kernel` for kernel messages). */
  _TRANSPORT?: string;
  /** The unit a systemd message is about (for example a failed service). */
  UNIT?: string;
  /** The unit of the process that logged it. */
  _SYSTEMD_UNIT?: string;
  /** When it was logged, microseconds since the epoch, as a string. */
  __REALTIME_TIMESTAMP?: string;
  /** Its position in the journal: the watch resumes after it. */
  __CURSOR?: string;
}

/**
 * A journal entry that matters, by kind: an ssh login, failed logins, a
 * console login, su, a refused sudo, an account change, a kernel error, a
 * failed unit, or bounced mail.
 */
export type Signal =
  | { kind: "login"; user: string; from: string; method: string; key?: string }
  | { kind: "login-failed"; user: string; from: string; invalidUser: boolean }
  | { kind: "console"; user: string; via: string }
  | { kind: "su"; user: string; by: string }
  | { kind: "sudo-refused"; user: string; detail: string }
  | { kind: "account"; detail: string }
  | { kind: "kernel"; what: string; detail: string }
  | { kind: "unit-failed"; unit: string; detail: string }
  | { kind: "mail-bounced"; to: string; detail: string };

const text = (m: Entry["MESSAGE"]): string =>
  typeof m === "string" ? m : Array.isArray(m) ? new TextDecoder().decode(new Uint8Array(m)) : "";

/** The journal entries that matter, as signals. Pure: tested without a journal. */
export function classify(e: Entry): Signal | undefined {
  const msg = text(e.MESSAGE);
  const id = e.SYSLOG_IDENTIFIER ?? e._COMM ?? "";
  if (/^sshd/.test(id)) {
    let m = msg.match(/^Accepted (\S+) for (\S+) from (\S+) port \d+(?: ssh2)?(?:: (.+))?$/);
    if (m)
      return {
        kind: "login",
        method: m[1] ?? "",
        user: m[2] ?? "",
        from: m[3] ?? "",
        ...(m[4] === undefined ? {} : { key: m[4] }),
      };
    m = msg.match(
      /^Failed (?:password|publickey|keyboard-interactive\/pam) for (invalid user )?(\S+) from (\S+) port/,
    );
    if (m) return { kind: "login-failed", invalidUser: !!m[1], user: m[2] ?? "", from: m[3] ?? "" };
    m = msg.match(/^Invalid user (\S*) from (\S+) port/);
    if (m)
      return { kind: "login-failed", invalidUser: true, user: m[1] || "(empty)", from: m[2] ?? "" };
    return undefined;
  }
  if (id === "sudo") {
    const m = msg.match(
      /^\s*(\S+) : (.*(?:incorrect password attempts?|user NOT in sudoers|command not allowed|NOT allowed).*)$/,
    );
    if (m) return { kind: "sudo-refused", user: m[1] ?? "", detail: m[2] ?? "" };
    return undefined;
  }
  if (id === "su") {
    let m = msg.match(/session opened for user (\S+?)(?:\(uid=\d+\))? by (\S+?)(?:\(uid=\d+\))?$/);
    if (m) return { kind: "su", user: m[1] ?? "", by: m[2] ?? "" };
    m = msg.match(/^FAILED (?:SU|su) \(to (\S+)\) (\S+)/);
    if (m) return { kind: "sudo-refused", user: m[2] ?? "", detail: `su to ${m[1] ?? ""} failed` };
    return undefined;
  }
  if (id === "login" || id === "agetty") {
    const m =
      msg.match(/session opened for user (\S+?)(?:\(uid=\d+\))?/) ??
      msg.match(/^ROOT LOGIN ON (\S+)/);
    if (m && /session opened/.test(msg)) {
      return { kind: "console", user: m[1] ?? "", via: "the console (keyboard, screen, or AMT)" };
    }
    if (m) return { kind: "console", user: "root", via: m[1] ?? "" };
    return undefined;
  }
  if (
    [
      "useradd",
      "userdel",
      "usermod",
      "groupadd",
      "groupdel",
      "gpasswd",
      "passwd",
      "chpasswd",
    ].includes(id)
  ) {
    if (
      /^(new user|new group|delete user|delete group|add '|delete '|change user|password changed|members of group|lock user|unlock user|failed)/i.test(
        msg,
      )
    ) {
      return { kind: "account", detail: `${id}: ${msg}` };
    }
    return undefined;
  }
  if (e._TRANSPORT === "kernel") {
    if (/Out of memory: Killed process|oom-kill:/.test(msg)) {
      return { kind: "kernel", what: "out of memory: a process was killed", detail: msg };
    }
    if (
      /I\/O error|critical medium error|Buffer I\/O error|EXT4-fs error|BTRFS (error|critical)|XFS .*(metadata I\/O error|Corruption)|nvme.*(timeout|reset controller)/i.test(
        msg,
      )
    ) {
      return { kind: "kernel", what: "disk or filesystem error", detail: msg };
    }
    if (/Remounting filesystem read-only|remounted read-only/i.test(msg)) {
      return { kind: "kernel", what: "a filesystem went read-only", detail: msg };
    }
    if (/Machine check events logged|Hardware Error|\[Hardware Error\]/i.test(msg)) {
      return { kind: "kernel", what: "hardware error (machine check)", detail: msg };
    }
    return undefined;
  }
  // Postfix (spec 027): mail the relay refused for good. Deferrals retry by themselves.
  if (id === "postfix/smtp" || id === "postfix/error") {
    const m = msg.match(/ to=<([^>]*)>.* status=bounced \((.*)\)$/);
    if (m) return { kind: "mail-bounced", to: m[1] ?? "", detail: m[2] ?? "" };
    return undefined;
  }
  if (id === "systemd") {
    const m = msg.match(/^(\S+\.(?:service|mount|socket)): Failed with result '([^']+)'/);
    if (!m) return undefined;
    const unit = e.UNIT ?? m[1] ?? "";
    if (/^archon-/.test(unit)) return undefined; // apply and the jobs report themselves
    return { kind: "unit-failed", unit, detail: msg };
  }
  return undefined;
}

// ---------------------------------------------------------------- addresses

function ipv4ToInt(ip: string): number | undefined {
  const p = ip.split(".").map(Number);
  const [a = -1, b = -1, c = -1, d = -1] = p;
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return undefined;
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** Is `ip` inside one of `cidrs`? (IPv4 exactly; IPv6 by its leading hex groups.) */
export function inNetworks(ip: string, cidrs: string[]): boolean {
  const v4 = ipv4ToInt(ip.replace(/^::ffff:/, ""));
  for (const c of cidrs) {
    const [net = "", bits = "32"] = c.split("/");
    const n4 = ipv4ToInt(net);
    if (v4 !== undefined && n4 !== undefined) {
      const b = Number(bits);
      const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
      if ((v4 & mask) >>> 0 === (n4 & mask) >>> 0) return true;
    } else if (v4 === undefined && n4 === undefined) {
      const lower = ip.toLowerCase();
      if (net === "fc00::" && /^f[cd]/.test(lower)) return true;
      if (net === "fe80::" && /^fe[89ab]/.test(lower)) return true;
      if (lower === net.toLowerCase()) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- state

/** What the watch remembers between runs (WATCH.state). */
export interface WatchState {
  /** The journal cursor of the last entry read; unset at first (it starts from now). */
  cursor?: string;
  /** The boot id last seen, so each boot is reported once. */
  bootId?: string;
  /** user -> addresses that user has logged in from. */
  seen: Record<string, string[]>;
  /** Failed logins not yet reported: address -> { count, users }. */
  failed: Record<string, { count: number; users: string[]; first: string; last: string }>;
  /** When failed logins were last summarized (ISO 8601): at most one summary an hour. */
  failedReportedAt?: string;
  /** authorized_keys path -> its lines' fingerprints. */
  keys: Record<string, string[]>;
  /** mount -> the date it was last reported. */
  disk: Record<string, string>;
}

/** Read the watch state; empty (nothing seen) when missing or not JSON. */
export async function readWatch(path = WATCH.state): Promise<WatchState> {
  try {
    return {
      seen: {},
      failed: {},
      keys: {},
      disk: {},
      ...(JSON.parse((await fs.readTextOr(path)) ?? "{}") as Partial<WatchState>),
    };
  } catch {
    return { seen: {}, failed: {}, keys: {}, disk: {} };
  }
}

async function writeWatch(s: WatchState, path = WATCH.state) {
  await fs.writeTextFile(path, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 }).catch(() => {});
}

// ---------------------------------------------------------------- messages

const hour = (d = new Date()) => d.toISOString().slice(0, 13);

async function reverse(ip: string): Promise<string> {
  const r = await run(["getent", "hosts", ip]);
  const name = r.ok ? r.stdout.trim().split(/\s+/)[1] : undefined;
  return name ? `${ip} (${name})` : ip;
}

/** The message for one signal, or undefined (failed logins are summarized by tick). */
export function eventFor(
  sig: Signal,
  ctx: {
    host: string;
    local: string[];
    seen: Record<string, string[]>;
    keyNames: Record<string, string>;
    fromName?: string | undefined;
  },
): Event | undefined {
  const h = ctx.host;
  switch (sig.kind) {
    case "login": {
      const local = inNetworks(sig.from, ctx.local);
      const first = !(ctx.seen[sig.user] ?? []).includes(sig.from);
      const fp = sig.key?.match(/SHA256:\S+/)?.[0];
      const keyName = fp ? ctx.keyNames[fp] : undefined;
      if (sig.user === "root") {
        return {
          event: `✗ root logged in over SSH from ${sig.from}`,
          level: "fail",
          what: `root logged in to ${h} from ${
            ctx.fromName ?? sig.from
          } with ${sig.method}. sshd is configured with PermitRootLogin no, so its configuration was changed.`,
          todo: `If this was not you: disconnect the host from the network (or power it off), then re-install it (bun run stolos boot reinstall ${h}). archon verify shows the sshd drift.`,
          key: `login:root:${sig.from}:${hour()}`,
        };
      }
      const level = !local || first ? "warn" : "info";
      return {
        event: `${level === "warn" ? "⚠ " : ""}${sig.user} logged in from ${sig.from}${
          !local ? " (outside the local networks)" : first ? " (a new address)" : ""
        }`,
        level,
        what: [
          `${sig.user} logged in to ${h} over SSH.`,
          `From:   ${ctx.fromName ?? sig.from}${
            local ? " (a local network)" : " (NOT a local network)"
          }`,
          `Method: ${sig.method}${
            sig.key ? `, key ${sig.key}${keyName ? ` (${keyName})` : ""}` : ""
          }`,
          first
            ? `This is the first login for ${sig.user} from this address that ${h} has seen.`
            : "",
          `Logins by the same user from the same address and method are reported once an hour.`,
        ]
          .filter(Boolean)
          .join("\n"),
        todo:
          level === "warn"
            ? `If this was not you or someone you expect: on ${h}, who and last -a show the sessions; sudo loginctl terminate-user ${sig.user} ends them; then change the password and check ~${sig.user}/.ssh/authorized_keys.`
            : undefined,
        key: `login:${sig.user}:${sig.from}:${sig.method}:${hour()}`,
      };
    }
    case "console":
      return {
        event: `⚠ ${sig.user} logged in at ${
          sig.via === "the console (keyboard, screen, or AMT)" ? "the console" : sig.via
        }`,
        level: "warn",
        what: `${sig.user} logged in to ${h} on ${sig.via}, not over SSH.`,
        todo: `If nobody should be at ${h}'s console, check AMT's session log and the machine's physical access.`,
        key: `console:${sig.user}:${hour()}`,
      };
    case "su":
      return {
        event: `⚠ su: ${sig.by} became ${sig.user}`,
        level: "warn",
        what: `${sig.by} opened a shell as ${sig.user} with su on ${h}. Archon itself uses sudo, never su.`,
        key: `su:${sig.by}:${sig.user}:${hour()}`,
      };
    case "sudo-refused":
      return {
        event: `✗ refused: ${sig.user} tried to gain privileges`,
        level: "fail",
        what: `On ${h}: ${sig.user}: ${sig.detail}`,
        todo: `If this was not you mistyping a password, someone has ${sig.user}'s session: who, last -a, and journalctl -t sudo on ${h}.`,
        key: `sudo:${sig.user}:${hour()}`,
      };
    case "account":
      return {
        event: "⚠ accounts changed",
        level: "warn",
        what: `On ${h}: ${sig.detail}\nArchon's own apply makes such changes when the model changes; anything else is a change outside the spec loop.`,
        todo: `archon apply --check on ${h} shows any difference from the model.`,
        key: `account:${sig.detail}`,
      };
    case "kernel":
      return {
        event: `✗ ${sig.what}`,
        level: "fail",
        what: `The kernel on ${h} reported: ${sig.detail}`,
        todo: sig.what.startsWith("out of memory")
          ? `journalctl -k -b on ${h} shows what was killed; btop shows what uses the memory now.`
          : `journalctl -k -b on ${h} shows the context; sudo smartctl -a /dev/<disk> (smartmontools) shows the disk's health. Make sure the newest backup restores: archon backup verify.`,
        key: `kernel:${sig.what}:${hour()}`,
      };
    case "unit-failed":
      return {
        event: `⚠ ${sig.unit} failed`,
        level: "warn",
        what: `On ${h}: ${sig.detail}`,
        todo: `systemctl status ${sig.unit} and journalctl -u ${sig.unit} -b on ${h}.`,
        key: `unit:${sig.unit}:${hour()}`,
      };
    case "mail-bounced":
      return {
        event: `⚠ mail to ${sig.to} bounced`,
        level: "warn",
        what: `Postfix on ${h} could not deliver a message to ${sig.to}: ${sig.detail}`,
        todo: `journalctl -t postfix/smtp on ${h}; archon doctor (Email) checks the relay, the token, and the domain's records.`,
        key: `bounce:${sig.to}:${hour()}`,
      };
    case "login-failed":
      // Counted as they come, and reported once an hour (failedSummary).
      return undefined;
    default:
      return absurd(sig);
  }
}

/** The hourly summary of failed SSH logins. */
export function failedSummary(
  host: string,
  failed: WatchState["failed"],
  local: string[],
): Event | undefined {
  const rows = Object.entries(failed).sort((a, b) => b[1].count - a[1].count);
  if (!rows.length) return undefined;
  const total = rows.reduce((n, [, f]) => n + f.count, 0);
  const outside = rows.filter(([ip]) => !inNetworks(ip, local)).length;
  return {
    event: `⚠ ${total} failed SSH login${total === 1 ? "" : "s"} from ${rows.length} address${
      rows.length === 1 ? "" : "es"
    }`,
    level: "warn",
    what: [
      `Failed SSH logins on ${host} since the last report:`,
      ...rows
        .slice(0, 30)
        .map(
          ([ip, f]) =>
            `- ${ip}${inNetworks(ip, local) ? " (local)" : ""}: ${f.count} attempt${
              f.count === 1 ? "" : "s"
            }, users ${f.users.slice(0, 8).join(", ")}${f.users.length > 8 ? ", ..." : ""} (${f.first.slice(
              11,
              16,
            )} to ${f.last.slice(11, 16)} UTC)`,
        ),
      outside
        ? `${outside} of the addresses are outside the local networks: is SSH reachable from the internet? It should not be.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    todo: `Keys only from outside the local networks, and root never logs in, so guessing cannot succeed; still, find out where the attempts come from. journalctl -t sshd-session -t sshd on ${host}.`,
    key: `ssh-failed:${hour()}`,
  };
}

// ---------------------------------------------------------------- periodic

/** Fingerprints (SHA256:...) and comments of an authorized_keys file. */
async function fingerprints(path: string): Promise<Array<{ fp: string; name: string }>> {
  const r = await run(["ssh-keygen", "-lf", path]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [, fp = "", ...rest] = l.split(" ");
      return { fp, name: rest.join(" ").replace(/\s*\([A-Z0-9-]+\)$/, "") };
    });
}

async function authorizedKeyFiles(): Promise<string[]> {
  const out: string[] = [];
  const passwd = (await fs.readTextOr("/etc/passwd")) ?? "";
  for (const l of passwd.split("\n")) {
    const f = l.split(":");
    const home = f[5];
    if (f.length < 7 || home === undefined) continue;
    for (const name of ["authorized_keys", "authorized_keys2"]) {
      const p = paths.join(home, ".ssh", name);
      if (
        await fs
          .stat(p)
          .then(() => true)
          .catch(() => false)
      )
        out.push(p);
    }
  }
  return [...new Set(out)];
}

/** Keys: report files whose keys changed; return fingerprint -> name for login messages. */
async function checkKeys(host: string, s: WatchState): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const now: Record<string, string[]> = {};
  for (const p of await authorizedKeyFiles()) {
    const fps = await fingerprints(p);
    for (const k of fps) names[k.fp] = k.name;
    now[p] = fps.map((k) => `${k.fp} ${k.name}`);
  }
  const first = !Object.keys(s.keys).length;
  for (const p of new Set([...Object.keys(now), ...Object.keys(s.keys)])) {
    const before = s.keys[p] ?? [];
    const after = now[p] ?? [];
    const added = after.filter((k) => !before.includes(k));
    const removed = before.filter((k) => !after.includes(k));
    if (first || (!added.length && !removed.length)) continue;
    await notify({
      event: `⚠ SSH keys changed: ${p}`,
      level: "warn",
      what: [
        `The keys that may log in through ${p} on ${host} changed.`,
        ...added.map((k) => `+ ${k}`),
        ...removed.map((k) => `- ${k}`),
        `archon apply writes these files from the model (admin keys from GitHub); a change nobody made there is a way back in.`,
      ].join("\n"),
      todo: `If you did not change the model or your GitHub keys: archon apply on ${host} restores the file; then find out who changed it (journalctl around that time).`,
      key: `keys:${p}:${added.concat(removed).join(",")}`,
    });
  }
  s.keys = now;
  return names;
}

async function checkDisk(host: string, s: WatchState): Promise<void> {
  const r = await run([
    "df",
    "-P",
    "-x",
    "tmpfs",
    "-x",
    "devtmpfs",
    "-x",
    "squashfs",
    "-x",
    "overlay",
    "-x",
    "efivarfs",
  ]);
  if (!r.ok) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const l of r.stdout.split("\n").slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const pct = Number((f[4] ?? "").replace("%", ""));
    const mount = f.slice(5).join(" ");
    if (pct < 90 || s.disk[mount] === today) continue;
    s.disk[mount] = today;
    await notify({
      event: `${pct >= 97 ? "✗" : "⚠"} ${mount} is ${pct}% full`,
      level: pct >= 97 ? "fail" : "warn",
      what: `${mount} on ${host} (${f[0]}) is ${pct}% full: ${Math.round(
        Number(f[3]) / 1024,
      )} MB free.`,
      todo: `sudo du -xh --max-depth=2 ${mount} | sort -h | tail on ${host}; archon observe prune frees metric archives; old backups are in /var/backups/archon.`,
      key: `disk:${mount}:${today}`,
    });
  }
}

/** Booted: once per boot, and whether the previous one ended cleanly. */
async function checkBoot(host: string, s: WatchState): Promise<void> {
  const bootId = (await fs.readTextOr("/proc/sys/kernel/random/boot_id"))?.trim();
  if (!bootId || s.bootId === bootId) return;
  const firstEver = s.bootId === undefined;
  s.bootId = bootId;
  if (firstEver) return;
  const prev = await run(["journalctl", "-b", "-1", "-n", "60", "-o", "cat", "--no-pager"]);
  const clean =
    prev.ok &&
    /Reached target (System )?(Power-Off|Reboot|Shutdown|.*Final Step)|systemd-shutdown|Journal stopped/i.test(
      prev.stdout,
    );
  const known = prev.ok;
  const up = (await fs.readTextOr("/proc/uptime"))?.split(" ")[0];
  await notify({
    event: known && !clean ? "⚠ booted after an unclean shutdown" : "booted",
    level: known && !clean ? "warn" : "info",
    what: [
      `${host} started ${up ? `${Math.round(Number(up) / 60)} minutes ago` : "just now"}.`,
      !known
        ? "The previous boot's journal is not available, so whether it shut down cleanly is unknown."
        : clean
          ? "The previous boot shut down cleanly (a reboot or power-off that someone or something asked for)."
          : "The previous boot did not shut down cleanly: a power loss, a hang, a kernel crash, or a hard reset.",
    ].join("\n"),
    todo:
      known && !clean
        ? `journalctl -b -1 -e on ${host} shows how the previous boot ended.`
        : undefined,
    key: `boot:${bootId}`,
  });
}

// ---------------------------------------------------------------- the loop

/** Is archon converging this host right now (its account changes are the model's)? */
async function archonConverging(): Promise<boolean> {
  const r = await run(["pgrep", "-af", "archon"]);
  return r.ok && /archon(\S*)? (apply|update|reconcile|first-boot)\b/.test(r.stdout);
}

/**
 * archon notify watch (the watch service): check keys, boot and disk, then
 * follow the journal and send a message for each signal that matters. Every
 * ten minutes it checks keys and disk again and summarizes failed logins (at
 * most one summary an hour); it exits 0 to restart on a new checkout. Returns
 * 1 if journalctl ends, so systemd restarts it.
 */
export async function watch(hostName: string): Promise<number> {
  const fleet = await loadFleet();
  const local = localNetworks(fleet);
  const s = await readWatch();
  let keyNames = await checkKeys(hostName, s);
  await checkBoot(hostName, s);
  await checkDisk(hostName, s);
  await writeWatch(s);

  let dirty = false;
  const rev = async (): Promise<string> =>
    (await run(["git", "-C", "/srv/archon", "rev-parse", "HEAD"])).stdout.trim();
  const startedAt = await rev();
  const tick = setInterval(
    () =>
      void (async (): Promise<void> => {
        try {
          // A new checkout (archon update, reconcile): restart on the new code.
          if ((await rev()) !== startedAt) {
            await writeWatch(s);
            proc.exit(0);
          }
          keyNames = await checkKeys(hostName, s);
          await checkDisk(hostName, s);
          const last = s.failedReportedAt ? Date.parse(s.failedReportedAt) : 0;
          if (Object.keys(s.failed).length && Date.now() - last >= 3600_000) {
            const ev = failedSummary(hostName, s.failed, local);
            if (ev) await notify(ev);
            s.failed = {};
            s.failedReportedAt = new Date().toISOString();
          }
          await writeWatch(s);
          dirty = false;
        } catch {
          /* the next tick tries again */
        }
      })(),
    600_000,
  );

  const args = ["-f", "-o", "json", "--no-pager"];
  args.push(...(s.cursor ? [`--after-cursor=${s.cursor}`] : ["--since=now"]));
  const child = proc.spawn(["journalctl", ...args], {
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  });
  if (!child.stdout) throw new Error("journalctl's output was not piped");
  const saver = setInterval(() => {
    if (dirty) void writeWatch(s).then(() => (dirty = false));
  }, 30_000);
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of child.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      if (e.__CURSOR) s.cursor = e.__CURSOR;
      dirty = true;
      const sig = classify(e);
      if (!sig) continue;
      if (sig.kind === "login-failed") {
        const at = new Date(
          Number(e.__REALTIME_TIMESTAMP ?? Date.now() * 1000) / 1000,
        ).toISOString();
        const f = (s.failed[sig.from] ??= { count: 0, users: [], first: at, last: at });
        f.count++;
        f.last = at;
        if (!f.users.includes(sig.user)) f.users.push(sig.user);
        continue;
      }
      const ev = eventFor(sig, {
        host: hostName,
        local,
        seen: s.seen,
        keyNames,
        fromName: "from" in sig ? await reverse(sig.from) : undefined,
      });
      if (sig.kind === "login") {
        const list = (s.seen[sig.user] ??= []);
        if (!list.includes(sig.from)) list.push(sig.from);
        if (list.length > 50) list.shift();
      }
      // Accounts changed by archon itself (apply, update, reconcile, first boot) follow the model.
      if (sig.kind === "account" && (await archonConverging())) continue;
      if (ev) await notify(ev);
    }
  }
  clearInterval(tick);
  clearInterval(saver);
  await writeWatch(s);
  // journalctl ended (it should not): exit non-zero so systemd restarts the watch.
  return 1;
}
