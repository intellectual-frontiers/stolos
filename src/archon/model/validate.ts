/**
 * TypeScript is the validator (Article 10, spec 002). Each rule returns
 * problems with a message and a fix; an invalid model renders, installs, and
 * applies nothing.
 *
 * @module
 */

import type { FleetDef, HostDef, HostPlan } from "./types.ts";
import { validateSite } from "./site.ts";

/** One thing wrong with the model. */
export interface Problem {
  /** Where it is: a fleet path (`fleet.admin.user`) or a host (`hosts/<name>`). */
  where: string;
  /** What is wrong. */
  message: string;
  /** How to fix it. */
  fix: string;
}

const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const SPEC = /^\d{3}-[a-z0-9-]+$/;
const SSH_KEY =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/;
/** Path segments archon-boot serves under /boot/ (spec 004). */
const RESERVED_HOSTS = new Set(["hosts", "grub", "linux", "initrd"]);
const RESERVED_USERS = new Set(["root", "ops", "ubuntu", "nobody", "daemon", "admin"]);

/** Anything that looks like a secret must never be in the model or rendered output (Article 13). */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, "an Anthropic API key"],
  [/\$(6|y|2[aby]|gy)\$[^\s:]{8,}/, "a password hash"],
];

/** What kind of secret `text` seems to contain ("a private key", "a GitHub token"), or undefined. */
export function findSecret(text: string): string | undefined {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return undefined;
}

