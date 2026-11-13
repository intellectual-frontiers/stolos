// Spec 002: every validation rule has a failing and a passing example.

import { assert, assertEquals } from "./assert.ts";
import { findSecret, validateFleet, validatePlan } from "../src/archon/model/validate.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { foundation } from "../src/archon/capabilities/mod.ts";
import { fleet, host, KEY } from "./fixtures.ts";

const where = (ps: { where: string; message: string }[]) =>
  ps.map((p) => `${p.where}: ${p.message}`);
const SPECS = new Set(
  [...Deno.readDirSync(new URL("../specs", import.meta.url))].map((e) => e.name),
);

Deno.test("a valid fleet and host pass", () => {
  assertEquals(validateFleet(fleet(), [host()]), []);
  assertEquals(validatePlan(resolvePlan(host(), fleet()), SPECS), []);
});

Deno.test("account name, uid, noreply address, and keys are checked", () => {
  const f = fleet();
  f.admin = { ...f.admin, user: "root", uid: 0 };
  f.admin.github = { ...f.admin.github, email: "me@example.com", sshKeys: [] };
  const ps = where(validateFleet(f, []));
  assert(ps.some((p) => p.startsWith("fleet.admin.user")));
  assert(ps.some((p) => p.startsWith("fleet.admin.uid")));
  assert(ps.some((p) => p.startsWith("fleet.admin.github.email")));
  assert(ps.some((p) => p.includes("no SSH public keys")));
});

Deno.test("locale, time zone, and repository slug are checked", () => {
  const ps = where(
    validateFleet(
      fleet({ locale: "en_US", timezone: "Mars/Olympus", repository: { slug: "nope", url: "" } }),
      [],
    ),
  );
  assertEquals(ps.length, 3);
});

Deno.test("host names and MACs are well formed and unique", () => {
  const ps = where(
    validateFleet(fleet(), [
      host({ name: "Alpha_1", mac: "1C-83-41-30-25-F2" }),
      host({ name: "rome" }),
      host({ name: "rome", mac: "aa:bb:cc:dd:ee:ff" }),
    ]),
  );
  assert(ps.some((p) => p.includes("not a valid host name")));
  assert(ps.some((p) => p.includes("aa:bb:cc:dd:ee:ff form")));
  assert(ps.some((p) => p.includes("used twice")));
});

Deno.test("a MAC is optional; boot server path names are reserved", () => {
  assertEquals(validateFleet(fleet(), [host({ mac: undefined })]), []);
  const ps = where(validateFleet(fleet(), [host({ name: "hosts", mac: undefined })]));
  assert(ps.some((p) => p.includes("boot server uses")));
});

Deno.test("unknown specs, bad modes, and missing verify commands are caught", () => {
  const h = host({
    capabilities: [() => ({
      spec: "099-nope",
      files: [{ path: "etc/x", content: "", mode: "644", owner: "root", spec: "099-nope" }],
      units: [{ unitName: "x", managed: false, state: "ignore", verify: "", spec: "099-nope" }],
      ports: [{ port: 70000, protocol: "tcp", spec: "099-nope" }],
    })],
  });
  const ps = where(validatePlan(resolvePlan(h, fleet()), SPECS));
  assert(ps.some((p) => p.includes("specs/099-nope/ does not exist")));
  assert(ps.some((p) => p.includes("not an absolute path")));
  assert(ps.some((p) => p.includes("four octal digits")));
  assert(ps.some((p) => p.includes("no unit suffix")));
  assert(ps.some((p) => p.includes("no verify command")));
  assert(ps.some((p) => p.includes("out of range")));
});

Deno.test("secrets are refused in the model and in rendered files", () => {
  assertEquals(findSecret("-----BEGIN OPENSSH PRIVATE KEY-----"), "a private key");
  assertEquals(findSecret("ghp_" + "a".repeat(36)), "a GitHub token");
  assertEquals(findSecret("$6$saltsalt$" + "x".repeat(40)), "a password hash");
  assertEquals(findSecret(KEY), undefined);
  const f = fleet({ title: "token ghp_" + "b".repeat(36) });
  assert(where(validateFleet(f, [])).some((p) => p.includes("contains a GitHub token")));
});

