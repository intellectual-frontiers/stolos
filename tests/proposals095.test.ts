/**
 * Spec 095: proposals. Changes made on a server outside Stolos are collected as evidence, become
 * drift (host minus plan minus birth), are proposed in a signed message, and are adopted on the PC.
 *
 * @module
 */
import { otel } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
  the,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
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
import type { Event } from "../src/archon/notify/notify.ts";
import type {
  DriftItem,
  FileEvidence,
  Observation,
  Proposal,
} from "../src/archon/proposal/types.ts";
import { loadHosts } from "../src/archon/model/load.ts";
import { planFor } from "../src/archon/build.ts";
import { attachmentsOf } from "../src/archon/proposal/mail.ts";
import { buildMime } from "../src/archon/notify/mime.ts";
import { linkEngine, sandbox } from "./sandbox.ts";
import { registrationSource } from "../src/archon/fleet/registration.ts";
import {
  addAdopted,
  adoptedDef,
  lineDiff,
  nextSpecNumber,
  specId,
} from "../src/archon/proposal/edit.ts";
import { loadProposalDecisions } from "../src/archon/proposal/decisions.ts";
import { activeHolds, heldLine, holdEnds, refreshHolds } from "../src/archon/proposal/hold.ts";
import {
  endRecording,
  remind,
  startRecording,
  waiting,
  waitingLine,
} from "../src/archon/proposal/record.ts";
import { recordings } from "../src/archon/proposal/propose.ts";
import type { SudoEntry } from "../src/archon/proposal/parse.ts";
import type { Hold } from "../src/archon/proposal/drift.ts";

// ------------------------------------------------------------------ fixtures

const T0 = Date.parse("2026-11-14T15:00:00Z");
const us = (ms: number) => String(ms * 1000);