/** Check the fleet and its hosts (names, keys, settings, the site, and no secrets in the model). Empty when valid. */
export function validateFleet(fleet: FleetDef, hosts: HostDef[]): Problem[] {
  const p: Problem[] = [];
  const add = (where: string, message: string, fix: string) => p.push({ where, message, fix });
  const a = fleet.admin;
  if (!USER.test(a.user) || RESERVED_USERS.has(a.user)) {
    add(
      "fleet.admin.user",
      `'${a.user}' is not a usable account name`,
      "pick lowercase letters, digits, - or _ (not root, ops, ubuntu)",
    );
  }
  // Spec 039: service accounts, the same on every server.
  const svcNames = new Set<string>();
  const svcUids = new Set<number>();
  for (const x of fleet.services ?? []) {
    const w = `fleet.services.${x.name}`;
    if (!/^s-[a-z0-9][a-z0-9-]{0,28}$/.test(x.name) || svcNames.has(x.name)) {
      add(
        w,
        `'${x.name}' is not a valid, unique service account name`,
        "s- then lowercase letters, digits, and dashes (s-app1)",
      );
    }
    if (!Number.isInteger(x.uid) || x.uid < 800 || x.uid > 899 || svcUids.has(x.uid)) {
      add(w, `uid ${x.uid} is not a free service UID`, "a UID from 800 to 899, each used once");
    }
    if (!x.description?.trim()) add(w, `${x.name} has no description`, "say what the app is");
    svcNames.add(x.name);
    svcUids.add(x.uid);
  }
  if (!Number.isInteger(a.uid) || a.uid < 1000 || a.uid > 59999) {
    add(
      "fleet.admin.uid",
      `uid ${a.uid} is outside the regular user range`,
      "use 1000 (Ubuntu's first user)",
    );
  }
  const gh = a.github;
  if (gh.email !== `${gh.id}+${gh.login}@users.noreply.github.com`) {
    add(
      "fleet.admin.github.email",
      "the commit address is not the GitHub noreply address",
      "re-run stolos fleet init",
    );
  }
  if (!gh.sshKeys.length) {
    add(
      "fleet.admin.github.sshKeys",
      "no SSH public keys: you could not log in after install",
      `add a key at https://github.com/settings/keys, then re-run stolos fleet init`,
    );
  }
  for (const k of gh.sshKeys) {
    if (!SSH_KEY.test(k)) {
      add(
        "fleet.admin.github.sshKeys",
        `not an SSH public key: ${k.slice(0, 40)}...`,
        "re-run stolos fleet init",
      );
    }
  }
  if (fleet.mcp?.maxTier && !["read", "repo", "mutate"].includes(fleet.mcp.maxTier)) {
    add(
      "fleet.mcp.maxTier",
      `'${fleet.mcp.maxTier}' is not a tier an agent may have`,
      "use read, repo, or mutate (the destructive tier is never served over MCP)",
    );
  }
  for (const k of fleet.mcp?.keys ?? []) {
    if (!SSH_KEY.test(k)) {
      add("fleet.mcp.keys", `not an SSH public key: ${k.slice(0, 40)}...`, "paste the .pub line");
    }
  }
  if (!fleet.locale.endsWith(".UTF-8")) {
    add("fleet.locale", `${fleet.locale} is not a UTF-8 locale`, "use for example en_US.UTF-8");
  }
  if (!Intl.supportedValuesOf("timeZone").includes(fleet.timezone) && fleet.timezone !== "UTC") {
    add(
      "fleet.timezone",
      `unknown time zone ${fleet.timezone}`,
      "use an IANA name such as America/New_York",
    );
  }
  for (const net of fleet.ssh?.passwordFrom ?? []) {
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(net)) {
      add(
        "fleet.ssh.passwordFrom",
        `'${net}' is not a network in CIDR form`,
        "for example 10.0.0.0/16 (or [] for keys only)",
      );
    }
  }
  if (
    fleet.telemetry?.collector && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(fleet.telemetry.collector)
  ) {
    add(
      "fleet.telemetry.collector",
      `'${fleet.telemetry.collector}' is not a collector address`,
      "for example http://otel.lan:4318 (OTLP over HTTP)",
    );
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(fleet.repository.slug)) {
    add(
      "fleet.repository.slug",
      `'${fleet.repository.slug}' is not owner/name`,
      "for example example/fleet",
    );
  }

  // Spec 032: the web domain and every published route.
  if (fleet.web) {
    const d = fleet.web.domain;
    if (!/^(?=.{4,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) {
      add("fleet.web.domain", `'${d}' is not a DNS name`, "for example lab.example.net");
    }
    const zone = fleet.web.zone;
    if (zone && !(d === zone || d.endsWith(`.${zone}`))) {
      add(
        "fleet.web.zone",
        `${d} is not inside the zone ${zone}`,
        "name the zone that holds the domain",
      );
    }
  }
  const seenName = new Map<string, string>();
  const seenMac = new Map<string, string>();
  for (const h of hosts) {
    const w = `hosts/${h.name}`;
    const routeNames = new Set<string>(["traefik", "cockpit"]);
    for (
      const r of [
        ...(h.web?.routes ?? []),
        ...(h.guests ?? []).filter((g) => g.web).map((g) => ({ name: g.name, port: g.web!.port })),
      ]
    ) {
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(r.name)) {
        add(
          `${w}.web`,
          `'${r.name}' is not a DNS label`,
          "lowercase letters, digits, inner hyphens",
        );
      }
      if (routeNames.has(r.name)) {
        add(`${w}.web`, `the route name '${r.name}' is taken`, "pick another name");
      }
      routeNames.add(r.name);
      if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) {
        add(`${w}.web`, `${r.name}: port ${r.port} is not a port`, "1 to 65535");
      }
    }
    if ((h.web?.routes?.length || h.guests?.some((g) => g.web)) && !fleet.web) {
      add(
        `${w}.web`,
        "routes need fleet.web (their names live under its domain)",
        "set fleet.web in fleets/<fleet>/fleet.ts",
      );
    }
    if (!HOST.test(h.name)) {
      add(
        w,
        `'${h.name}' is not a valid host name`,
        "lowercase letters, digits, and inner hyphens",
      );
    }
    if (RESERVED_HOSTS.has(h.name)) {
      add(w, `'${h.name}' is a name the boot server uses itself`, "pick another host name");
    }
    if (h.kind === "workstation") {
      // Spec 020: only the user-level parts apply; nothing is installed over the network.
      for (
        const [field, set] of [["mac", h.mac], ["disk", h.disk], ["guests", h.guests?.length], [
          "backup",
          h.backup,
        ], ["users", h.users?.length]] as const
      ) {
        if (set) add(w, `a workstation has no ${field}`, `remove ${field} (spec 020)`);
      }
      if (h.user !== undefined && (!USER.test(h.user) || RESERVED_USERS.has(h.user))) {
        add(w, `'${h.user}' is not a usable account name`, "the WSL account name, lowercase");
      }
    }
    if (h.mac !== undefined) {
      if (!MAC.test(h.mac)) {
        add(w, `MAC '${h.mac}' is not in aa:bb:cc:dd:ee:ff form`, "lowercase hex with colons");
      }
      if (seenMac.has(h.mac)) {
        add(w, `MAC ${h.mac} is also ${seenMac.get(h.mac)}`, "each host needs its own NIC address");
      }
      seenMac.set(h.mac, h.name);
    }
    if (seenName.has(h.name)) add(w, `host name ${h.name} is used twice`, "rename one host");
    seenName.set(h.name, w);
    if (!SPEC.test(h.spec)) add(w, `spec '${h.spec}' is not NNN-name`, "for example 004-install");
    // Spec 038: PostgreSQL instance and role names become cluster names, DNS labels, and SQL identifiers.
    const pgNames = new Set<string>();
    for (const i of h.pg?.instances ?? []) {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(i.name) || pgNames.has(i.name)) {
        add(
          w,
          `PostgreSQL instance '${i.name}' is not a valid, unique name`,
          "lowercase letters, digits, and dashes, starting with a letter",
        );
      }
      pgNames.add(i.name);
      if (i.version !== undefined && (!Number.isInteger(i.version) || i.version < 13)) {
        add(
          w,
          `PostgreSQL instance ${i.name}: version ${i.version} is not supported`,
          "13 or newer (18 is Ubuntu's)",
        );
      }
      if (
        i.port !== undefined &&
        (i.port < 1024 || i.port > 65535 || [22, 53, 80, 443, 445, 9090].includes(i.port))
      ) {
        add(
          w,
          `PostgreSQL instance ${i.name}: port ${i.port} is not usable`,
          "leave it out to get the first free port from 5432",
        );
      }
      for (const d of i.databases ?? []) {
        if (!/^[a-z_][a-z0-9_]{0,59}$/.test(d.name) || d.name === "postgres") {
          add(
            w,
            `PostgreSQL database '${d.name}' in ${i.name} is not usable`,
            "lowercase letters, digits, and _ (not postgres)",
          );
        }
        for (const e of d.extensions ?? []) {
          if (!/^[a-z_][a-z0-9_-]{0,62}$/.test(e)) {
            add(w, `PostgreSQL extension '${e}' in ${i.name} is not usable`, "an extension's name");
          }
        }
        // Spec 039: every name is a Linux account (a person here, or a fleet service account) or @group.
        const people = new Set([fleet.admin.user, ...(h.users ?? []).map((u) => u.name)]);
        const svc = new Set((fleet.services ?? []).map((x) => x.name));
        if (d.owner.startsWith("@")) {
          add(w, `${i.name}/${d.name}: a group cannot own a database`, "name one account as owner");
        }
        for (const p of [d.owner, ...(d.write ?? []), ...(d.read ?? [])]) {
          if (p.startsWith("@")) {
            if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(p.slice(1))) {
              add(
                w,
                `${i.name}/${d.name}: '${p}' is not a group name`,
                "@ and a Linux group's name",
              );
            }
          } else if (p === "postgres" || p === "ops" || (!people.has(p) && !svc.has(p))) {
            add(
              w,
              `${i.name}/${d.name}: '${p}' is not a person on ${h.name} or a fleet service account`,
              "a user in the model, a service in fleet.services (s-<app>), or @group",
            );
          }
        }
      }
    }
    const gnames = new Set<string>();
    for (const g of h.guests ?? []) {
      if (!HOST.test(g.name) || gnames.has(g.name)) {
        add(
          w,
          `guest '${g.name}' is not a valid, unique name`,
          "lowercase letters, digits, and inner hyphens",
        );
      }
      gnames.add(g.name);
      if (g.data !== "durable" && g.data !== "ephemeral") {
        add(
          w,
          `guest ${g.name}: data must be "durable" or "ephemeral" (Article 23; there is no default)`,
          "durable: it can hold data that exists nowhere else; ephemeral: losing it is harmless",
        );
      }
      if (!/^[\w.-]+:[\w./-]+$/.test(g.image)) {
        add(
          w,
          `guest ${g.name}: image '${g.image}' is not remote:alias`,
          "for example ubuntu:26.04",
        );
      }
      if (g.memory && !/^\d+(MiB|GiB)$/.test(g.memory)) {
        add(w, `guest ${g.name}: memory '${g.memory}'`, "for example 4GiB");
      }
    }
    if (h.backup?.target && !h.backup.target.startsWith("/")) {
      add(w, `backup target ${h.backup.target} is not absolute`, "for example /var/backups/archon");
    }
    if (h.backup?.keep !== undefined && (!Number.isInteger(h.backup.keep) || h.backup.keep < 1)) {
      add(w, `backup keep ${h.backup.keep}`, "keep at least 1 archive");
    }
    for (const u of h.users ?? []) {
      if (!USER.test(u.name) || RESERVED_USERS.has(u.name) || u.name === a.user) {
        add(w, `extra account '${u.name}' is not usable here`, "pick another name");
      }
    }
  }
  // Spec 028: the site, and each host's place in it (Article 21).
  if (fleet.site) {
    for (const h of hosts) {
      if (h.network && !fleet.site.networks.some((n) => n.name === h.network)) {
        add(
          `host ${h.name}`,
          `network ${h.network} is not in the site`,
          `use one of: ${fleet.site.networks.map((n) => n.name).join(", ")}`,
        );
      }
    }
    const c = fleet.telemetry?.collector?.match(/^https?:\/\/([^:/]+)/)?.[1];
    const collector = c && !/^\d+\.\d+\.\d+\.\d+$/.test(c) ? c : undefined;
    for (const sp of validateSite(fleet.site, hosts, { collector })) {
      add(sp.where, sp.message, sp.fix);
    }
  }
  const secret = findSecret(JSON.stringify(fleet) + JSON.stringify(hosts));
  if (secret) {
    add(
      "model",
      `the model contains ${secret}`,
      "secrets live only on the boot machine (Article 13); remove it",
    );
  }
  return p;
}

