/**
 * Spec 095-proposals: the collectors' parsers. Each reads one source's own
 * output, exactly as the tool writes it (journald's JSON, apt's history.log,
 * dpkg.log, etckeeper's git log, osquery's JSON, `systemctl list-unit-files`,
 * `snap changes`, `dpkg -S`, `debsums -c` or `dpkg --verify`), and returns
 * observations: what changed, who changed it, when, and where it was seen.
 * Pure functions, so each is tested on fixtures (`tests/proposals095_test.ts`).
 *
 * @module
 */

import { redact } from "../notify/redact.ts";
import type { Alert, Observation, SubjectKind } from "./types.ts";

/** A short stable id for an observation: the same evidence collected twice is one record. */
export async function obsId(...parts: string[]): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A local "YYYY-MM-DD HH:MM:SS" (apt, dpkg) as ISO time, read in this machine's time zone. */
export function localTime(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(s.trim());
  if (!m) return new Date(0).toISOString();
  return new Date(`${m[1]}T${m[2]}`).toISOString();
}

/** An Archon run under sudo (archon's own commands are not hand changes). */
export function isArchonCommand(cmd: string): boolean {
  const bin = cmd.trim().split(/\s+/)[0] ?? "";
  return /(^|\/)(archon|stolos)$/.test(bin) || /\/srv\/archon\//.test(bin);
}

/** One `sudo` command from journald. */
export interface SudoEntry {
  /** Who ran it. */
  who: string;
  /** When (ISO). */
  at: string;
  /** The command, as sudo logged it. */
  command: string;
  /** As whom it ran (USER=). */
  as: string;
  /** Its working directory (PWD=). */
  pwd: string;
}

/**
 * sudo's journal entries (`journalctl -o json SYSLOG_IDENTIFIER=sudo`): one JSON
 * object per line, MESSAGE `alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ;
 * COMMAND=/usr/bin/apt install nginx`. Refused attempts and PAM's session lines
 * are not commands that ran; archon's own runs are left out.
 */
export function parseSudoJournal(text: string): SudoEntry[] {
  const out: SudoEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = typeof j.MESSAGE === "string" ? j.MESSAGE : "";
    const m = /^\s*(\S+) : (.*)$/.exec(msg);
    if (
      !m ||
      /incorrect password|command not allowed|NOT in sudoers|a password is required/i.test(msg)
    ) {
      continue;
    }
    const fields: Record<string, string> = {};
    for (const part of m[2].split(" ; ")) {
      const i = part.indexOf("=");
      if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1);
    }
    const command = fields.COMMAND;
    if (!command || isArchonCommand(command)) continue;
    const us = Number(j.__REALTIME_TIMESTAMP ?? 0) / 1000;
    out.push({
      who: m[1],
      at: iso(us || Date.now()),
      command,
      as: fields.USER ?? "root",
      pwd: fields.PWD ?? "",
    });
  }
  return out;
}

/** What a sudo command touches that a drift item can be matched with: packages, units, paths. */
export function commandTargets(command: string): Array<{ kind: SubjectKind; name: string }> {
  const words = command.trim().split(/\s+/);
  const bin = (words[0] ?? "").split("/").pop() ?? "";
  const args = words.slice(1).filter((w) => !w.startsWith("-"));
  const out: Array<{ kind: SubjectKind; name: string }> = [];
  if (
    /^(apt|apt-get|aptitude)$/.test(bin) && /^(install|reinstall|remove|purge)$/.test(args[0] ?? "")
  ) {
    for (const p of args.slice(1)) out.push({ kind: "package", name: p.replace(/[:=].*$/, "") });
  }
  if (bin === "snap" && /^(install|remove)$/.test(args[0] ?? "")) {
    for (const p of args.slice(1)) out.push({ kind: "snap", name: p });
  }
  if (
    bin === "systemctl" &&
    /^(enable|disable|mask|unmask|start|stop|restart|reload|edit)$/.test(args[0] ?? "")
  ) {
    for (const u of args.slice(1)) {
      out.push({ kind: "unit", name: u.includes(".") ? u : `${u}.service` });
    }
  }
  if (bin === "ufw" || bin === "nft" || bin === "iptables") out.push({ kind: "port", name: "*" });
  if (/^(useradd|adduser|usermod|userdel|deluser)$/.test(bin) && args.length) {
    out.push({ kind: "user", name: args[args.length - 1] });
  }
  if (bin === "visudo") out.push({ kind: "sudoer", name: "*" });
  if (/^(modprobe|insmod|rmmod)$/.test(bin) && args[0]) {
    out.push({ kind: "module", name: args[0] });
  }
  for (const w of words.slice(1)) {
    if (w.startsWith("/")) {
      out.push({
        kind: w.startsWith("/usr/local/") || w.startsWith("/opt/") ? "unowned" : "file",
        name: w,
      });
    }
  }
  if (bin === "sudoedit" || bin === "tee") {
    for (const p of args.filter((a) => a.startsWith("/"))) out.push({ kind: "file", name: p });
  }
  return out;
}

