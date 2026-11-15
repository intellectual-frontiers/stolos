// Spec 095: proposals. Changes made on a server outside Stolos are collected as evidence, become
// drift (host minus plan minus birth), are proposed in a signed message, and are adopted on the PC.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  commandTargets,
  etckeeperObservations,
  osqueryDiff,
  type OsquerySnapshot,
  parseAptHistory,
  parseDpkgLog,
  parseDpkgSearch,
  parseEtckeeperLog,
  parseModified,
  parseSnapChanges,
  parseSudoJournal,
  parseUnitFiles,
} from "../src/archon/proposal/parse.ts";
import {
  observationsFrom,
  planView,
  type RawSources,
  stateFrom,
  storeCollection,
} from "../src/archon/proposal/collect.ts";
import {
  type Birth,
  computeDrift,
  driftText,
  type PlanView,
  unproposed,
} from "../src/archon/proposal/drift.ts";
import { fileEvidence, isSecretPath, looksSecret } from "../src/archon/proposal/secrets.ts";
import { listRecords, putRecord } from "../src/archon/state/store.ts";
import { groupItems, sessions } from "../src/archon/proposal/group.ts";
import {
  allowedSigners,
  buildProposal,
  keySigner,
  proposalSummary,
  proposalText,
  revertHint,
  signProposal,
  verifyProposal,
} from "../src/archon/proposal/proposal.ts";
import { choose, proposeCommand } from "../src/archon/proposal/propose.ts";
import { loadDrift } from "../src/archon/proposal/server.ts";
import { redact } from "../src/archon/notify/redact.ts";
import type { Event } from "../src/archon/notify/notify.ts";
import type { DriftItem, Observation, Proposal } from "../src/archon/proposal/types.ts";
import { loadHosts } from "../src/archon/model/load.ts";
import { planFor } from "../src/archon/build.ts";

// ------------------------------------------------------------------ fixtures

const T0 = Date.parse("2026-11-14T15:00:00Z");
const us = (ms: number) => String(ms * 1000);

/** journalctl -o json SYSLOG_IDENTIFIER=sudo */
export const SUDO_JOURNAL = [
  {
    __REALTIME_TIMESTAMP: us(T0),
    MESSAGE: "alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/apt install nginx",
  },
  {
    __REALTIME_TIMESTAMP: us(T0 + 60_000),
    MESSAGE:
      "alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/vim /etc/nginx/sites-available/app",
  },
  {
    __REALTIME_TIMESTAMP: us(T0 + 120_000),
    MESSAGE:
      "alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/systemctl enable nginx",
  },
  {
    __REALTIME_TIMESTAMP: us(T0 + 130_000),
    MESSAGE: "pam_unix(sudo:session): session opened for user root(uid=0) by alice(uid=1000)",
  },
  {
    __REALTIME_TIMESTAMP: us(T0 + 140_000),
    MESSAGE:
      "mallory : 3 incorrect password attempts ; TTY=pts/1 ; PWD=/tmp ; USER=root ; COMMAND=/bin/sh",
  },
  {
    __REALTIME_TIMESTAMP: us(T0 + 150_000),
    MESSAGE:
      "alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/local/bin/archon apply",
  },
  {
    __REALTIME_TIMESTAMP: us(T0 + 7_200_000),
    MESSAGE: "bob : TTY=pts/2 ; PWD=/home/bob ; USER=root ; COMMAND=/usr/sbin/useradd carol",
  },
].map((j) => JSON.stringify(j)).join("\n") + "\n";