/**
 * Check a host's resolved plan: every spec it uses exists in `knownSpecs`, and
 * its files, ports, units and tools are well formed and carry no secret.
 * Empty when valid.
 */
export function validatePlan(plan: HostPlan, knownSpecs: Set<string>): Problem[] {
  const p: Problem[] = [];
  const w = `hosts/${plan.host.name}`;
  const add = (message: string, fix: string) => p.push({ where: w, message, fix });
  for (const s of plan.specsUsed) {
    if (!knownSpecs.has(s)) {
      add(
        `spec ${s} is referenced but specs/${s}/ does not exist`,
        "write the spec first (Article 8)",
      );
    }
  }
  for (const f of plan.files) {
    if (!f.path.startsWith("/")) add(`${f.path} is not an absolute path`, "use an absolute path");
    if (!/^[0-7]{4}$/.test(f.mode)) {
      add(`${f.path}: mode ${f.mode} is not four octal digits`, "for example 0644");
    }
    const s = f.content && findSecret(f.content);
    if (s) {
      add(`${f.path} would contain ${s}`, "secrets reach a host only at install time (Article 13)");
    }
  }
  for (const port of plan.ports) {
    if (port.port === 5353 || port.port === 5355) {
      add(
        `port ${port.port} (${port.port === 5353 ? "mDNS" : "LLMNR"}) is never opened`,
        "find services by unicast DNS names instead (Article 20)",
      );
    }
    if (!Number.isInteger(port.port) || port.port < 1 || port.port > 65535) {
      add(`port ${port.port} is out of range`, "1 to 65535");
    }
  }
  for (const u of plan.units) {
    if (!/\.(service|timer|socket|target|path|mount)$/.test(u.unitName)) {
      add(`unit ${u.unitName} has no unit suffix`, "for example .service");
    }
    if (!u.verify.trim()) {
      add(
        `unit ${u.unitName} has no verify command`,
        "Article 15: every managed thing is verifiable",
      );
    }
  }
  for (const t of plan.tools) {
    if (t.source === "upstream-binary" && !t.github) {
      add(`tool ${t.id} has no release source`, "name its GitHub repository");
    }
    if ((t.source === "apt" || t.source === "snap") && !t.package) {
      add(`tool ${t.id} has no package name`, "set package");
    }
  }
  return p;
}
