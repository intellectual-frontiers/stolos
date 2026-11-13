// Specs 003-005: password hash, install tokens, GRUB menus, autoinstall config.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { sha512Crypt } from "../src/archon/core/crypt.ts";
import { liveToken } from "../src/archon/core/secrets.ts";
import { chooserMenu, hostMenu, mainMenu } from "../src/archon-boot/grub.ts";
import { firstBootScript, userData } from "../src/archon/render/autoinstall.ts";
import { fleet, host } from "./fixtures.ts";

Deno.test("SHA-512 crypt matches glibc's reference vector", async () => {
  assertEquals(
    await sha512Crypt("Hello world!", "saltstring"),
    "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
  );
});

Deno.test("an install token lives until done, or two hours after first use", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const t = { host: "alpha", token: "x", armed: "2026-11-10T10:00:00Z" };
  assert(liveToken([t], "alpha", now));
  assertEquals(liveToken([{ ...t, done: "2026-11-10T11:00:00Z" }], "alpha", now), undefined);
  assertEquals(liveToken([{ ...t, firstUse: "2026-11-10T09:00:00Z" }], "alpha", now), undefined);
  assert(liveToken([{ ...t, firstUse: "2026-11-10T11:30:00Z" }], "alpha", now));
  assertEquals(liveToken([t], "rome", now), undefined);
});