const local = (iso: string) => {
  // history.log and dpkg.log are in local time.
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${
    p(d.getMinutes())
  }:${p(d.getSeconds())}`;
};

/** /var/log/apt/history.log */
export const APT_HISTORY = `
Start-Date: ${local("2026-11-14T03:10:00Z")}
Commandline: /usr/bin/unattended-upgrade
Upgrade: openssl:amd64 (3.4.1-1ubuntu1, 3.4.1-1ubuntu2)
End-Date: ${local("2026-11-14T03:10:30Z")}

Start-Date: ${local("2026-11-14T15:00:05Z")}
Commandline: apt install nginx
Requested-By: alice (1000)
Install: nginx:amd64 (1.26.0-1ubuntu1), nginx-common:amd64 (1.26.0-1ubuntu1, automatic)
End-Date: ${local("2026-11-14T15:00:20Z")}
`;

/** /var/log/dpkg.log */
export const DPKG_LOG = [
  `${local("2026-11-14T15:00:10Z").replace("  ", " ")} install nginx:amd64 <none> 1.26.0-1ubuntu1`,
  `${local("2026-11-14T16:30:00Z").replace("  ", " ")} install tool:amd64 <none> 2.0.0`,
  `${local("2026-11-14T16:30:01Z").replace("  ", " ")} status installed tool:amd64 2.0.0`,
].join("\n");

/** git -C /etc log --format=%x1e%H%x1f%an%x1f%aI%x1f%s --name-status */
export const ETC_LOG = [
  "\x1eaaa111\x1falice\x1f2026-11-14T15:03:00Z\x1fdaily autocommit",
  "",
  "A\tnginx/sites-available/app",
  "M\tnginx/nginx.conf",
  '\x1ebbb222\x1froot\x1f2026-11-14T15:00:20Z\x1fcommitting changes in /etc made by "apt install nginx"',
  "",
  "A\tnginx/mime.types",
  "\x1eccc333\x1froot\x1f2026-11-14T15:30:00Z\x1farchon apply: 2 change(s) (010-tools)",
  "",
  "M\tssh/sshd_config.d/archon.conf",
  '\x1eddd444\x1froot\x1f2026-11-14T03:10:30Z\x1fcommitting changes in /etc made by "/usr/bin/unattended-upgrade"',
  "",
  "M\tssl/openssl.cnf",
  "\x1eeee555\x1froot\x1f2026-11-14T18:00:00Z\x1fdaily autocommit",
  "",
  "M\tdefault/grub",
].join("\n");

const osq = (over: Partial<OsquerySnapshot>, at: string): OsquerySnapshot => ({
  at,
  packages: { openssh: "1" },
  users: { alice: "1000 /bin/bash" },
  sudoers: ["/etc/sudoers: %sudo ALL=(ALL:ALL) ALL"],
  ports: ["tcp/22"],
  modules: ["ext4"],
  ...over,
});

/** systemctl list-unit-files --no-legend --plain */
export const UNIT_FILES = [
  "ssh.service enabled enabled",
  "nginx.service enabled enabled",
  "foo.service enabled disabled",
  "cron.service disabled enabled",
  "avahi-daemon.service enabled enabled",
  "systemd-journald.service static -",
].join("\n");

const PLAN: PlanView = {
  packages: ["etckeeper", "git"],
  snaps: [],
  units: {
    "avahi-daemon.service": { state: "masked", spec: "001-platform" },
    "ssh.service": { state: "enabled", spec: "006-ssh" },
  },
  files: { "/etc/ssh/sshd_config.d/archon.conf": { spec: "006-ssh" } },
  ports: ["tcp/22"],
  users: ["alice", "ops"],
  ownPaths: ["/opt/tools", "/usr/local/bin/archon", "/usr/local/bin/deno"],
};

const BIRTH: Birth = {
  at: "2026-11-01T00:00:00Z",
  manualPackages: ["etckeeper", "git", "openssh-server", "cron-extra"],
  snaps: [],
  units: {
    "ssh.service": "enabled",
    "cron.service": "enabled",
    "avahi-daemon.service": "masked",
    "systemd-journald.service": "static",
  },
  users: ["alice"],
  listening: ["tcp/22"],
  etcCommit: "000birth",
};

function raw(over: Partial<RawSources> = {}): RawSources {
  return {
    at: "2026-11-14T19:00:00.000Z",
    sudoJournal: SUDO_JOURNAL,
    aptHistory: APT_HISTORY,
    dpkgLog: DPKG_LOG,
    etcLog: ETC_LOG,
    etcStatus: " M ufw/user.rules\n",
    etcUnowned: ["/etc/nginx/sites-available/app", "/etc/ufw/user.rules"],
    manual: "etckeeper\ngit\nopenssh-server\nnginx\ntool\n",
    snapList: "Name Version Rev Tracking Publisher Notes\nhtop 3.3 1 latest/stable maxiberta -\n",
    snapChanges:
      'ID   Status  Spawn               Ready               Summary\n12   Done    today at 15:40 UTC  today at 15:41 UTC  Install "htop" snap\n',
    unitFiles: UNIT_FILES,
    listening:
      "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\ntcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:*\ntcp LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*\nudp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*\n",
    passwd:
      "root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000::/home/alice:/bin/bash\nops:x:999:999::/home/ops:/bin/bash\ncarol:x:1002:1002::/home/carol:/bin/bash\n",
    containers: "",
    unowned: ["/usr/local/bin/tool-from-source", "/usr/local/bin/deno"],
    modified: [
      "??5?????? c /etc/nginx/nginx.conf",
      "??5??????   /usr/bin/sudo",
      "??5?????? c /etc/default/grub",
    ].join("\n"),
    managedFiles: ["/etc/ssh/sshd_config.d/archon.conf"],
    osquery: osq(
      { users: { alice: "1000 /bin/bash", carol: "1002 /bin/bash" } },
      "2026-11-14T19:00:00.000Z",
    ),
    failed: {},
    ...over,
  };
}

// ------------------------------------------------------------------ phase 1: parsers

Deno.test("095: sudo's journal: who, when, the exact command; refusals, PAM, and archon left out", () => {
  const e = parseSudoJournal(SUDO_JOURNAL);
  assertEquals(e.map((x) => [x.who, x.command]), [
    ["alice", "/usr/bin/apt install nginx"],
    ["alice", "/usr/bin/vim /etc/nginx/sites-available/app"],
    ["alice", "/usr/bin/systemctl enable nginx"],
    ["bob", "/usr/sbin/useradd carol"],
  ]);
  assertEquals(e[0].at, new Date(T0).toISOString());
  assertEquals(commandTargets("/usr/bin/apt install nginx"), [{ kind: "package", name: "nginx" }]);
  assertEquals(commandTargets("/usr/bin/systemctl enable nginx"), [{
    kind: "unit",
    name: "nginx.service",
  }]);
  assertEquals(commandTargets("/usr/bin/vim /etc/nginx/sites-available/app"), [
    { kind: "file", name: "/etc/nginx/sites-available/app" },
  ]);
});

Deno.test("095: apt's history: installs with who asked; upgrades and automatic packages are Ubuntu's", async () => {
  const o = await parseAptHistory(APT_HISTORY);
  assertEquals(o.map((x) => [x.name, x.change, x.who]), [["nginx", "installed", "alice"]]);
  assertStringIncludes(o[0].evidence, "Requested-By: alice (1000)");
  // dpkg.log: only what apt does not explain (a dpkg -i of a downloaded .deb).
  const d = await parseDpkgLog(DPKG_LOG, o);
  assertEquals(d.map((x) => [x.name, x.change, x.source]), [["tool", "installed", "dpkg"]]);
  assertEquals(
    (await parseAptHistory(APT_HISTORY))[0].id,
    o[0].id,
    "the same evidence, the same id",
  );
});

Deno.test("095: etckeeper: a person's changes per file; archon's and Ubuntu's commits left out", async () => {
  const c = parseEtckeeperLog(ETC_LOG);
  assertEquals(
    c.map((x) => x.hash),
    ["aaa111", "bbb222", "ddd444", "eee555"],
    "archon apply dropped",
  );
  const o = await etckeeperObservations(c);
  assertEquals(o.map((x) => [x.name, x.change, x.who ?? ""]), [
    ["/etc/nginx/sites-available/app", "added", "alice"],
    ["/etc/nginx/nginx.conf", "edited", "alice"],
    ["/etc/default/grub", "edited", ""],
  ]);
});

Deno.test("095: osquery snapshots: what changed between two looks, even what nothing logged", async () => {
  const a = osq({}, "2026-11-13T00:00:00Z");
  const b = osq({
    users: { alice: "1000 /bin/bash", carol: "1002 /bin/bash" },
    sudoers: [...a.sudoers, "/etc/sudoers.d/carol: carol ALL=(ALL) NOPASSWD: ALL"],
    ports: ["tcp/22", "tcp/443"],
    modules: ["ext4", "wireguard"],
    packages: { openssh: "1", nginx: "1.26" },
  }, "2026-11-14T00:00:00Z");
  const d = await osqueryDiff(a, b);
  assertEquals(d.map((x) => `${x.kind}:${x.name}:${x.change}`).sort(), [
    "module:wireguard:loaded",
    "package:nginx:installed",
    "port:tcp/443:listening",
    "sudoer:/etc/sudoers.d/carol: carol ALL=(ALL) NOPASSWD: ALL:added",
    "user:carol:added",
  ]);
});

Deno.test("095: unit files, snap changes, dpkg -S, and modified package files", async () => {
  assertEquals(parseUnitFiles(UNIT_FILES)["foo.service"], { state: "enabled", preset: "disabled" });
  const s = await parseSnapChanges(raw().snapChanges, "2026-11-14T19:00:00Z");
  assertEquals(s.map((x) => [x.name, x.change]), [["htop", "installed"]]);
  assertEquals(
    parseDpkgSearch(
      "dpkg-query: no path found matching pattern /usr/local/bin/x\ndpkg-query: no path found matching pattern /opt/y/z\n",
    ),
    ["/opt/y/z", "/usr/local/bin/x"],
  );
  // dpkg --verify: a configuration file is /etc drift, a changed binary an alert.
  assertEquals(parseModified(raw().modified, "t").map((a) => a.path), ["/usr/bin/sudo"]);
  // debsums -c: one changed path per line (configuration files under /etc are not alerts).
  assertEquals(
    parseModified("/usr/bin/passwd\n/etc/default/useradd\n", "t").map((a) => a.path),
    ["/usr/bin/passwd"],
  );
});

// ------------------------------------------------------------------ phase 1: drift

Deno.test("095: drift is the host minus the plan minus the birth snapshot, with who and the adopting edit", async () => {
  const r = raw();
  const state = stateFrom(r, PLAN);
  const observations = await observationsFrom(r, osq({}, "2026-11-13T00:00:00Z"));
  const items = computeDrift({
    plan: PLAN,
    birth: BIRTH,
    state,
    observations,
    now: new Date("2026-11-14T19:00:00Z"),
  });
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assertEquals(Object.keys(by).sort(), [
    "file:/etc/default/grub",
    "file:/etc/nginx/nginx.conf",
    "file:/etc/nginx/sites-available/app",
    "file:/etc/ssh/sshd_config.d/archon.conf",
    "file:/etc/ufw/user.rules",
    "package:cron-extra",
    "package:nginx",
    "package:tool",
    "port:tcp/443",
    "snap:htop",
    "unit:avahi-daemon.service",
    "unit:cron.service",
    "unit:foo.service",
    "unowned:/usr/local/bin/tool-from-source",
    "user:carol",
  ]);
  // Who and when, from the evidence.
  assertEquals(by["package:nginx"].who, "alice");
  assertEquals(by["package:nginx"].edits, [{ op: "packages.add", name: "nginx" }]);
  assertEquals(by["file:/etc/nginx/sites-available/app"].who, "alice");
  assertEquals(by["user:carol"].who, "bob", "the sudo command that made the account");
  // A unit a package brought, as its preset says, is not drift; one enabled against it is.
  assert(!by["unit:nginx.service"], "nginx.service is enabled as its package's preset");
  assertEquals(by["unit:foo.service"].edits, [{ op: "units.enable", unit: "foo.service" }]);
  assertEquals(by["unit:cron.service"].edits, [{ op: "units.disable", unit: "cron.service" }]);
  // Managed: the plan writes or sets it; archon converges it back (a hand edit is held).
  assert(by["unit:avahi-daemon.service"].managed);
  assertEquals(by["file:/etc/ssh/sshd_config.d/archon.conf"].spec, "006-ssh");
  // Ubuntu's own changes are never drift: the unattended upgrade's /etc/ssl/openssl.cnf, nginx's
  // unchanged mime.types (owned by its package), a package removed by Ubuntu.
  assert(!by["file:/etc/ssl/openssl.cnf"] && !by["file:/etc/nginx/mime.types"]);
  assertEquals(by["port:tcp/443"].edits, [{ op: "ports.open", port: 443, protocol: "tcp" }]);
  assert(by["unowned:/usr/local/bin/tool-from-source"].flag?.includes("Article 5"));
  assert(!by["unowned:/usr/local/bin/deno"], "Archon's own tool links are Archon's");
  assertEquals(by["package:cron-extra"].change, "removed");
  assert(by["package:cron-extra"].manual?.includes("Article 11"));
  // A modified package binary is never a drift item.
  assert(!items.some((i) => i.name === "/usr/bin/sudo"));
  const text = driftText("alpha", items, [{
    path: "/usr/bin/sudo",
    at: "t",
    evidence: "??5??????   /usr/bin/sudo",
  }]);
  assert(text.startsWith("SECURITY ALERT"), text);
  assertStringIncludes(text, 'packages.add("nginx")');
});

Deno.test("095: storing a collection: observations in archon.sql, one alert per modified file, never twice", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const first = await storeCollection("alpha", raw(), PLAN, dir);
    assertEquals(first.newAlerts.map((a) => a.path), ["/usr/bin/sudo"]);
    assert(first.observations > 5);
    const again = await storeCollection("alpha", raw(), PLAN, dir);
    assertEquals(again.newAlerts, [], "an alert is mailed once");
    const obs = await listRecords("alpha", "observation", dir);
    assertEquals(obs.length, first.observations, "the same evidence is one record");
    const sql = await Deno.readTextFile(`${dir}/archon.sql`);
    assertStringIncludes(sql, "CREATE VIEW IF NOT EXISTS archon_observation");
    assertEquals((await listRecords("alpha", "snapshot", dir)).map((r) => r.name), [
      "cursor",
      "osquery",
      "state",
    ]);
    assertEquals(unproposed([]), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ------------------------------------------------------------------ Article 13

Deno.test("095: no secrets: inventory and host secret paths, and key-like content, are hashes only", async () => {
  for (
    const p of [
      "/etc/shadow",
      "/etc/ssh/ssh_host_ed25519_key",
      "/etc/archon/mail.json",
      "/srv/x/deploy_key",
      "/etc/ssl/private/site.key",
      "/etc/archon/notify-credential",
    ]
  ) {
    assert(isSecretPath(p), p);
  }
  for (const p of ["/etc/nginx/sites-available/app", "/etc/ssh/sshd_config", "/etc/default/grub"]) {
    assert(!isSecretPath(p), p);
  }
  assert(looksSecret("token = ghp_" + "a".repeat(36)));
  assert(looksSecret("key: Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUlNU"));
  assert(!looksSecret("server { listen 443 ssl; server_name app.example.net; }"));
  const enc = (s: string) => new TextEncoder().encode(s);
  const open = await fileEvidence(
    "/etc/nginx/sites-available/app",
    enc("server { listen 443; }\n"),
  );
  assertEquals(open.content, "server { listen 443; }\n");
  const secretPath = await fileEvidence("/etc/archon/mail.json", enc('{"a":1}'));
  assertEquals(secretPath.content, undefined);
  assert(secretPath.withheld?.includes("secret") && secretPath.sha256.length === 64);
  const keyInside = await fileEvidence(
    "/etc/app/config",
    enc("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"),
  );
  assertEquals(keyInside.content, undefined);
  const big = await fileEvidence("/etc/app/big.conf", enc("x".repeat(20_000)));
  assertEquals(big.content, undefined);
});

// ------------------------------------------------------------------ phase 2: sessions, signing

async function driftFixture(): Promise<{ items: DriftItem[]; observations: Observation[] }> {
  const r = raw();
  const observations = await observationsFrom(r, osq({}, "2026-11-13T00:00:00Z"));
  const items = computeDrift({ plan: PLAN, birth: BIRTH, state: stateFrom(r, PLAN), observations });
  return { items, observations };
}

/** A throwaway ed25519 host key (like a server's /etc/ssh/ssh_host_ed25519_key). */
async function hostKey(dir: string, name = "ssh_host_ed25519_key") {
  const key = `${dir}/${name}`;
  const r = await new Deno.Command("ssh-keygen", {
    args: ["-q", "-t", "ed25519", "-N", "", "-C", "root@alpha", "-f", key],
    stdout: "null",
    stderr: "null",
  }).output();
  assert(r.success, "ssh-keygen made a key");
  const pub = (await Deno.readTextFile(key + ".pub")).trim().split(/\s+/).slice(0, 2).join(" ");
  return { key, pub };
}

Deno.test("095: change sessions: one person's sudo commands, close in time, are one intent", async () => {
  const { items, observations } = await driftFixture();
  const s = sessions(observations);
  assertEquals(s.map((x) => [x.who, x.commands.length]), [["alice", 3], ["bob", 1]]);
  const intents = groupItems(items, observations);
  const alice = intents.find((i) => i.id.startsWith("s-alice-"))!;
  for (
    const k of [
      "package:nginx",
      "file:/etc/nginx/sites-available/app",
      "file:/etc/nginx/nginx.conf",
    ]
  ) {
    assert(alice.items.includes(k), `${k} in alice's session: ${JSON.stringify(alice)}`);
  }
  assert(intents.find((i) => i.id.startsWith("s-bob-"))!.items.includes("user:carol"));
  // Nothing names /etc/default/grub and no session was open at 18:00: the day's other changes.
  assert(intents.some((i) => i.id.startsWith("d-") && i.items.includes("file:/etc/default/grub")));
  // A recording wins over sessions, with its reason.
  const rec = groupItems(items, observations, [{
    id: "r-202611141455",
    reason: "nginx for the app",
    by: "alice",
    start: "2026-11-14T14:55:00Z",
    end: "2026-11-14T15:10:00Z",
  }]);
  const r = rec.find((i) => i.id === "r-202611141455")!;
  assertEquals(r.reason, "nginx for the app");
  assert(r.items.includes("package:nginx"));
});