/** sudo entries as observations (`command` subjects: who, when, and exactly what was typed). */
export async function sudoObservations(entries: SudoEntry[]): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const e of entries) {
    out.push({
      id: await obsId("sudo", e.who, e.at, e.command),
      source: "sudo",
      at: e.at,
      who: e.who,
      kind: "command",
      name: redact(e.command),
      change: "ran",
      what: `${e.who} ran under sudo: ${redact(e.command)}`,
      evidence: redact(`${e.who} : PWD=${e.pwd} ; USER=${e.as} ; COMMAND=${e.command}`),
    });
  }
  return out;
}

const PKG = /([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9]+)? \(([^)]*)\)/g;

/**
 * apt's `/var/log/apt/history.log`: blocks of Start-Date, Commandline,
 * Requested-By (the person behind sudo), Install, Remove, Purge, End-Date.
 * Upgrades are Ubuntu's (unattended-upgrades) and never drift; packages apt
 * pulled in by itself (automatic) are left out.
 */
export async function parseAptHistory(text: string): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const f: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf(": ");
      if (i > 0) f[line.slice(0, i).trim()] = line.slice(i + 2).trim();
    }
    if (!f["Start-Date"]) continue;
    const at = localTime(f["Start-Date"]);
    const who = f["Requested-By"]?.split(/\s+/)[0];
    const cmd = f.Commandline ?? "";
    if (/unattended-upgrade/.test(cmd)) continue;
    for (
      const [field, change] of [["Install", "installed"], ["Remove", "removed"], [
        "Purge",
        "purged",
      ]]
    ) {
      for (const m of (f[field] ?? "").matchAll(PKG)) {
        if (m[2].includes("automatic")) continue;
        out.push({
          id: await obsId("apt", at, field, m[1]),
          source: "apt",
          at,
          ...(who ? { who } : {}),
          kind: "package",
          name: m[1],
          change,
          what: `${m[1]} ${change}${who ? ` by ${who}` : ""}${cmd ? ` (${redact(cmd)})` : ""}`,
          evidence: redact(
            [
              `Start-Date: ${f["Start-Date"]}`,
              cmd && `Commandline: ${cmd}`,
              who && `Requested-By: ${f["Requested-By"]}`,
              `${field}: ${m[0]}`,
            ]
              .filter(Boolean).join("\n"),
          ),
        });
      }
    }
  }
  return out;
}

/**
 * `/var/log/dpkg.log` lines (`2026-11-14 10:02:13 install nginx:amd64 <none>
 * 1.26.0`): installs and removals. Only those apt's history does not explain
 * are kept (a `dpkg -i` of a downloaded .deb); `aptAt` is apt's install times.
 */
export async function parseDpkgLog(
  text: string,
  apt: Observation[] = [],
): Promise<Observation[]> {
  const known = new Set(
    apt.map((o) => `${o.name}:${o.change === "installed" ? "install" : "remove"}`),
  );
  const out: Observation[] = [];
  for (const line of text.split("\n")) {
    const m =
      /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (install|remove|purge) ([^:\s]+)(?::\S+)? (\S+) (\S+)/
        .exec(line);
    if (!m) continue;
    const kind = m[2] === "install" ? "install" : "remove";
    if (known.has(`${m[3]}:${kind}`)) continue;
    const at = localTime(m[1]);
    out.push({
      id: await obsId("dpkg", m[1], m[2], m[3]),
      source: "dpkg",
      at,
      kind: "package",
      name: m[3],
      change: m[2] === "install" ? "installed" : m[2] === "remove" ? "removed" : "purged",
      what: `${m[3]} ${
        m[2] === "install" ? "installed" : "removed"
      } with dpkg directly (not through apt)`,
      evidence: line.trim(),
    });
  }
  return out;
}

/** One etckeeper commit: who, when, its message, and the files it changed. */
export interface EtcCommit {
  /** The commit. */
  hash: string;
  /** Its author (etckeeper writes the person behind sudo). */
  author: string;
  /** When (ISO). */
  at: string;
  /** Its subject. */
  subject: string;
  /** Changed files, as absolute paths, with git's status letter. */
  files: Array<{ status: string; path: string }>;
}

