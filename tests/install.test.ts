/**
 * Specs 003-005: password hash, install tokens, GRUB menus, autoinstall config.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/system";
import {
  assertExists,
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/test";
import { sha512Crypt } from "@intellectual-frontiers/crypto";
import { liveToken } from "../src/archon/core/secrets.ts";
import { chooserMenu, hostMenu, mainMenu } from "../src/archon-boot/grub.ts";
import { firstBootScript, userData } from "../src/archon/render/autoinstall.ts";
import { fleet, host } from "./fixtures.ts";

/** The parts of an autoinstall config these tests read (Ubuntu's installer's format). */
type AutoInstall = {
  identity: { username: string; hostname: string };
  ssh: { "allow-pw": boolean; "authorized-keys": string[] };
  network: { ethernets: { uplink: { match: Record<string, string> } } };
  storage: { layout: { name: string } };
  "late-commands": string[];
  reporting: { archon: { endpoint: string } };
  "user-data": {
    write_files: Array<{ path: string }>;
    ssh_keys?: Record<string, string>;
    ssh_genkeytypes?: unknown;
  };
};

/** The autoinstall section of a rendered user-data file. */
const autoinstall = (u: string): AutoInstall =>
  (JSON.parse(u.slice("#cloud-config\n".length)) as { autoinstall: AutoInstall }).autoinstall;

/** The runtime the engine left (spec 096), spelled in parts so this file does not name it. */
const OLD_RUNTIME = new RegExp(["d", "eno"].join(""), "i");

proves(["003-identity FR-003"], "SHA-512 crypt matches glibc's reference vector", async () => {
  assertEquals(
    await sha512Crypt("Hello world!", "saltstring"),
    "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
  );
});

proves(
  ["004-install FR-004"],
  "an install token lives until done, or two hours after first use",
  () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const t = { host: "alpha", token: "x", armed: "2026-11-10T10:00:00Z" };
    assert(liveToken([t], "alpha", now));
    assertEquals(liveToken([{ ...t, done: "2026-11-10T11:00:00Z" }], "alpha", now), undefined);
    assertEquals(liveToken([{ ...t, firstUse: "2026-11-10T09:00:00Z" }], "alpha", now), undefined);
    assert(liveToken([{ ...t, firstUse: "2026-11-10T11:30:00Z" }], "alpha", now));
    assertEquals(liveToken([t], "rome", now), undefined);
  },
);

proves(["004-install FR-003"], "GRUB: dispatch by MAC; unarmed hosts boot their own disk", () => {
  assertStringIncludes(mainMenu(), "configfile /boot/hosts/${net_default_mac}.cfg");
  const armed = hostMenu(host(), "http://10.0.0.5:8080/", "tok123");
  assertStringIncludes(
    armed,
    "ds=nocloud-net\\;s=http://10.0.0.5:8080/install/alpha/tok123/${net_default_mac}/",
  );
  assertStringIncludes(armed, "iso-url=http://10.0.0.5:8080/iso/");
  assertStringIncludes(armed, " autoinstall ");
  const idle = hostMenu(host(), "http://10.0.0.5:8080/", undefined);
  assertStringIncludes(idle, "exit");
  assert(!idle.includes("linux /boot/linux"));
});

test("GRUB: an unknown machine gets armed hosts, but boots its disk by default", () => {
  const none = chooserMenu([], "http://10.0.0.5:8080/");
  assert(!none.includes("linux /boot/linux"));
  const menu = chooserMenu([{ host: host(), token: "tok" }], "http://10.0.0.5:8080/");
  assertStringIncludes(menu, "set default=0");
  const first = menu.indexOf("menuentry");
  assertStringIncludes(menu.slice(first, menu.indexOf("\n}", first)), "exit");
  assertStringIncludes(menu, "Archon: install alpha");
});