Deno.test("095: choosing items: a reason is required; a managed item is never kept local", async () => {
  const { items, observations } = await driftFixture();
  const intents = groupItems(items, observations);
  const refused = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  assertStringIncludes(refused(() => choose(items, intents, { all: true })), "reason is required");
  assertStringIncludes(
    refused(() =>
      choose(items, intents, { item: "unit:avahi-daemon.service", action: "local", reason: "x" })
    ),
    "managed by 001-platform",
  );
  const c = choose(items, intents, {
    item: "package:nginx\nfile:/etc/default/grub",
    local: "file:/etc/default/grub",
    until: "2026-12-31",
    reason: "nginx for the app",
  });
  assertEquals(c.choices, {
    "package:nginx": { action: "adopt" },
    "file:/etc/default/grub": { action: "local", until: "2026-12-31" },
  });
  assertStringIncludes(
    revertHint(items.find((i) => i.key === "package:nginx")!),
    "sudo apt remove nginx",
  );
});

async function signedFixture(dir: string) {
  const { items, observations } = await driftFixture();
  const intents = groupItems(items, observations);
  const pick = items.filter((i) =>
    ["package:nginx", "file:/etc/nginx/sites-available/app", "unit:foo.service", "port:tcp/443"]
      .includes(i.key)
  );
  const enc = (s: string) => new TextEncoder().encode(s);
  const draft = buildProposal({
    host: "alpha",
    fleet: "lab",
    base: "0123456789abcdef",
    engine: "0.0.0",
    at: "2026-11-14T19:05:00Z",
    by: "alice",
    reason: "nginx for the app",
    items: pick,
    choices: {},
    intents,
    observations: observations.map((o) =>
      o.source === "apt" ? { ...o, evidence: `${o.evidence}\npassword=hunter2hunter2` } : o
    ),
    files: {
      "/etc/nginx/sites-available/app": await fileEvidence(
        "/etc/nginx/sites-available/app",
        enc("server {\n  listen 443 ssl;\n  server_name app.example.net;\n}\n"),
        { mode: "0644", owner: "root", group: "root" },
      ),
    },
    suffix: "ab12",
  });
  const k = await hostKey(dir);
  const signed = await signProposal(draft, keySigner(k.key));
  return { ...signed, key: k, draft };
}