/**
 * etckeeper's history (`git -C /etc log --format=%x1e%H%x1f%an%x1f%aI%x1f%s
 * --name-status`). Archon's own commits (`archon apply: ...`) are left out.
 */
export function parseEtckeeperLog(text: string): EtcCommit[] {
  const out: EtcCommit[] = [];
  for (const rec of text.split("\x1e")) {
    if (!rec.trim()) continue;
    const [head, ...rest] = rec.split("\n");
    const [hash, author, at, subject] = head.split("\x1f");
    if (!hash || !at) continue;
    if (/^archon apply\b/.test(subject ?? "")) continue;
    const files = rest.map((l) => /^([AMDRT])\d*\t(?:[^\t]+\t)?(.+)$/.exec(l.trim())).filter((
      m,
    ): m is RegExpExecArray => !!m).map((m) => ({ status: m[1], path: `/etc/${m[2]}` }));
    out.push({
      hash,
      author: author ?? "",
      at: new Date(at).toISOString(),
      subject: subject ?? "",
      files,
    });
  }
  return out;
}

/** Commits made for Ubuntu (unattended upgrades, apt run by root on its own), not by a person. */
export function isUbuntuCommit(c: EtcCommit): boolean {
  return c.author === "root" && !/^daily autocommit/.test(c.subject) &&
    /committing changes in \/etc (made by|after) /.test(c.subject);
}

/** etckeeper commits as file observations (who is the commit's author unless it is root). */
export async function etckeeperObservations(commits: EtcCommit[]): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const c of commits) {
    if (isUbuntuCommit(c)) continue;
    for (const f of c.files) {
      if (f.path.startsWith("/etc/.etckeeper") || f.path === "/etc/.gitignore") continue;
      const change = f.status === "A" ? "added" : f.status === "D" ? "deleted" : "edited";
      out.push({
        id: await obsId("etckeeper", c.hash, f.path),
        source: "etckeeper",
        at: c.at,
        ...(c.author && c.author !== "root" ? { who: c.author } : {}),
        kind: "file",
        name: f.path,
        change,
        what: `${f.path} ${change}${c.author && c.author !== "root" ? ` by ${c.author}` : ""}`,
        evidence: redact(`etckeeper ${c.hash.slice(0, 10)} ${c.author}: ${c.subject}`),
      });
    }
  }
  return out;
}

/** What osquery saw at one time: the tables a proposal compares between snapshots. */
export interface OsquerySnapshot {
  /** When (ISO). */
  at: string;
  /** deb_packages: name to version. */
  packages: Record<string, string>;
  /** users: name to "uid shell". */
  users: Record<string, string>;
  /** sudoers: "source: header rule_details" lines. */
  sudoers: string[];
  /** listening_ports: "tcp/443" (not loopback). */
  ports: string[];
  /** kernel_modules: names. */
  modules: string[];
}

/** The queries for a snapshot (all on `archon query`'s allowlist). */
export const OSQUERY_SQL = {
  packages: "SELECT name, version FROM deb_packages",
  users: "SELECT username, uid, shell FROM users",
  sudoers: "SELECT source, header, rule_details FROM sudoers",
  ports:
    "SELECT DISTINCT port, protocol, address FROM listening_ports WHERE port > 0 AND address NOT LIKE '127.%' AND address != '::1'",
  modules: "SELECT name FROM kernel_modules",
};

/** A snapshot from osquery's JSON rows, one array per query in {@link OSQUERY_SQL}. */
export function osquerySnapshot(
  rows: Record<keyof typeof OSQUERY_SQL, Array<Record<string, string>>>,
  at: string,
): OsquerySnapshot {
  const proto = (p: string) => p === "17" ? "udp" : p === "6" ? "tcp" : p;
  return {
    at,
    packages: Object.fromEntries(rows.packages.map((r) => [r.name, r.version])),
    users: Object.fromEntries(rows.users.map((r) => [r.username, `${r.uid} ${r.shell}`])),
    sudoers: rows.sudoers.map((r) => `${r.source}: ${r.header} ${r.rule_details}`.trim()).sort(),
    ports: [...new Set(rows.ports.map((r) => `${proto(String(r.protocol))}/${r.port}`))].sort(),
    modules: rows.modules.map((r) => r.name).sort(),
  };
}