Deno.test("GRUB: dispatch by MAC; unarmed hosts boot their own disk", () => {
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

Deno.test("GRUB: an unknown machine gets armed hosts, but boots its disk by default", () => {
  const none = chooserMenu([], "http://10.0.0.5:8080/");
  assert(!none.includes("linux /boot/linux"));
  const menu = chooserMenu([{ host: host(), token: "tok" }], "http://10.0.0.5:8080/");
  assertStringIncludes(menu, "set default=0");
  const first = menu.indexOf("menuentry");
  assertStringIncludes(menu.slice(first, menu.indexOf("\n}", first)), "exit");
  assertStringIncludes(menu, "Archon: install alpha");
});

Deno.test("autoinstall network: the model's MAC, else the boot NIC, else every wired port", () => {
  const net = (h: ReturnType<typeof host>, bootMac?: string) =>
    JSON.parse(
      userData({ fleet: fleet(), host: h, base: "http://x/", bootMac }, { passwordHash: "x" })
        .slice("#cloud-config\n".length),
    ).autoinstall.network.ethernets.uplink.match;
  const bare = { ...host(), mac: undefined };
  assertEquals(net(host(), "52:54:00:00:00:01"), { macaddress: "1c:83:41:30:25:f2" });
  assertEquals(net(bare, "52:54:00:00:00:01"), { macaddress: "52:54:00:00:00:01" });
  assertEquals(net(bare), { name: "en*" });
});

Deno.test("autoinstall config: identity, keys, netplan by MAC, first boot, done callback", () => {
  const u = userData(
    { fleet: fleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
    {
      passwordHash: "$6$abc$def",
      deployKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
    },
  );
  assert(u.startsWith("#cloud-config\n"));
  const ai = JSON.parse(u.slice("#cloud-config\n".length)).autoinstall;
  assertEquals(ai.identity.username, "alice");
  assertEquals(ai.identity.hostname, "alpha");
  assertEquals(ai.ssh["allow-pw"], false);
  assertEquals(ai.ssh["authorized-keys"].length, 1);
  assertEquals(ai.network.ethernets.uplink.match.macaddress, "1c:83:41:30:25:f2");
  assertEquals(ai.storage.layout.name, "lvm");
  assert(
    ai["late-commands"].some((c: string) =>
      c.includes("http://10.0.0.5:8080/install/alpha/tok/done")
    ),
  );
  const files = ai["user-data"].write_files.map((f: { path: string }) => f.path);
  assert(files.includes("/etc/archon/deploy_key"));
  assert(files.includes("/usr/local/sbin/archon-first-boot"));
});

Deno.test("first boot clones over SSH with a key, HTTPS without, then hands over to TypeScript", () => {
  const s = firstBootScript(fleet(), host());
  assertStringIncludes(s, "git clone -q -b main git@github.com:example/fleet.git /srv/archon");
  assertStringIncludes(s, "git clone -q -b main https://github.com/example/fleet.git /srv/archon");
  assertStringIncludes(s, "/srv/archon/archon.ts first-boot --host alpha");
  assertStringIncludes(s, "sha256sum");
});

Deno.test("the ufw profile lists every modeled port", async () => {
  const { resolvePlan } = await import("../src/archon/model/resolve.ts");
  const plan = resolvePlan(
    host({
      capabilities: [
        ...(await import("../src/archon/capabilities/mod.ts")).foundation(),
        () => ({
          spec: "008-firewall",
          ports: [{ port: 443, protocol: "tcp", spec: "008-firewall" }, {
            port: 51820,
            protocol: "udp",
            spec: "008-firewall",
          }],
        }),
      ],
    }),
    fleet(),
  );
  const f = plan.files.find((x) => x.path === "/etc/ufw/applications.d/archon")!;
  assertStringIncludes(
    f.content!,
    "[Archon]\ntitle=Archon host\ndescription=Ports in this host's Archon model, open to every network\nports=22,80,443/tcp|443,51820/udp\n",
  );
  // Cockpit (spec 022) is open to the local networks only, one ufw rule per network.
  assertStringIncludes(f.content!, "[Archon-LAN]");
  assertStringIncludes(f.content!, "ports=445,9090/tcp");
  const rules = f.onChange!.filter((a) => a.kind === "run" && a.argv.includes("Archon-LAN"));
  assert(
    rules.some((a) =>
      a.kind === "run" && a.argv.join(" ") === "ufw allow from 10.0.0.0/16 to any app Archon-LAN"
    ),
  );
});

Deno.test("arming and finishing an install forget the host's old SSH host keys", async () => {
  const { forgetHostKeys } = await import("../src/archon/install/host-keys.ts");
  const dir = await Deno.makeTempDir();
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ5+FnSZ/1oDYPNXlHD6GuAN8ZsB0uSKnQR4jZS8s8cB";
  const file = `${dir}/known_hosts`;
  await Deno.writeTextFile(file, `alpha ${key}\n10.0.30.57 ${key}\nrome ${key}\n`);
  const gone = await forgetHostKeys(["alpha", "10.0.30.57", "10.9.9.9"], file);
  assertEquals(gone, ["alpha", "10.0.30.57"]);
  assertEquals((await Deno.readTextFile(file)).trim(), `rome ${key}`);
  assertEquals(await forgetHostKeys(["alpha"], `${dir}/missing`), []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("install config: the host's own SSH host keys, progress reporting, no agent token, netboot entry", () => {
  const u = userData(
    { fleet: fleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
    {
      passwordHash: "$6$abc$def",
      hostKeys: [{ type: "ed25519", private: "PRIVATE\n", public: "ssh-ed25519 AAAA" }],
    },
  );
  const ai = JSON.parse(u.slice("#cloud-config\n".length)).autoinstall;
  const ci = ai["user-data"];
  assertEquals(ci.ssh_keys, { ed25519_private: "PRIVATE\n", ed25519_public: "ssh-ed25519 AAAA" });
  assertEquals(ci.ssh_genkeytypes, undefined);
  assertEquals(ai.reporting.archon.endpoint, "http://10.0.0.5:8080/install/alpha/tok/event");
  const files = ci.write_files.map((f: { path: string }) => f.path);
  // Spec 030: no AI credential reaches a server.
  assert(!files.some((f: string) => /claude/i.test(f)));
  assert(!/claude/i.test(u));
  assert(files.includes("/etc/archon/boot-events"));
  assert(ai["late-commands"].some((c: string) => c.includes("/target/etc/archon/netboot-entry")));
});

Deno.test("progress: installer milestones once each, failures always, first-boot phases", async () => {
  const { describe } = await import("../src/archon-boot/progress.ts");
  const seen = new Set<string>();
  const start = (name: string) => describe({ event_type: "start", name }, seen);
  assertEquals(
    start(
      "subiquity/Install/install/curtin_install/run_curtin_step/cmd-install/stage-partitioning",
    ),
    "installer: partitioning the disk",
  );
  assertEquals(
    start(
      "subiquity/Install/install/curtin_install/run_curtin_step/cmd-install/stage-partitioning/x",
    ),
    undefined,
  );
  assertEquals(start("subiquity/Load_keyboard"), undefined);
  assert(
    describe({ event_type: "finish", name: "x", description: "extract", result: "FAIL" }, seen)!
      .startsWith("✗"),
  );
  assertEquals(
    describe({ origin: "archon", phase: "Tools", level: "ok", summary: "8 tools" }, seen),
    "✓ Tools: 8 tools",
  );
});

Deno.test("reboot --netboot: the recorded entry, else the first IPv4 PXE entry", async () => {
  const { parseEfibootmgr, pickNetbootEntry } = await import("../src/archon/install/netboot.ts");
  const out =
    "BootCurrent: 0001\nBootOrder: 0001,0003,0004\nBoot0001* ubuntu\tHD(1,GPT)\nBoot0003* UEFI PXE IPv6 Realtek\tPciRoot\nBoot0004* UEFI PXE IPv4 Realtek\tPciRoot\n";
  const { current, entries } = parseEfibootmgr(out);
  assertEquals(current, "0001");
  assertEquals(entries.map((e) => e.id), ["0001", "0003", "0004"]);
  assertEquals(pickNetbootEntry(entries, "0003\n")?.id, "0003");
  assertEquals(pickNetbootEntry(entries)?.id, "0004");
  assertEquals(pickNetbootEntry(entries, "0009")?.id, "0004");
  assertEquals(pickNetbootEntry([{ id: "0001", label: "ubuntu" }]), undefined);
});

Deno.test("trustHost replaces a host's entries with its real keys for every name", async () => {
  const { trustHost } = await import("../src/archon/install/host-keys.ts");
  const dir = await Deno.makeTempDir();
  const file = `${dir}/known_hosts`;
  await Deno.writeTextFile(
    file,
    "alpha ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ5+FnSZ/1oDYPNXlHD6GuAN8ZsB0uSKnQR4jZS8s8cB\n" +
      "rome ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ5+FnSZ/1oDYPNXlHD6GuAN8ZsB0uSKnQR4jZS8s8cB\n",
  );
  const keys = [{ public: "ssh-ed25519 AAAAnew" }, { public: "ssh-rsa AAAAnew" }];
  const names = await trustHost("alpha", ["10.1.2.3"], file, keys);
  assertEquals(names, ["alpha", "10.1.2.3"]);
  const text = await Deno.readTextFile(file);
  assert(text.startsWith("rome "));
  assert(text.includes("alpha,10.1.2.3 ssh-ed25519 AAAAnew\nalpha,10.1.2.3 ssh-rsa AAAAnew\n"));
  assert(!text.includes("alpha ssh-ed25519 AAAAC3"));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("boot observe: installs and their steps from OTLP JSON lines", async () => {
  const { installsFrom } = await import("../src/archon-boot/observe.ts");
  const span = (id: string, name: string, s: number, e: number, parent?: string, err = false) => ({
    traceId: "t1",
    spanId: id,
    ...(parent ? { parentSpanId: parent } : {}),
    name,
    startTimeUnixNano: String(s * 1e9),
    endTimeUnixNano: String(e * 1e9),
    status: { code: err ? 2 : 1 },
  });
  const line = (spans: unknown[]) =>
    JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
  const lines = [
    line([
      span("a", "network boot", 100, 105, "r"),
      span("b", "partitioning the disk", 105, 160, "r", true),
    ]),
    "not json",
    line([span("r", "install alpha", 100, 400)]),
  ];
  const [i] = installsFrom(lines);
  assertEquals(i.name, "alpha");
  assertEquals(i.seconds, 300);
  assertEquals(i.steps.map((s) => s.name), ["network boot", "partitioning the disk"]);
  assertEquals(i.steps[1].ok, false);
});

Deno.test("a changed firewall profile reaches the running firewall (ufw reload)", async () => {
  const { resolvePlan } = await import("../src/archon/model/resolve.ts");
  const plan = resolvePlan(host(), fleet());
  const f = plan.files.find((x) => x.path === "/etc/ufw/applications.d/archon")!;
  const last = f.onChange!.at(-1)!;
  assert(last.kind === "run" && last.argv.join(" ") === "ufw reload");
});