Deno.test("095: proposal.json: structured edits, content only when allowed, signed by the host key", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { proposal, text, sig, key } = await signedFixture(dir);
    assertEquals(proposal.format, "stolos-proposal/1");
    assertEquals(proposal.id, "alpha-20261114-1905-ab12");
    const by = Object.fromEntries(proposal.items.map((i) => [i.key, i]));
    assertEquals(by["package:nginx"].edits, [{ op: "packages.add", name: "nginx" }]);
    assertEquals(by["file:/etc/nginx/sites-available/app"].edits[0].op, "files.override");
    assertEquals(by["unit:foo.service"].edits, [{ op: "units.enable", unit: "foo.service" }]);
    assertEquals(by["port:tcp/443"].edits, [{ op: "ports.open", port: 443, protocol: "tcp" }]);
    assertEquals(redact(text), text, "the mail's redaction changes nothing");
    assert(!text.includes("hunter2"), "redacted before signing");
    assertStringIncludes(sig, "BEGIN SSH SIGNATURE");
    assertStringIncludes(proposalSummary(proposal), 'packages.add("nginx")');
    // The PC verifies it against the host key in Git.
    const keys = (h: string) => h === "alpha" ? [key.pub] : undefined;
    assertEquals((await verifyProposal(text, sig, keys)).problem, undefined);
    // Altered after signing: refused.
    const altered = text.replace("nginx for the app", "something else");
    assertStringIncludes((await verifyProposal(altered, sig, keys)).problem ?? "", "not alpha's");
    // Signed by another key (forged): refused.
    const other = await hostKey(dir, "other_key");
    const forged = await keySigner(other.key)(text);
    assertStringIncludes((await verifyProposal(text, forged, keys)).problem ?? "", "not alpha's");
    // A host that is not in the fleet: refused.
    assertStringIncludes(
      (await verifyProposal(text, sig, () => undefined)).problem ?? "",
      "not a host of this fleet",
    );
    assertStringIncludes(
      allowedSigners("alpha", [key.pub + " root@alpha"]),
      'alpha namespaces="stolos-proposal" ssh-ed25519 ',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("095: a secret file is a hash in the proposal, and adopting it is by hand", async () => {
  const it: DriftItem = {
    key: "file:/etc/archon/mail.json",
    kind: "file",
    name: "/etc/archon/mail.json",
    change: "edited",
    managed: false,
    at: "2026-11-14T15:00:00Z",
    evidence: [],
    edits: [],
  };
  const p = buildProposal({
    host: "alpha",
    fleet: "lab",
    base: "",
    engine: "0",
    at: "2026-11-14T19:05:00Z",
    by: "alice",
    reason: "r",
    items: [it],
    choices: {},
    intents: [],
    observations: [],
    files: {
      "/etc/archon/mail.json": await fileEvidence(
        "/etc/archon/mail.json",
        new TextEncoder().encode('{"token":"x"}'),
      ),
    },
  });
  const item = p.items[0];
  assertEquals(item.edits, []);
  assertEquals(item.file?.content, undefined);
  assert(item.file?.sha256 && item.manual?.includes("secret"), JSON.stringify(item));
  assert(!proposalText(p).includes("token"));
});

Deno.test("095: archon propose: signs, keeps a copy, records it, mails it; the items are then proposed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const k = await hostKey(dir);
    const host = (await loadHosts()).find((h) => h.name === "alpha")!;
    const view = planView(await planFor(host));
    await storeCollection("alpha", raw(), view, dir);
    await putRecord("alpha", "birth", "birth", BIRTH, dir);
    const mails: Event[] = [];
    const code = await proposeCommand(host, {
      item: "package:nginx",
      reason: "nginx for the app",
      json: true,
    }, {
      sign: keySigner(k.key),
      collectFirst: false,
      dir,
      notify: (ev) => (mails.push(ev), Promise.resolve("queued")),
    });
    assertEquals(code, 0);
    assertEquals(mails.length, 1);
    const json = mails[0].attach!.find((a) => a.endsWith("proposal.json"))!;
    const sigFile = mails[0].attach!.find((a) => a.endsWith("proposal.json.sig"))!;
    const v = await verifyProposal(
      await Deno.readTextFile(json),
      await Deno.readTextFile(sigFile),
      () => [k.pub],
    );
    assertEquals(v.problem, undefined);
    assertEquals((v.proposal as Proposal).items.map((i) => i.key), ["package:nginx"]);
    assertEquals((await listRecords("alpha", "proposal", dir)).length, 1);
    const d = await loadDrift(host, dir);
    assertEquals(d.items.find((i) => i.key === "package:nginx")?.proposal, v.proposal!.id);
    assert(!unproposed(d.items).some((i) => i.key === "package:nginx"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