/** What changed between two osquery snapshots: what nothing logged. */
export async function osqueryDiff(
  before: OsquerySnapshot,
  after: OsquerySnapshot,
): Promise<Observation[]> {
  const out: Observation[] = [];
  const add = async (kind: SubjectKind, name: string, change: string, evidence: string) =>
    out.push({
      id: await obsId("osquery", after.at, kind, name, change),
      source: "osquery",
      at: after.at,
      kind,
      name,
      change,
      what: `${kind} ${name} ${change} (osquery, between ${before.at.slice(0, 16)} and ${
        after.at.slice(0, 16)
      })`,
      evidence: redact(evidence),
    });
  const sets = (a: string[], b: string[]) => {
    const sa = new Set(a), sb = new Set(b);
    return { added: b.filter((x) => !sa.has(x)), removed: a.filter((x) => !sb.has(x)) };
  };
  const pk = sets(Object.keys(before.packages), Object.keys(after.packages));
  for (const p of pk.added) {
    await add("package", p, "installed", `deb_packages: ${p} ${after.packages[p]}`);
  }
  for (const p of pk.removed) await add("package", p, "removed", `deb_packages: ${p} gone`);
  const us = sets(Object.keys(before.users), Object.keys(after.users));
  for (const u of us.added) await add("user", u, "added", `users: ${u} ${after.users[u]}`);
  for (const u of us.removed) await add("user", u, "removed", `users: ${u} gone`);
  const su = sets(before.sudoers, after.sudoers);
  for (const s of su.added) await add("sudoer", s, "added", `sudoers: ${s}`);
  for (const s of su.removed) await add("sudoer", s, "removed", `sudoers: ${s}`);
  const po = sets(before.ports, after.ports);
  for (const p of po.added) await add("port", p, "listening", `listening_ports: ${p}`);
  const mo = sets(before.modules, after.modules);
  for (const m of mo.added) await add("module", m, "loaded", `kernel_modules: ${m}`);
  return out;
}

/** A unit file's state and its vendor preset (what the package asked for). */
export interface UnitFileState {
  /** enabled, disabled, masked, static, ... */
  state: string;
  /** The preset: enabled, disabled, or empty. */
  preset: string;
}

/** `systemctl list-unit-files --no-legend --plain`: each unit's state and vendor preset. */
export function parseUnitFiles(text: string): Record<string, UnitFileState> {
  const out: Record<string, UnitFileState> = {};
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 2 && /\.(service|timer|socket|path|mount|target)$/.test(f[0])) {
      out[f[0]] = { state: f[1], preset: f[2] ?? "" };
    }
  }
  return out;
}

/** A unit state that counts as on (enabled-runtime and linked units included). */
export const unitOn = (state: string | undefined): boolean =>
  !!state && /^(enabled|enabled-runtime|linked|linked-runtime|alias)$/.test(state);

/** `snap changes`: installs and removals, by snap (snapd records no user). */
export async function parseSnapChanges(text: string, at: string): Promise<Observation[]> {
  const out: Observation[] = [];
  for (const line of text.split("\n").slice(1)) {
    const m = /^(\d+)\s+(Done|Doing|Error|Undone)\s.*\s(Install|Remove) "([^"]+)" snap/.exec(line);
    if (!m || m[2] !== "Done") continue;
    out.push({
      id: await obsId("snap", m[1], m[4]),
      source: "snap",
      at,
      kind: "snap",
      name: m[4],
      change: m[3] === "Install" ? "installed" : "removed",
      what: `snap ${m[4]} ${m[3] === "Install" ? "installed" : "removed"} (snap change ${m[1]})`,
      evidence: line.trim(),
    });
  }
  return out;
}

/** `dpkg -S <paths>`'s errors: the files no package owns (`dpkg-query: no path found matching pattern /x`). */
export function parseDpkgSearch(stderr: string): string[] {
  return [
    ...stderr.matchAll(/no path found matching pattern (\/\S+)/g),
  ].map((m) => m[1]).sort();
}

/**
 * Modified package files: `debsums -c` (one changed path per line) or, natively,
 * `dpkg --verify` (`??5?????? c /etc/x`: the 5 is a changed digest; `c` marks a
 * configuration file, which is /etc drift, not an alert).
 */
export function parseModified(text: string, at: string): Alert[] {
  const out: Alert[] = [];
  for (const line of text.split("\n")) {
    const t = line.trimEnd();
    if (!t.trim()) continue;
    const v = /^(\S{9}) (.) (\/.+)$/.exec(t);
    if (v) {
      if (v[2] === "c" || v[1][2] !== "5") continue;
      out.push({ path: v[3], at, evidence: t });
      continue;
    }
    const d = /^(?:debsums: changed file )?(\/\S+)(?: \(from (\S+) package\))?$/.exec(t.trim());
    if (d && !d[1].startsWith("/etc/")) {
      out.push({ path: d[1], ...(d[2] ? { package: d[2] } : {}), at, evidence: t.trim() });
    }
  }
  return out;
}