/** journalctl -o json SYSLOG_IDENTIFIER=sudo */
export const SUDO_JOURNAL =
  [
    {
      __REALTIME_TIMESTAMP: us(T0),
      MESSAGE:
        "alice : TTY=pts/0 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/apt install nginx",
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
  ]
    .map((j) => JSON.stringify(j))
    .join("\n") + "\n";

const local = (iso: string) => {
  // history.log and dpkg.log are in local time.
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
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
  ownPaths: ["/opt/tools", "/usr/local/bin/archon", "/usr/local/bin/bun"],
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
    unowned: ["/usr/local/bin/tool-from-source", "/usr/local/bin/bun"],
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

proves(
  ["095-proposals FR-001"],
  "095: sudo's journal: who, when, the exact command; refusals, PAM, and archon left out",
  () => {
    const e = parseSudoJournal(SUDO_JOURNAL);
    assertEquals(
      e.map((x) => [x.who, x.command]),
      [
        ["alice", "/usr/bin/apt install nginx"],
        ["alice", "/usr/bin/vim /etc/nginx/sites-available/app"],
        ["alice", "/usr/bin/systemctl enable nginx"],
        ["bob", "/usr/sbin/useradd carol"],
      ],
    );
    assertEquals(the(e[0]).at, new Date(T0).toISOString());
    assertEquals(commandTargets("/usr/bin/apt install nginx"), [
      { kind: "package", name: "nginx" },
    ]);
    assertEquals(commandTargets("/usr/bin/systemctl enable nginx"), [
      {
        kind: "unit",
        name: "nginx.service",
      },
    ]);
    assertEquals(commandTargets("/usr/bin/vim /etc/nginx/sites-available/app"), [
      { kind: "file", name: "/etc/nginx/sites-available/app" },
    ]);
  },
);

proves(
  ["095-proposals FR-001"],
  "095: apt's history: installs with who asked; upgrades and automatic packages are Ubuntu's",
  async () => {
    const o = await parseAptHistory(APT_HISTORY);
    assertEquals(
      o.map((x) => [x.name, x.change, x.who]),
      [["nginx", "installed", "alice"]],
    );
    assertStringIncludes(the(o[0]).evidence, "Requested-By: alice (1000)");
    // dpkg.log: only what apt does not explain (a dpkg -i of a downloaded .deb).
    const d = await parseDpkgLog(DPKG_LOG, o);
    assertEquals(
      d.map((x) => [x.name, x.change, x.source]),
      [["tool", "installed", "dpkg"]],
    );
    assertEquals(
      the((await parseAptHistory(APT_HISTORY))[0]).id,
      the(o[0]).id,
      "the same evidence, the same id",
    );
  },
);

proves(
  ["095-proposals FR-001"],
  "095: etckeeper: a person's changes per file; archon's and Ubuntu's commits left out",
  async () => {
    const c = parseEtckeeperLog(ETC_LOG);
    assertEquals(
      c.map((x) => x.hash),
      ["aaa111", "bbb222", "ddd444", "eee555"],
      "archon apply dropped",
    );
    const o = await etckeeperObservations(c);
    assertEquals(
      o.map((x) => [x.name, x.change, x.who ?? ""]),
      [
        ["/etc/nginx/sites-available/app", "added", "alice"],
        ["/etc/nginx/nginx.conf", "edited", "alice"],
        ["/etc/default/grub", "edited", ""],
      ],
    );
  },
);

proves(
  ["095-proposals FR-001"],
  "095: osquery snapshots: what changed between two looks, even what nothing logged",
  async () => {
    const a = osq({}, "2026-11-13T00:00:00Z");
    const b = osq(
      {
        users: { alice: "1000 /bin/bash", carol: "1002 /bin/bash" },
        sudoers: [...a.sudoers, "/etc/sudoers.d/carol: carol ALL=(ALL) NOPASSWD: ALL"],
        ports: ["tcp/22", "tcp/443"],
        modules: ["ext4", "wireguard"],
        packages: { openssh: "1", nginx: "1.26" },
      },
      "2026-11-14T00:00:00Z",
    );
    const d = await osqueryDiff(a, b);
    assertEquals(d.map((x) => `${x.kind}:${x.name}:${x.change}`).sort(), [
      "module:wireguard:loaded",
      "package:nginx:installed",
      "port:tcp/443:listening",
      "sudoer:/etc/sudoers.d/carol: carol ALL=(ALL) NOPASSWD: ALL:added",
      "user:carol:added",
    ]);
  },
);

proves(
  ["095-proposals FR-001"],
  "095: unit files, snap changes, dpkg -S, and modified package files",
  async () => {
    assertEquals(parseUnitFiles(UNIT_FILES)["foo.service"], {
      state: "enabled",
      preset: "disabled",
    });
    const s = await parseSnapChanges(raw().snapChanges, "2026-11-14T19:00:00Z");
    assertEquals(
      s.map((x) => [x.name, x.change]),
      [["htop", "installed"]],
    );
    assertEquals(
      parseDpkgSearch(
        "dpkg-query: no path found matching pattern /usr/local/bin/x\ndpkg-query: no path found matching pattern /opt/y/z\n",
      ),
      ["/opt/y/z", "/usr/local/bin/x"],
    );
    // dpkg --verify: a configuration file is /etc drift, a changed binary an alert.
    assertEquals(
      parseModified(raw().modified, "t").map((a) => a.path),
      ["/usr/bin/sudo"],
    );
    // debsums -c: one changed path per line (configuration files under /etc are not alerts).
    assertEquals(
      parseModified("/usr/bin/passwd\n/etc/default/useradd\n", "t").map((a) => a.path),
      ["/usr/bin/passwd"],
    );
  },
);

// ------------------------------------------------------------------ phase 1: drift

proves(
  ["095-proposals FR-003", "095-proposals FR-004"],
  "095: drift is the host minus the plan minus the birth snapshot, with who and the adopting edit",
  async () => {
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
    assertEquals(the(by["package:nginx"]).who, "alice");
    assertEquals(the(by["package:nginx"]).edits, [{ op: "packages.add", name: "nginx" }]);
    assertEquals(the(by["file:/etc/nginx/sites-available/app"]).who, "alice");
    assertEquals(the(by["user:carol"]).who, "bob", "the sudo command that made the account");
    // A unit a package brought, as its preset says, is not drift; one enabled against it is.
    assert(!by["unit:nginx.service"], "nginx.service is enabled as its package's preset");
    assertEquals(the(by["unit:foo.service"]).edits, [{ op: "units.enable", unit: "foo.service" }]);
    assertEquals(the(by["unit:cron.service"]).edits, [
      { op: "units.disable", unit: "cron.service" },
    ]);
    // Managed: the plan writes or sets it; archon converges it back (a hand edit is held).
    assert(the(by["unit:avahi-daemon.service"]).managed);
    assertEquals(the(by["file:/etc/ssh/sshd_config.d/archon.conf"]).spec, "006-ssh");
    // Ubuntu's own changes are never drift: the unattended upgrade's /etc/ssl/openssl.cnf, nginx's
    // unchanged mime.types (owned by its package), a package removed by Ubuntu.
    assert(!by["file:/etc/ssl/openssl.cnf"] && !by["file:/etc/nginx/mime.types"]);
    assertEquals(the(by["port:tcp/443"]).edits, [{ op: "ports.open", port: 443, protocol: "tcp" }]);
    assert(the(by["unowned:/usr/local/bin/tool-from-source"]).flag?.includes("Article 5"));
    assert(!by["unowned:/usr/local/bin/bun"], "Archon's own tool links are Archon's");
    assertEquals(the(by["package:cron-extra"]).change, "removed");
    assert(the(by["package:cron-extra"]).manual?.includes("Article 11"));
    // A modified package binary is never a drift item.
    assert(!items.some((i) => i.name === "/usr/bin/sudo"));
    const text = driftText("alpha", items, [
      {
        path: "/usr/bin/sudo",
        at: "t",
        evidence: "??5??????   /usr/bin/sudo",
      },
    ]);
    assert(text.startsWith("SECURITY ALERT"), text);
    assertStringIncludes(text, 'packages.add("nginx")');
  },
);

proves(
  ["095-proposals FR-001"],
  "095: storing a collection: observations in archon.sql, one alert per modified file, never twice",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const first = await storeCollection("alpha", raw(), PLAN, dir);
      assertEquals(
        first.newAlerts.map((a) => a.path),
        ["/usr/bin/sudo"],
      );
      assert(first.observations > 5);
      const again = await storeCollection("alpha", raw(), PLAN, dir);
      assertEquals(again.newAlerts, [], "an alert is mailed once");
      const obs = await listRecords("alpha", "observation", dir);
      assertEquals(obs.length, first.observations, "the same evidence is one record");
      const sql = await fs.readTextFile(`${dir}/archon.sql`);
      assertStringIncludes(sql, "CREATE VIEW IF NOT EXISTS archon_observation");
      assertEquals(
        (await listRecords("alpha", "snapshot", dir)).map((r) => r.name),
        ["cursor", "osquery", "state"],
      );
      assertEquals(unproposed([]), []);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

// ------------------------------------------------------------------ Article 13

proves(
  ["095-proposals FR-008"],
  "095: no secrets: inventory and host secret paths, and key-like content, are hashes only",
  async () => {
    for (const p of [
      "/etc/shadow",
      "/etc/ssh/ssh_host_ed25519_key",
      "/etc/archon/mail.json",
      "/srv/x/deploy_key",
      "/etc/ssl/private/site.key",
      "/etc/archon/notify-credential",
    ]) {
      assert(isSecretPath(p), p);
    }
    for (const p of [
      "/etc/nginx/sites-available/app",
      "/etc/ssh/sshd_config",
      "/etc/default/grub",
    ]) {
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
  },
);

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
  const r = await proc.output(
    ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "root@alpha", "-f", key],
    { stdout: "null", stderr: "null" },
  );
  assert(r.success, "ssh-keygen made a key");
  const pub = (await fs.readTextFile(key + ".pub")).trim().split(/\s+/).slice(0, 2).join(" ");
  return { key, pub };
}

proves(
  ["095-proposals FR-006"],
  "095: change sessions: one person's sudo commands, close in time, are one intent",
  async () => {
    const { items, observations } = await driftFixture();
    const s = sessions(observations);
    assertEquals(
      s.map((x) => [x.who, x.commands.length]),
      [
        ["alice", 3],
        ["bob", 1],
      ],
    );
    const intents = groupItems(items, observations);
    const alice = the(intents.find((i) => i.id.startsWith("s-alice-")));
    for (const k of [
      "package:nginx",
      "file:/etc/nginx/sites-available/app",
      "file:/etc/nginx/nginx.conf",
    ]) {
      assert(alice.items.includes(k), `${k} in alice's session: ${JSON.stringify(alice)}`);
    }
    assert(the(intents.find((i) => i.id.startsWith("s-bob-"))).items.includes("user:carol"));
    // Nothing names /etc/default/grub and no session was open at 18:00: the day's other changes.
    assert(
      intents.some((i) => i.id.startsWith("d-") && i.items.includes("file:/etc/default/grub")),
    );
    // A recording wins over sessions, with its reason.
    const rec = groupItems(items, observations, [
      {
        id: "r-202611141455",
        reason: "nginx for the app",
        by: "alice",
        start: "2026-11-14T14:55:00Z",
        end: "2026-11-14T15:10:00Z",
      },
    ]);
    const r = the(rec.find((i) => i.id === "r-202611141455"));
    assertEquals(r.reason, "nginx for the app");
    assert(r.items.includes("package:nginx"));
  },
);

proves(
  ["095-proposals FR-007"],
  "095: choosing items: a reason is required; a managed item is never kept local",
  async () => {
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
    assertStringIncludes(
      refused(() => choose(items, intents, { all: true })),
      "reason is required",
    );
    assertStringIncludes(
      refused(() =>
        choose(items, intents, { item: "unit:avahi-daemon.service", action: "local", reason: "x" }),
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
      revertHint(the(items.find((i) => i.key === "package:nginx"))),
      "sudo apt remove nginx",
    );
  },
);

async function signedFixture(dir: string) {
  const { items, observations } = await driftFixture();
  const intents = groupItems(items, observations);
  const pick = items.filter((i) =>
    [
      "package:nginx",
      "file:/etc/nginx/sites-available/app",
      "unit:foo.service",
      "port:tcp/443",
    ].includes(i.key),
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
      o.source === "apt" ? { ...o, evidence: `${o.evidence}\npassword=hunter2hunter2` } : o,
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

proves(
  ["095-proposals FR-008", "095-proposals FR-009"],
  "095: proposal.json: structured edits, content only when allowed, signed by the host key",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const { proposal, text, sig, key } = await signedFixture(dir);
      assertEquals(proposal.format, "stolos-proposal/1");
      assertEquals(proposal.id, "alpha-20261114-1905-ab12");
      const by = Object.fromEntries(proposal.items.map((i) => [i.key, i]));
      assertEquals(the(by["package:nginx"]).edits, [{ op: "packages.add", name: "nginx" }]);
      assertEquals(the(by["file:/etc/nginx/sites-available/app"]).edits[0]?.op, "files.override");
      assertEquals(the(by["unit:foo.service"]).edits, [
        { op: "units.enable", unit: "foo.service" },
      ]);
      assertEquals(the(by["port:tcp/443"]).edits, [
        { op: "ports.open", port: 443, protocol: "tcp" },
      ]);
      assertEquals(otel.redactText(text), text, "the mail's redaction changes nothing");
      assert(!text.includes("hunter2"), "redacted before signing");
      assertStringIncludes(sig, "BEGIN SSH SIGNATURE");
      assertStringIncludes(proposalSummary(proposal), 'packages.add("nginx")');
      // The PC verifies it against the host key in Git.
      const keys = (h: string) => (h === "alpha" ? [key.pub] : undefined);
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
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["095-proposals FR-008"],
  "095: a secret file is a hash in the proposal, and adopting it is by hand",
  async () => {
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
    assertExists(item);
    assertEquals(item.edits, []);
    assertEquals(item.file?.content, undefined);
    assert(item.file?.sha256 && item.manual?.includes("secret"), JSON.stringify(item));
    assert(!proposalText(p).includes("token"));
  },
);

proves(
  ["095-proposals FR-007", "095-proposals FR-009", "095-proposals FR-010"],
  "095: archon propose: signs, keeps a copy, records it, mails it; the items are then proposed",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const k = await hostKey(dir);
      const host = the((await loadHosts()).find((h) => h.name === "alpha"));
      const view = planView(await planFor(host));
      await storeCollection("alpha", raw(), view, dir);
      await putRecord("alpha", "birth", "birth", BIRTH, dir);
      const mails: Event[] = [];
      const code = await proposeCommand(
        host,
        {
          item: "package:nginx",
          reason: "nginx for the app",
          json: true,
        },
        {
          sign: keySigner(k.key),
          collectFirst: false,
          dir,
          notify: (ev) => (mails.push(ev), Promise.resolve("queued")),
        },
      );
      assertEquals(code, 0);
      assertEquals(mails.length, 1);
      const json = the(the(the(mails[0]).attach).find((a) => a.endsWith("proposal.json")));
      const sigFile = the(the(the(mails[0]).attach).find((a) => a.endsWith("proposal.json.sig")));
      const v = await verifyProposal(
        await fs.readTextFile(json),
        await fs.readTextFile(sigFile),
        () => [k.pub],
      );
      assertEquals(v.problem, undefined);
      assertEquals(
        (v.proposal as Proposal).items.map((i) => i.key),
        ["package:nginx"],
      );
      assertEquals((await listRecords("alpha", "proposal", dir)).length, 1);
      const d = await loadDrift(host, dir);
      assertEquals(d.items.find((i) => i.key === "package:nginx")?.proposal, the(v.proposal).id);
      assert(!unproposed(d.items).some((i) => i.key === "package:nginx"));
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

// ------------------------------------------------------------------ phase 3: on the PC

const ENGINE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function item(key: string, edits: DriftItem["edits"], extra: Partial<DriftItem> = {}): DriftItem {
  const [kind, ...rest] = key.split(":");
  return {
    key,
    kind: kind as DriftItem["kind"],
    name: rest.join(":"),
    change: "installed",
    managed: false,
    who: "alice",
    at: "2026-11-14T15:00:00Z",
    evidence: [],
    edits,
    ...extra,
  };
}

/** A signed proposal from alpha, as the mail carries it (an .eml with both attachments). */
async function mailed(
  key: string,
  items: DriftItem[],
  suffix: string,
  opts: {
    reason?: string;
    choices?: Record<string, { action: "adopt" | "revert" | "local"; until?: string }>;
    files?: Record<string, FileEvidence>;
  } = {},
) {
  const p = buildProposal({
    host: "alpha",
    fleet: "lab",
    base: "",
    engine: "0.0.0",
    at: "2026-11-14T19:05:00Z",
    by: "alice",
    reason: opts.reason ?? "nginx for the app",
    items,
    choices: opts.choices ?? {},
    intents: [],
    observations: [],
    files: opts.files ?? {},
    suffix,
  });
  const s = await signProposal(p, keySigner(key));
  const enc = new TextEncoder();
  const eml = buildMime({
    from: "root+alpha.lab@example.net",
    to: "fleet@example.net",
    subject: `[Archon] alpha: proposal ${s.proposal.id}`,
    text: proposalSummary(s.proposal),
    html: "<p>proposal</p>",
    attachments: [
      { name: "proposal.json", type: "application/json", data: enc.encode(s.text) },
      { name: "proposal.json.sig", type: "text/plain", data: enc.encode(s.sig) },
    ],
  });
  return { ...s, eml };
}

proves(
  ["095-proposals FR-011"],
  "095: a saved .eml's attachments are read back exactly (base64, quoted-printable, gzip)",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const k = await hostKey(dir);
      const m = await mailed(
        k.key,
        [item("package:nginx", [{ op: "packages.add", name: "nginx" }])],
        "aaaa",
      );
      const att = await attachmentsOf(m.eml);
      assertEquals(
        att.map((a) => a.name),
        ["proposal.json", "proposal.json.sig"],
      );
      assertEquals(new TextDecoder().decode(the(att[0]).data), m.text);
      assertEquals(new TextDecoder().decode(the(att[1]).data), m.sig);
      const gz = new Uint8Array(
        await new Response(
          new Blob([new TextEncoder().encode(m.text)])
            .stream()
            .pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      );
      const qp = [
        "Content-Type: multipart/mixed; boundary=b1",
        "",
        "--b1",
        'Content-Type: application/gzip; name="proposal.json.gz"',
        "Content-Transfer-Encoding: base64",
        "",
        btoa(String.fromCharCode(...gz)),
        "--b1",
        "Content-Type: text/plain",
        'Content-Disposition: attachment; filename="note.txt"',
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "caf=C3=A9 =",
        "ok",
        "--b1--",
      ].join("\r\n");
      const back = await attachmentsOf(qp);
      assertEquals(
        back.map((a) => a.name),
        ["proposal.json", "note.txt"],
      );
      assertEquals(new TextDecoder().decode(the(back[0]).data), m.text);
      assertEquals(new TextDecoder().decode(the(back[1]).data).trim(), "café ok");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["095-proposals FR-013"],
  "095: host.ts edits: adopted({...}) with bare keys and its import; the diff; spec numbers",
  () => {
    const src = `import type { HostDef } from "@intellectual-frontiers/stolos/archon/model/types";
import { foundation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";

export const host: HostDef = {
  name: "alpha",
  arch: "amd64",
  capabilities: foundation(),
  spec: "004-install",
};
`;
    const d = adoptedDef("alpha-x", "096-alpha-nginx", [
      { op: "packages.add", name: "nginx" },
      { op: "units.enable", unit: "nginx.service" },
      { op: "ports.open", port: 8443, protocol: "tcp" },
    ]);
    const r = addAdopted(src, d, "Spec 096-alpha-nginx: adopted from proposal alpha-x.");
    assert("text" in r);
    assertStringIncludes(
      r.text,
      'import { adopted, foundation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";',
    );
    assertStringIncludes(r.text, "  capabilities: [\n    ...foundation(),\n    // Spec 096");
    assertStringIncludes(
      r.text,
      '    adopted({\n      proposal: "alpha-x",\n      spec: "096-alpha-nginx",\n      packages: [\n        "nginx",\n      ],',
    );
    assertStringIncludes(
      r.text,
      '      ports: [\n        {\n          port: 8443,\n          protocol: "tcp",\n        },\n      ],\n    }),\n  ],',
    );
    // A second proposal adds to the list.
    const again = addAdopted(
      r.text,
      adoptedDef("alpha-y", "097-alpha-htop", [{ op: "packages.add", name: "htop" }]),
      "Spec 097.",
    );
    assert("text" in again);
    assertEquals(again.text.match(/adopted\(\{/g)?.length, 2);
    assertEquals(again.text.match(/import \{ adopted, foundation \}/g)?.length, 1);
    assertStringIncludes(lineDiff(src, r.text), "+     adopted({");
    assert("problem" in addAdopted("export const host = {};\n", d, "x"));
    assertEquals(nextSpecNumber(["004-install", "095-proposals", "notes"]), 96);
    assertEquals(specId(96, "alpha", "nginx for the app!"), "096-alpha-nginx-for-the-app");
  },
);

proves(
  ["095-proposals FR-011", "095-proposals FR-012", "095-proposals FR-013", "095-proposals FR-014"],
  "095: on the PC: import a mail, refuse a forgery, show, accept into host.ts, name a conflict, reject",
  async () => {
    const sb = await sandbox("archon-proposal-test-");
    const repo = `${sb.home}/fleet`;
    try {
      await fs.mkdir(`${repo}/fleets`, { recursive: true });
      await linkEngine(repo);
      await proc.output(["cp", "-r", `${ENGINE}/examples/fleets/lab`, `${repo}/fleets/lab`]);
      const k = await hostKey(sb.home);
      await fs.writeTextFile(
        `${repo}/fleets/lab/hosts/alpha/registration.ts`,
        registrationSource({ sshHostKeys: [k.pub], added: "2026-11-13" }),
      );
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      const stolos = (args: string[]) => sb.run(`${ENGINE}/src/stolos/main.ts`, args, "", env);
      const enc = (s: string) => new TextEncoder().encode(s);
      const site = "server {\n  listen 8443;\n}\n";
      const one = await mailed(
        k.key,
        [
          item("package:nginx", [{ op: "packages.add", name: "nginx" }]),
          item("unit:nginx-extra.service", [{ op: "units.enable", unit: "nginx-extra.service" }], {
            change: "enabled",
          }),
          item("port:tcp/443", [{ op: "ports.open", port: 443, protocol: "tcp" }], {
            change: "listening",
          }),
          item("file:/etc/nginx/sites-available/app", [], { change: "added" }),
          item("file:/etc/default/grub", [], { change: "edited" }),
        ],
        "0001",
        {
          choices: { "file:/etc/default/grub": { action: "local", until: "2026-12-31" } },
          files: {
            "/etc/nginx/sites-available/app": await fileEvidence(
              "/etc/nginx/sites-available/app",
              enc(site),
              { mode: "0644", owner: "root", group: "root" },
            ),
          },
        },
      );
      await fs.mkdir(`${sb.home}/mail`);
      await fs.writeTextFile(`${sb.home}/mail/one.eml`, one.eml);
      // A forgery: the same signature over changed text, as .json files beside each other.
      await fs.mkdir(`${sb.home}/forged`);
      await fs.writeTextFile(
        `${sb.home}/forged/proposal.json`,
        one.text.replace("nginx for the app", "something else"),
      );
      await fs.writeTextFile(`${sb.home}/forged/proposal.json.sig`, one.sig);

      let r = await stolos(["proposal", "import", `${sb.home}/forged`]);
      assert(r.code !== 0, r.out);
      assertStringIncludes(r.out, "refused: the signature is not alpha's");
      r = await stolos(["proposal", "import", `${sb.home}/mail`]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, `✓ ${one.proposal.id}: from alpha, by alice, 5 item(s)`);
      r = await stolos(["proposal", "import", `${sb.home}/mail/one.eml`]);
      assertStringIncludes(r.out, "already imported");
      r = await stolos(["proposal", "list"]);
      assertStringIncludes(r.out, `${one.proposal.id}`);
      assertStringIncludes(r.out, "waiting");
      r = await stolos(["proposal", "show", one.proposal.id]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "good (alpha's host key)");
      assertStringIncludes(r.out, "already: port:tcp/443: the model opens tcp/443");
      assertStringIncludes(r.out, "+     adopted({");

      // Accept: host.ts, a draft spec, the decision, and a build.
      r = await stolos(["proposal", "accept", one.proposal.id]);
      assertEquals(r.code, 0, r.out);
      const hostTs = await fs.readTextFile(`${repo}/fleets/lab/hosts/alpha/host.ts`);
      assertStringIncludes(
        hostTs,
        'import { adopted, foundation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";',
      );
      assertStringIncludes(hostTs, `proposal: "${one.proposal.id}",`);
      assertStringIncludes(hostTs, 'spec: "097-alpha-nginx-for-the-app",');
      assertStringIncludes(hostTs, 'packages: [\n        "nginx",\n      ],');
      assertStringIncludes(hostTs, 'enable: [\n        "nginx-extra.service",\n      ],');
      assertStringIncludes(hostTs, 'path: "/etc/nginx/sites-available/app",');
      assert(!hostTs.includes("ports:"), "443 is already open in the model");
      const spec = await fs.readTextFile(
        `${repo}/fleets/lab/specs/097-alpha-nginx-for-the-app/spec.md`,
      );
      assertStringIncludes(spec, "# 097: nginx for the app (alpha)");
      assertStringIncludes(spec, '`packages.add("nginx")`');
      assertStringIncludes(spec, "file:/etc/default/grub, until 2026-12-31");
      const decisions = await fs.readTextFile(`${repo}/fleets/lab/hosts/alpha/proposals.ts`);
      assertStringIncludes(decisions, `"${one.proposal.id}": {\n    decision: "accepted",`);
      assertStringIncludes(
        decisions,
        'key: "file:/etc/default/grub",\n        until: "2026-12-31",',
      );
      r = await stolos(["validate"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["proposal", "accept", one.proposal.id]);
      assert(r.code !== 0 && r.out.includes("already accepted"), r.out);

      // A conflict: the model masks avahi-daemon (spec 001); it is named, and nothing is written.
      const two = await mailed(
        k.key,
        [
          item(
            "unit:avahi-daemon.service",
            [{ op: "units.enable", unit: "avahi-daemon.service" }],
            {
              change: "enabled",
              managed: true,
            },
          ),
          item("package:htop", [{ op: "packages.add", name: "htop" }]),
        ],
        "0002",
        { reason: "htop and avahi" },
      );
      await fs.writeTextFile(`${sb.home}/mail/two.eml`, two.eml);
      r = await stolos(["proposal", "import", `${sb.home}/mail/two.eml`]);
      assertEquals(r.code, 0, r.out);
      const before = await fs.readTextFile(`${repo}/fleets/lab/hosts/alpha/host.ts`);
      r = await stolos(["proposal", "accept", two.proposal.id]);
      assert(r.code !== 0, r.out);
      assertStringIncludes(
        r.out,
        "unit:avahi-daemon.service: the model sets avahi-daemon.service masked (spec 001-",
      );
      assertStringIncludes(r.out, `--skip unit:avahi-daemon.service`);
      assertEquals(
        await fs.readTextFile(`${repo}/fleets/lab/hosts/alpha/host.ts`),
        before,
        "nothing written",
      );
      r = await stolos([
        "proposal",
        "accept",
        two.proposal.id,
        "--skip",
        "unit:avahi-daemon.service",
      ]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(
        await fs.readTextFile(`${repo}/fleets/lab/hosts/alpha/host.ts`),
        '"htop"',
      );
      assertStringIncludes(
        await fs.readTextFile(`${repo}/fleets/lab/specs/098-alpha-htop-and-avahi/spec.md`),
        "skipped at acceptance",
      );

      // Reject: recorded in Git.
      const three = await mailed(
        k.key,
        [item("package:cowsay", [{ op: "packages.add", name: "cowsay" }])],
        "0003",
        { reason: "fun" },
      );
      await fs.writeTextFile(`${sb.home}/mail/three.eml`, three.eml);
      await stolos(["proposal", "import", `${sb.home}/mail/three.eml`]);
      r = await stolos(["proposal", "reject", three.proposal.id, "--reason", "not on a server"]);
      assertEquals(r.code, 0, r.out);
      const d = await loadProposalDecisions("alpha", `${repo}/fleets/lab/hosts/alpha/proposals.ts`);
      assertEquals(the(d[three.proposal.id]).decision, "rejected");
      assertEquals(the(d[three.proposal.id]).reason, "not on a server");
      assertEquals(the(d[two.proposal.id]).skipped, ["unit:avahi-daemon.service"]);
      r = await stolos(["proposal", "list"]);
      assertStringIncludes(r.out, "rejected");
      r = await stolos(["validate"]);
      assertEquals(r.code, 0, r.out);
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["095-proposals FR-007", "095-proposals FR-014"],
  "095: on the host, a rejected proposal's items are flagged; accepted local drift is quiet until its day",
  () => {
    const state = stateFrom(
      raw({
        manual: "cowsay\n",
        etcLog: "",
        etcStatus: " M x\n",
        etcUnowned: ["/etc/x"],
        managedFiles: [],
        unowned: [],
        unitFiles: "",
        listening: "",
        passwd: "",
        snapList: "",
      }),
      PLAN,
    );
    const base = {
      plan: PLAN,
      birth: { ...BIRTH, manualPackages: [] },
      state,
      observations: [],
      now: new Date("2026-11-20T00:00:00Z"),
    };
    const proposals = [
      {
        id: "p1",
        at: "t",
        by: "alice",
        reason: "r",
        sent: "queued",
        items: [{ key: "package:cowsay", action: "adopt" }],
      },
      {
        id: "p2",
        at: "t",
        by: "alice",
        reason: "r",
        sent: "queued",
        items: [{ key: "file:/etc/x", action: "local", until: "2026-12-31" }],
      },
    ];
    const d = computeDrift({
      ...base,
      proposals,
      decisions: { p1: { decision: "rejected", by: "bob", at: "t" } },
    });
    const by = Object.fromEntries(d.map((i) => [i.key, i]));
    assert(the(by["package:cowsay"]).rejected && !the(by["package:cowsay"]).proposal);
    assertEquals(the(by["file:/etc/x"]).localUntil, "2026-12-31");
    assertEquals(unproposed(d), []);
    const later = computeDrift({
      ...base,
      now: new Date("2027-01-02T00:00:00Z"),
      proposals: [the(proposals[1])],
    });
    assertEquals(
      later.find((i) => i.key === "file:/etc/x")?.localUntil,
      undefined,
      "past its day: drift again",
    );
  },
);

// ------------------------------------------------------------------ phase 4: hold, record, reminders

proves(
  ["095-proposals FR-015"],
  "095: the hold: a managed item a person changed under sudo is kept 7 days, or until decided",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const host = the((await loadHosts()).find((h) => h.name === "alpha"));
      const plan = await planFor(host);
      const file = the(
        plan.files.find((f) => f.path.startsWith("/etc/") && f.content !== undefined),
      );
      const unitName = "avahi-daemon.service"; // the plan masks it (spec 001, Article 20)
      const t0 = Date.parse("2026-11-14T15:00:00Z");
      const day = 86_400_000;
      let entries: SudoEntry[] = [
        {
          who: "alice",
          at: new Date(t0).toISOString(),
          command: `/usr/bin/vim ${file.path}`,
          as: "root",
          pwd: "/",
        },
        {
          who: "alice",
          at: new Date(t0 + 60_000).toISOString(),
          command: `/usr/bin/systemctl unmask avahi-daemon`,
          as: "root",
          pwd: "/",
        },
        {
          who: "bob",
          at: new Date(t0).toISOString(),
          command: `/usr/bin/vim /etc/not-managed`,
          as: "root",
          pwd: "/",
        },
      ];
      const look = {
        file: (p: string) =>
          Promise.resolve(p === file.path ? file.content + "\n# by hand\n" : undefined),
        unit: (_u: string) => Promise.resolve("enabled"),
        sudo: (_since: string) => Promise.resolve(entries),
      };
      const at = (ms: number) => new Date(t0 + ms);
      let h = await refreshHolds(plan, { dir, now: at(day), look, decisions: {} });
      assertEquals([...h.keys()].sort(), [`file:${file.path}`, `unit:${unitName}`]);
      assertEquals(the(h.get(`file:${file.path}`)).until, new Date(t0 + 7 * day).toISOString());
      assertStringIncludes(
        heldLine(the(h.get(`file:${file.path}`))),
        "held: alice changed it under sudo",
      );
      // apply --check reads the same holds (it never changes them).
      assertEquals([...(await activeHolds("alpha", dir)).keys()].length, 2);

      // Proposed: the hold now waits for the decision in Git; accepted ends it.
      await putRecord(
        "alpha",
        "hold",
        `unit:${unitName}`,
        {
          ...the(h.get(`unit:${unitName}`)),
          proposal: "p1",
        },
        dir,
      );
      h = await refreshHolds(plan, {
        dir,
        now: at(2 * day),
        look,
        decisions: { p1: { decision: "accepted", by: "bob", at: "t" } },
      });
      assertEquals([...h.keys()], [`file:${file.path}`]);
      // The same sudo command never holds it again...
      h = await refreshHolds(plan, { dir, now: at(3 * day), look, decisions: {} });
      assertEquals([...h.keys()], [`file:${file.path}`]);
      // ...a newer one does.
      entries = [...entries, { ...the(entries[1]), at: new Date(t0 + 4 * day).toISOString() }];
      h = await refreshHolds(plan, { dir, now: at(4 * day), look, decisions: {} });
      assertEquals([...h.keys()].sort(), [`file:${file.path}`, `unit:${unitName}`]);
      // After 7 days the model wins.
      h = await refreshHolds(plan, { dir, now: at(7 * day + 1000), look, decisions: {} });
      assertEquals([...h.keys()], [`unit:${unitName}`], "the file's hold expired");
      const ended = the(
        (await listRecords<Hold>("alpha", "hold", dir)).find((r) => r.name === `file:${file.path}`),
      );
      assertStringIncludes(ended.body.ended ?? "", "expired (7 days)");
      // Drift shows what is held, and stops showing it once the hold ended.
      assertEquals(holdEnds(ended.body, {}, at(8 * day)), "expired (7 days): the model wins");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["095-proposals FR-016"],
  "095: archon record: one recording at a time; what changed while it ran is one intent with its reason",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const t = new Date("2026-11-14T14:58:00Z");
      const r = await startRecording("alpha", "nginx for the app", "alice", dir, t);
      assertEquals(r.id, "r-202611141458");
      let err = "";
      try {
        await startRecording("alpha", "another", "bob", dir, t);
      } catch (e) {
        err = (e as Error).message;
      }
      assertStringIncludes(err, "archon record done first");
      const done = await endRecording("alpha", dir, new Date("2026-11-14T15:10:00Z"));
      assertEquals(done.end, "2026-11-14T15:10:00.000Z");
      const recs = await recordings("alpha", dir);
      assertEquals(
        recs.map((x) => x.id),
        ["r-202611141458"],
      );
      const { items, observations } = await driftFixture();
      const intents = groupItems(items, observations, recs);
      const i = the(intents.find((x) => x.id === done.id));
      assertEquals(i.reason, "nginx for the app");
      assert(
        i.items.includes("package:nginx") &&
          i.items.includes("file:/etc/nginx/sites-available/app"),
      );
      // Its reason is the written reason.
      const c = choose(items, intents, { intent: done.id });
      assertEquals(c.reason, "nginx for the app");
      // A modified package binary is an alert, never an item to propose.
      let refused = "";
      try {
        choose(items, intents, { item: "file:/usr/bin/sudo", reason: "x" });
      } catch (e) {
        refused = (e as Error).message;
      }
      assertStringIncludes(refused, "no drift item file:/usr/bin/sudo");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["095-proposals FR-017"],
  "095: reminders: drift not proposed or proposals not decided after 3 days, mailed at most every 3 days",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const host = the((await loadHosts()).find((h) => h.name === "alpha"));
      const items = [
        item("package:nginx", [{ op: "packages.add", name: "nginx" }], {
          at: "2026-11-10T00:00:00Z",
        }),
      ];
      const proposals = [
        {
          id: "p1",
          at: "2026-11-13T00:00:00Z",
          by: "alice",
          reason: "r",
          items: [],
          sent: "queued",
        },
      ];
      const now = new Date("2026-11-14T06:00:00Z");
      const w = waiting({ items, proposals, decisions: {} }, now);
      assertEquals(w, {
        unproposed: 1,
        oldestUnproposed: "2026-11-10T00:00:00Z",
        waiting: 1,
        oldestWaiting: "2026-11-13T00:00:00Z",
        due: true,
      });
      assertStringIncludes(
        waitingLine(w),
        "1 change(s) outside Stolos not proposed (oldest 2026-11-10)",
      );
      assert(
        !waiting(
          {
            items: [],
            proposals,
            decisions: { p1: { decision: "accepted", by: "b", at: "t" } },
          },
          now,
        ).due,
      );
      const sent: Event[] = [];
      const send = (ev: Event) => (sent.push(ev), Promise.resolve("queued"));
      assert(await remind(host, w, dir, now, send));
      assert(
        !(await remind(host, w, dir, new Date(now.getTime() + 86_400_000), send)),
        "not again the next day",
      );
      assert(
        await remind(host, w, dir, new Date(now.getTime() + 4 * 86_400_000), send),
        "again after 3 days",
      );
      assertEquals(sent.length, 2);
      assertStringIncludes(the(sent[0]).event, "reminder");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);