Deno.test("conflicting definitions fail; identical ones merge", () => {
  const same = () => ({
    spec: "001-platform" as const,
    packages: [{ name: "git", spec: "001-platform" as const }],
  });
  const plan = resolvePlan(host({ capabilities: [...foundation(), same] }), fleet());
  assertEquals(plan.packages.filter((p) => p.name === "git").length, 1);
  const clash = () => ({
    spec: "001-platform" as const,
    files: [{
      path: "/etc/archon/host",
      content: "other\n",
      mode: "0644",
      owner: "root",
      spec: "001-platform" as const,
    }],
  });
  let threw = false;
  try {
    resolvePlan(host({ capabilities: [...foundation(), clash] }), fleet());
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("every host has the admin and ops accounts", () => {
  const plan = resolvePlan(host(), fleet());
  assertEquals(plan.users.map((u) => u.name), ["alice", "ops"]);
  assertEquals(plan.users[0].sshKeys, [KEY]);
});

Deno.test("a package with its maintainers' PPA refines the same package without one", () => {
  const plan = resolvePlan(host(), fleet());
  const git = plan.packages.filter((p) => p.name === "git");
  assertEquals(git.length, 1);
  assertEquals(git[0].ppa, "git-core/ppa");
  const unattended = plan.files.find((f) => f.path === "/etc/apt/apt.conf.d/52archon-ppas")!;
  assert(unattended.content!.includes('"LP-PPA-git-core:${distro_codename}";'));
  assert(unattended.content!.includes('"LP-PPA-fish-shell-release-4:${distro_codename}";'));
});

Deno.test("gh comes from GitHub's apt repository with its pinned key; Ubuntu's -updates install daily", async () => {
  const { GITHUB_CLI_KEY_FINGERPRINT } = await import("../src/archon/tools/keys/github-cli.ts");
  assertEquals(GITHUB_CLI_KEY_FINGERPRINT, "7F38BBB59D064DBCB3D84D725612B36462313325");
  const plan = resolvePlan(host(), fleet());
  const gh = plan.packages.find((p) => p.name === "gh")!;
  assertEquals(gh.repo, "github-cli");
  const repo = plan.aptRepos.find((r) => r.id === "github-cli")!;
  assert(repo.key.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----"));
  const ppas = plan.files.find((f) => f.path === "/etc/apt/apt.conf.d/52archon-ppas")!;
  assert(ppas.content!.includes('"site=cli.github.com";'));
  const updates = plan.files.find((f) => f.path === "/etc/apt/apt.conf.d/52archon-updates")!;
  assert(updates.content!.includes('"${distro_id}:${distro_codename}-updates";'));
});

Deno.test("a workstation gets only the user-level parts, for its own account", async () => {
  const { workstation } = await import("../src/archon/capabilities/mod.ts");
  const ws = {
    ...host(),
    name: "pc",
    kind: "workstation" as const,
    user: "alice",
    mac: undefined,
    disk: undefined,
    capabilities: workstation(),
    spec: "020-workstation" as const,
  };
  assertEquals(validateFleet(fleet(), [ws]), []);
  const plan = resolvePlan(ws, fleet());
  assertEquals(plan.users.map((u) => u.name), ["alice"]);
  const paths = plan.files.map((f) => f.path);
  assert(paths.includes("/usr/local/bin/archon"));
  assert(paths.includes("/etc/apt/apt.conf.d/52archon-updates"));
  assert(
    !paths.some((p) =>
      p.startsWith("/home/ops") || p.startsWith("/etc/ssh/") || p.startsWith("/etc/ufw")
    ),
  );
  assertEquals(plan.packages.find((p) => p.name === "git")?.ppa, "git-core/ppa");
  // The agent layer is the workstation's own MCP client (spec 030): Archon installs none.
  assert(!plan.tools.some((t) => t.source === "self-updating"));
  const bad = where(
    validateFleet(fleet(), [{
      ...ws,
      mac: "aa:bb:cc:dd:ee:ff",
      guests: [{ name: "g", kind: "container", image: "ubuntu:26.04", data: "ephemeral" }],
    }]),
  );
  assert(bad.some((p) => p.includes("no mac")) && bad.some((p) => p.includes("no guests")));
});

Deno.test("SSH: keys from anywhere, passwords too from local networks; [] means keys only", async () => {
  const { sshdConfig, LOCAL_NETWORKS } = await import("../src/archon/capabilities/ssh.ts");
  const lan = sshdConfig(LOCAL_NETWORKS);
  assert(lan.startsWith("PermitRootLogin no\nPasswordAuthentication no\n"));
  assert(
    lan.includes("Match Address 10.0.0.0/8,172.16.0.0/12,10.0.0.0/16,fc00::/7,fe80::/10\n"),
  );
  assert(lan.trimEnd().endsWith("AuthenticationMethods publickey password"));
  assert(!sshdConfig([]).includes("Match"));
  const plan = resolvePlan(host(), { ...fleet(), ssh: { passwordFrom: ["10.0.30.0/24"] } });
  const f = plan.files.find((x) => x.path === "/etc/ssh/sshd_config.d/50-archon.conf")!;
  assert(f.content!.includes("Match Address 10.0.30.0/24\n"));
  const bad = where(validateFleet({ ...fleet(), ssh: { passwordFrom: ["lan"] } }, [host()]));
  assert(bad.some((p) => p.includes("not a network in CIDR form")));
});

Deno.test("observability: ephemeral limits rendered natively; Collector local only", async () => {
  const { collectorConfig, DEFAULT_OBSERVABILITY } = await import(
    "../src/archon/capabilities/observability.ts"
  );
  const plan = resolvePlan(host(), { ...fleet(), observability: { metricsDays: 90 } });
  const file = (p: string) => plan.files.find((f) => f.path === p)?.content ?? "";
  assert(file("/etc/systemd/journald.conf.d/50-archon.conf").includes("MaxRetentionSec=3month"));
  assert(file("/etc/default/pmlogger_timers").includes('PMLOGGER_DAILY_PARAMS="-E -k 90"'));
  assert(file("/etc/pcp/pmproxy/pmproxy.options").includes("-i 127.0.0.1"));
  const cfg = JSON.parse(
    collectorConfig(host(), fleet(), DEFAULT_OBSERVABILITY).replace(/^#.*\n/, ""),
  );
  assertEquals(cfg.receivers.otlp.protocols.http.endpoint, "127.0.0.1:4318");
  assertEquals(cfg.exporters.file.rotation.max_days, 7);
  assert(plan.units.some((u) => u.unitName === "archon-otelcol.service"));
  assert(plan.tools.some((t) => t.id === "otelcol") && plan.tools.some((t) => t.id === "btop"));
});

Deno.test("observe prune: oldest first, over the size limit or below the free floor, never the newest", async () => {
  const { pruneChoice, parseSize } = await import("../src/archon/observe/observe.ts");
  const a = (base: string, bytes: number) => ({ dir: "/d", base, files: [], bytes });
  const arch = [
    a("20260101", 100),
    a("20260102", 100),
    a("20260103", 100),
    a("20260104.00.10", 50),
  ];
  assertEquals(pruneChoice(arch, 1000, 50, 15, 10000).length, 0);
  assertEquals(pruneChoice(arch, 260, 50, 15, 10000).map((x) => x.base), ["20260101"]);
  // Low disk: drop until the floor is met (each archive frees 1% of a 10 000-byte disk).
  assertEquals(pruneChoice(arch, 1000, 13.5, 15, 10000).map((x) => x.base), [
    "20260101",
    "20260102",
  ]);
  assertEquals(pruneChoice([a("20260104.00.10", 5000)], 10, 1, 15, 10000), []);
  assertEquals(parseSize("2G"), 2 * 1024 ** 3);
  assertEquals(parseSize("512M"), 512 * 1024 ** 2);
});

Deno.test("discovery by unicast DNS only; forwarding config bounded and merged by name", async () => {
  const { centralConfig, DEFAULT_COLLECTOR_NAME } = await import(
    "../src/archon/observe/discover.ts"
  );
  assertEquals(DEFAULT_COLLECTOR_NAME, "otel.localdomain");
  const cfg = JSON.parse(
    centralConfig("http://otel.localdomain:4318", ["kernel.all.load"]).replace(/^#.*\n/, ""),
  );
  assertEquals(cfg.exporters["otlphttp/central"].endpoint, "http://otel.localdomain:4318");
  assertEquals(cfg.exporters["otlphttp/central"].sending_queue.storage, "file_storage");
  assertEquals(cfg.receivers["prometheus/pcp"].config.scrape_configs[0].params.names, [
    "kernel.all.load",
  ]);
  // Only new names: the base config's pipelines (traces, metrics, logs) stay as they are.
  assert(Object.keys(cfg.service.pipelines).every((k) => k.includes("/")));
  const plan = resolvePlan(host(), fleet());
  assert(plan.units.some((u) => u.unitName === "archon-observe-discover.timer"));
});

Deno.test("Article 20: no mDNS or LLMNR; avahi masked, not removed; resolved explicit; verified", () => {
  const plan = resolvePlan(host(), fleet());
  assert(!plan.packages.some((p) => p.name.startsWith("avahi")));
  assert(!plan.ports.some((p) => p.port === 5353 || p.port === 5355));
  for (const u of ["avahi-daemon.service", "avahi-daemon.socket"]) {
    assertEquals(plan.units.find((x) => x.unitName === u)?.state, "masked");
  }
  const resolved = plan.files.find((f) =>
    f.path === "/etc/systemd/resolved.conf.d/50-archon.conf"
  )!;
  assert(resolved.content!.includes("MulticastDNS=no") && resolved.content!.includes("LLMNR=no"));
  for (
    const c of ["names:no-multicast-listeners", "names:avahi-masked", "names:resolved-no-multicast"]
  ) {
    assert(plan.checks.some((x) => x.name === c));
  }
  const ufw = plan.files.find((f) => f.path === "/etc/ufw/applications.d/archon")!.content!;
  assert(!/5353|5355/.test(ufw));
  // The validator refuses them even if a capability asks.
  const bad = resolvePlan(
    host({
      capabilities: [
        ...host().capabilities,
        () => ({
          spec: "008-firewall",
          ports: [{ port: 5353, protocol: "udp", spec: "008-firewall" }],
        }),
      ],
    }),
    fleet(),
  );
  assert(
    validatePlan(bad, new Set(["001-platform", "008-firewall", "004-install"])).some((p) =>
      p.message.includes("mDNS")
    ),
  );
});

Deno.test("every sysusers file is valid for systemd-sysusers (no colon in a GECOS field)", async () => {
  const { foundation } = await import("../src/archon/capabilities/mod.ts");
  const web = { ...fleet(), web: { domain: "lab.example.net" } };
  const plan = resolvePlan(host({ capabilities: foundation() }), web);
  const files = plan.files.filter((f) => f.path.startsWith("/etc/sysusers.d/"));
  assert(files.length >= 2);
  for (const f of files) {
    for (const line of f.content!.split("\n").filter((l) => /^[ugm] /.test(l))) {
      const gecos = line.match(/"([^"]*)"/)?.[1] ?? "";
      assert(!/[:\n]/.test(gecos), `${f.path}: ${line}`);
      assert(/^[ugm] [a-z_][a-z0-9_-]*\s/.test(line), `${f.path}: ${line}`);
    }
  }
});