proves(
  ["004-install FR-005"],
  "autoinstall network: the model's MAC, else the boot NIC, else every wired port",
  () => {
    const net = (h: ReturnType<typeof host>, bootMac?: string): unknown =>
      autoinstall(
        userData(
          {
            fleet: fleet(),
            host: h,
            base: "http://x/",
            ...(bootMac === undefined ? {} : { bootMac }),
          },
          { passwordHash: "x" },
        ),
      ).network.ethernets.uplink.match;
    const bare = host({ mac: undefined });
    assertEquals(net(host(), "52:54:00:00:00:01"), { macaddress: "1c:83:41:30:25:f2" });
    assertEquals(net(bare, "52:54:00:00:00:01"), { macaddress: "52:54:00:00:00:01" });
    assertEquals(net(bare), { name: "en*" });
  },
);

proves(
  ["004-install FR-005"],
  "autoinstall config: identity, keys, netplan by MAC, first boot, done callback",
  () => {
    const u = userData(
      { fleet: fleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
      {
        passwordHash: "$6$abc$def",
        deployKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
      },
    );
    assert(u.startsWith("#cloud-config\n"));
    const ai = autoinstall(u);
    assertEquals(ai.identity.username, "alice");
    assertEquals(ai.identity.hostname, "alpha");
    assertEquals(ai.ssh["allow-pw"], false);
    assertEquals(ai.ssh["authorized-keys"].length, 1);
    assertEquals(ai.network.ethernets.uplink.match["macaddress"], "1c:83:41:30:25:f2");
    assertEquals(ai.storage.layout.name, "lvm");
    assert(
      ai["late-commands"].some((c) => c.includes("http://10.0.0.5:8080/install/alpha/tok/done")),
    );
    const files = ai["user-data"].write_files.map((f) => f.path);
    assert(files.includes("/etc/archon/deploy_key"));
    assert(files.includes("/usr/local/sbin/archon-first-boot"));
  },
);

proves(
  ["005-first-boot FR-001", "005-first-boot FR-002"],
  "first boot clones over SSH with a key, HTTPS without, then hands over to TypeScript",
  () => {
    const s = firstBootScript(fleet(), host());
    assertStringIncludes(s, "git clone -q -b main git@github.com:example/fleet.git /srv/archon");
    assertStringIncludes(
      s,
      "git clone -q -b main https://github.com/example/fleet.git /srv/archon",
    );
    assertStringIncludes(
      s,
      "exec /usr/local/bin/bun /srv/archon/archon.ts first-boot --host alpha",
    );
  },
);

proves(
  ["096-bun-runtime FR-007"],
  "096: the first boot installs the pinned Bun, checking its SHA-256 before unpacking, then the engine bun.lock holds",
  async () => {
    const { BUN_SHA256, BUN_VERSION, bunDownload } = await import("../src/archon/core/bun-pin.ts");
    // The pin: one version, a SHA-256 for every platform.
    assert(/^\d+\.\d+\.\d+$/.test(BUN_VERSION), BUN_VERSION);
    for (const [platform, sha] of Object.entries(BUN_SHA256)) {
      assert(/^[0-9a-f]{64}$/.test(sha), platform);
    }
    assertEquals(
      bunDownload("linux-x64").url,
      `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`,
    );
    const s = firstBootScript(fleet(), host());
    assert(!OLD_RUNTIME.test(s), "only Bun in the first boot");
    for (const p of ["linux-x64", "linux-x64-baseline", "linux-aarch64"] as const) {
      assertStringIncludes(s, BUN_SHA256[p]);
    }
    const check = s.indexOf("sha256sum");
    assert(check > 0 && check < s.indexOf("unzip -q -o"), "checked before it is unpacked");
    const install = s.indexOf("bun install --frozen-lockfile");
    assert(install > s.indexOf("verify-commit HEAD"), "the engine of a signed commit only");
    assert(install < s.indexOf("exec /usr/local/bin/bun"), "installed before archon runs");
    // The script is valid shell.
    const sh = await fs.makeTempFile({ suffix: ".sh" });
    await fs.writeTextFile(sh, s);
    const r = await proc.output(["sh", "-n", sh]);
    await fs.remove(sh);
    assert(r.success, "valid shell");
  },
);

proves(["008-firewall FR-001"], "the ufw profile lists every modeled port", async () => {
  const { resolvePlan } = await import("../src/archon/model/resolve.ts");
  const plan = resolvePlan(
    host({
      capabilities: [
        ...(await import("../src/archon/capabilities/mod.ts")).foundation(),
        () => ({
          spec: "008-firewall",
          ports: [
            { port: 443, protocol: "tcp", spec: "008-firewall" },
            {
              port: 51820,
              protocol: "udp",
              spec: "008-firewall",
            },
          ],
        }),
      ],
    }),
    fleet(),
  );
  const f = plan.files.find((x) => x.path === "/etc/ufw/applications.d/archon");
  assertExists(f);
  assertStringIncludes(
    f.content ?? "",
    "[Archon]\ntitle=Archon host\ndescription=Ports in this host's Archon model, open to every network (the router filters)\nports=22,80,443,445,9090/tcp|443,51820/udp\n",
  );
  // No per-network rules on the machine (the router decides who reaches it): one profile.
  assertEquals(f.content?.split("\n").filter((l) => l.startsWith("[")).length, 1, f.content);
  assert(!f.onChange?.some((x) => x.kind === "run" && x.argv.includes("from")));
});

proves(
  ["004-install FR-013"],
  "arming and finishing an install forget the host's old SSH host keys",
  async () => {
    const { forgetHostKeys } = await import("../src/archon/install/host-keys.ts");
    const dir = await fs.makeTempDir();
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ5+FnSZ/1oDYPNXlHD6GuAN8ZsB0uSKnQR4jZS8s8cB";
    const file = `${dir}/known_hosts`;
    await fs.writeTextFile(file, `alpha ${key}\n10.0.30.57 ${key}\nrome ${key}\n`);
    const gone = await forgetHostKeys(["alpha", "10.0.30.57", "10.9.9.9"], file);
    assertEquals(gone, ["alpha", "10.0.30.57"]);
    assertEquals((await fs.readTextFile(file)).trim(), `rome ${key}`);
    assertEquals(await forgetHostKeys(["alpha"], `${dir}/missing`), []);
    await fs.remove(dir, { recursive: true });
  },
);

test("install config: the host's own SSH host keys, progress reporting, no agent token, netboot entry", () => {
  const u = userData(
    { fleet: fleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
    {
      passwordHash: "$6$abc$def",
      hostKeys: [{ type: "ed25519", private: "PRIVATE\n", public: "ssh-ed25519 AAAA" }],
    },
  );
  const ai = autoinstall(u);
  const ci = ai["user-data"];
  assertEquals(ci.ssh_keys, { ed25519_private: "PRIVATE\n", ed25519_public: "ssh-ed25519 AAAA" });
  assertEquals(ci.ssh_genkeytypes, undefined);
  assertEquals(ai.reporting.archon.endpoint, "http://10.0.0.5:8080/install/alpha/tok/event");
  const files = ci.write_files.map((f) => f.path);
  // Spec 030: no AI credential reaches a server.
  assert(!files.some((f) => /claude/i.test(f)));
  assert(!/claude/i.test(u));
  assert(files.includes("/etc/archon/boot-events"));
  assert(ai["late-commands"].some((c) => c.includes("/target/etc/archon/netboot-entry")));
});

proves(
  ["004-install FR-015"],
  "progress: installer milestones once each, failures always, first-boot phases",
  async () => {
    const { describe } = await import("../src/archon-boot/progress.ts");
    const seen = new Set<string>();
    const start = (name: string) => describe({ event_type: "start", name }, seen);
    assertEquals(
      start(
        "subiquity/Install/install/curtin_install/run_curtin_step/cmd-install/stage-partitioning",
      ),
      {
        name: "boot.installer.step",
        message: "installer: partitioning the disk",
        attrs: {
          step: "subiquity/Install/install/curtin_install/run_curtin_step/cmd-install/stage-partitioning",
        },
      },
    );
    assertEquals(
      start(
        "subiquity/Install/install/curtin_install/run_curtin_step/cmd-install/stage-partitioning/x",
      ),
      undefined,
    );
    assertEquals(start("subiquity/Load_keyboard"), undefined);
    assertEquals(
      describe({ event_type: "finish", name: "x", description: "extract", result: "FAIL" }, seen)
        ?.name,
      "boot.installer.failed",
    );
    assertEquals(
      describe({ origin: "archon", phase: "Tools", level: "ok", summary: "8 tools" }, seen),
      {
        name: "boot.firstboot.phase",
        severity: "info",
        message: "Tools: 8 tools",
        attrs: { phase: "Tools" },
      },
    );
    assertEquals(
      describe({ origin: "archon", phase: "Ready", level: "ok", summary: "82/82 checks" }, seen)
        ?.name,
      "boot.ready",
    );
  },
);

proves(
  ["004-install FR-014"],
  "reboot --netboot: the recorded entry, else the first IPv4 PXE entry",
  async () => {
    const { parseEfibootmgr, pickNetbootEntry } = await import("../src/archon/install/netboot.ts");
    const out =
      "BootCurrent: 0001\nBootOrder: 0001,0003,0004\nBoot0001* ubuntu\tHD(1,GPT)\nBoot0003* UEFI PXE IPv6 Realtek\tPciRoot\nBoot0004* UEFI PXE IPv4 Realtek\tPciRoot\n";
    const { current, entries } = parseEfibootmgr(out);
    assertEquals(current, "0001");
    assertEquals(
      entries.map((e) => e.id),
      ["0001", "0003", "0004"],
    );
    assertEquals(pickNetbootEntry(entries, "0003\n")?.id, "0003");
    assertEquals(pickNetbootEntry(entries)?.id, "0004");
    assertEquals(pickNetbootEntry(entries, "0009")?.id, "0004");
    assertEquals(pickNetbootEntry([{ id: "0001", label: "ubuntu" }]), undefined);
  },
);

test("trustHost replaces a host's entries with its real keys for every name", async () => {
  const { trustHost } = await import("../src/archon/install/host-keys.ts");
  const dir = await fs.makeTempDir();
  const file = `${dir}/known_hosts`;
  await fs.writeTextFile(
    file,
    "alpha ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ5+FnSZ/1oDYPNXlHD6GuAN8ZsB0uSKnQR4jZS8s8cB\n" +
      "rome ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ5+FnSZ/1oDYPNXlHD6GuAN8ZsB0uSKnQR4jZS8s8cB\n",
  );
  const keys = [{ public: "ssh-ed25519 AAAAnew" }, { public: "ssh-rsa AAAAnew" }];
  const names = await trustHost("alpha", ["10.1.2.3"], file, keys);
  assertEquals(names, ["alpha", "10.1.2.3"]);
  const text = await fs.readTextFile(file);
  assert(text.startsWith("rome "));
  assert(text.includes("alpha,10.1.2.3 ssh-ed25519 AAAAnew\nalpha,10.1.2.3 ssh-rsa AAAAnew\n"));
  assert(!text.includes("alpha ssh-ed25519 AAAAC3"));
  await fs.remove(dir, { recursive: true });
});

test("boot observe: installs and their steps from OTLP JSON lines", async () => {
  const { installsFrom } = await import("../src/archon-boot/observe.ts");
  // Span names are kinds (spec 096): the install, and each step by its attribute.
  const span = (
    id: string,
    what: string,
    s: number,
    e: number,
    parent?: string,
    err = false,
  ): Record<string, unknown> => ({
    traceId: "t1",
    spanId: id,
    ...(parent ? { parentSpanId: parent } : {}),
    name: parent ? "archon.boot.step" : "archon.boot.install",
    attributes: [
      parent
        ? { key: "archon.boot.step", value: { stringValue: what } }
        : { key: "host.name", value: { stringValue: what } },
    ],
    startTimeUnixNano: String(s * 1e9),
    endTimeUnixNano: String(e * 1e9),
    status: { code: err ? 2 : 1 },
  });
  const line = (spans: unknown[]): string =>
    JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
  const lines = [
    line([
      span("a", "network boot", 100, 105, "r"),
      span("b", "partitioning the disk", 105, 160, "r", true),
    ]),
    "not json",
    line([span("r", "alpha", 100, 400)]),
  ];
  const [i] = installsFrom(lines);
  assertExists(i);
  assertEquals(i.name, "alpha");
  assertEquals(i.seconds, 300);
  assertEquals(
    i.steps.map((s) => s.name),
    ["network boot", "partitioning the disk"],
  );
  assertEquals(i.steps[1]?.ok, false);
});

test("a changed firewall profile reaches the running firewall (ufw reload)", async () => {
  const { resolvePlan } = await import("../src/archon/model/resolve.ts");
  const plan = resolvePlan(host(), fleet());
  const f = plan.files.find((x) => x.path === "/etc/ufw/applications.d/archon");
  assertExists(f);
  const last = f.onChange?.at(-1);
  assertExists(last);
  assert(last.kind === "run" && last.argv.join(" ") === "ufw reload");
});

proves(
  ["046-engine-instance FR-005a"],
  "046: a fleet repository not on GitHub is cloned from its URL",
  async () => {
    const { fleet, host } = await import("./fixtures.ts");
    const { firstBootScript, onGitHub } = await import("../src/archon/render/autoinstall.ts");
    const f = fleet();
    assert(onGitHub(f));
    const local = {
      ...f,
      repository: { slug: "e2e/fleet", url: "http://10.77.0.1:8000/fleet.git" },
    };
    assert(!onGitHub(local));
    const s = firstBootScript(local, host());
    assertStringIncludes(s, "git clone -q -b main http://10.77.0.1:8000/fleet.git /srv/archon");
  },
);

proves(
  ["049-telemetry FR-009"],
  "049: the first boot continues the install's trace, reported to the boot server",
  async () => {
    const { fleet, host } = await import("./fixtures.ts");
    const { firstBootScript, firstBootTelemetry, userData } =
      await import("../src/archon/render/autoinstall.ts");
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const env = firstBootTelemetry({
      fleet: fleet(),
      host: host(),
      base: "http://10.0.1.157:8080/install/alpha/tok/",
      traceparent: tp,
    });
    assertStringIncludes(env, "OTEL_EXPORTER_OTLP_ENDPOINT=http://10.0.1.157:8080/otlp\n");
    assertStringIncludes(env, "OTEL_EXPORTER_OTLP_PROTOCOL=http/json\n");
    assertStringIncludes(env, `TRACEPARENT=${tp}\n`);
    const s = firstBootScript(fleet(), host());
    assert(
      s.indexOf(". /etc/archon/first-boot.env") < s.indexOf("exec /usr/local/bin/bun"),
      "the environment is read before archon runs",
    );
    const ud = userData(
      { fleet: fleet(), host: host(), base: "http://10.0.1.157:8080/i/", traceparent: tp },
      { passwordHash: "x" },
    );
    assertStringIncludes(ud, "/etc/archon/first-boot.env");
  },
);

proves(
  ["063-runnable-before-arm FR-003", "063-runnable-before-arm FR-004"],
  "063: a first boot run again fetches the branch; a refusal says how to recover",
  async () => {
    const { firstBootScript } = await import("../src/archon/render/autoinstall.ts");
    const s = firstBootScript(fleet(), host());
    // Run again after a refusal: the branch as it is now, with the deploy key for git only.
    assertStringIncludes(
      s,
      "git -C /srv/archon fetch -q origin main && git -C /srv/archon reset -q --hard FETCH_HEAD",
    );
    assert(
      s.indexOf("unset GIT_SSH_COMMAND") < s.indexOf("exec /usr/local/bin/bun"),
      "archon gets no deploy-key ssh",
    );
    assert(!/^export GIT_SSH_COMMAND/m.test(s), "never exported for the whole script");
    // The refusal: what to do, on the PC and on the host, in the log and the boot server's window.
    assertStringIncludes(s, "bun run stolos apply");
    assertStringIncludes(s, "sudo /usr/local/sbin/archon-first-boot");
    assert(
      s.indexOf("verify-commit HEAD") > s.indexOf("fetch -q origin"),
      "the commit checked is the one fetched",
    );
    const sh = await fs.makeTempFile({ suffix: ".sh" });
    await fs.writeTextFile(sh, s);
    const r = await proc.output(["bash", "-n", sh]);
    await fs.remove(sh);
    assert(r.success, "valid shell");
  },
);
