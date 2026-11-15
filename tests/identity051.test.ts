/**
 * Spec 051: how a machine becomes a host, and the blank-disk guard.
 *
 * @module
 */
import { array, json, object, string } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, proc, serve } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { parseMac } from "../src/archon/fleet/registration.ts";
import { recognition } from "../src/archon/install/recognize.ts";
import {
  describeFacts,
  GUARD_SCRIPT,
  guardDecision,
  parseFacts,
} from "../src/archon-boot/guard.ts";
import { stallMessage, StallWatch } from "../src/archon-boot/stall.ts";

/** A value the test expects to be there: fails the test where it is not. */
function the<T>(value: T | undefined | null): T {
  assertExists(value);
  return value;
}

proves(
  ["051-machine-identity FR-002"],
  "051: MAC addresses in any common spelling, typos refused",
  () => {
    for (const s of [
      "52:54:00:12:34:56",
      "52-54-00-12-34-56",
      "525400123456",
      "5254.0012.3456",
      "52:54:00:12:34:56 ",
    ]) {
      assertEquals(parseMac(s), "52:54:00:12:34:56", s);
    }
    assertEquals(parseMac("52:54:00:AB:CD:EF"), "52:54:00:ab:cd:ef");
    for (const s of ["52:54:00:12:34", "52:54:00:12:34:5g", "52:54-00:12:34:56", "", "olympia"]) {
      assertEquals(parseMac(s), undefined, s);
    }
  },
);

proves(
  ["051-machine-identity FR-001"],
  "051: exactly one of --claim and --mac-address; no default",
  () => {
    const cmd = "bun run stolos host add";
    const none = recognition("olympia", { command: cmd });
    assert("refusal" in none);
    assertStringIncludes(none.refusal, "olympia --claim");
    assertStringIncludes(none.refusal, "olympia --mac-address");
    const both = recognition("olympia", {
      claim: true,
      macAddress: "52:54:00:12:34:56",
      command: cmd,
    });
    assert("refusal" in both && both.refusal.includes("not both"));
    const typo = recognition("olympia", { macAddress: "52:54:00:12:34", command: cmd });
    assert("refusal" in typo && typo.refusal.includes("not a MAC address"));
    assertEquals(recognition("olympia", { claim: true, command: cmd }), { kind: "claim" });
    assertEquals(recognition("olympia", { macAddress: "52-54-00-12-34-56", command: cmd }), {
      kind: "mac",
      mac: "52:54:00:12:34:56",
    });
    // A MAC a person typed is not enough to skip the choice; one its machine reported is.
    const typed = recognition(
      "olympia",
      { command: cmd },
      {
        mac: "52:54:00:12:34:56",
        macSource: "operator",
      },
    );
    assert("refusal" in typed);
    assertEquals(
      recognition(
        "olympia",
        { command: cmd },
        { mac: "52:54:00:12:34:56", macSource: "installed" },
      ),
      { kind: "installed", mac: "52:54:00:12:34:56" },
    );
  },
);

const FACTS = `sys_vendor=Intel Corporation
product_name=NUC12WSHi7
product_serial=G6WS123456
board_vendor=Intel Corporation
board_name=NUC12WSBi7
mem_kib=32617652
cpus=16
disk=nvme0n1 1000204886016 nvme
disk=sda 500107862016 sata`;

proves(["051-machine-identity FR-005"], "051: the machine's facts, as it reports them", () => {
  const f = parseFacts(FACTS);
  assertEquals(f.vendor, "Intel Corporation");
  assertEquals(f.model, "NUC12WSHi7");
  assertEquals(f.serial, "G6WS123456");
  assertEquals(f.disks.length, 2);
  assertEquals(f.signatures, []);
  assertEquals(
    describeFacts(f),
    "Intel Corporation NUC12WSHi7, serial G6WS123456, 16 CPUs, 31.1 GiB RAM, nvme0n1 1.0 TB nvme, sda 500 GB sata",
  );
  // Firmware filler is not a fact.
  const filler = parseFacts(
    "sys_vendor=To Be Filled By O.E.M.\nproduct_serial=Default string\nboard_vendor=ASRock",
  );
  assertEquals(filler.vendor, "ASRock");
  assertEquals(filler.serial, undefined);
});

proves(
  ["051-machine-identity FR-005", "051-machine-identity FR-006"],
  "051: the guard lets blank disks, confirmed erasure, and the same machine through; stops the rest",
  () => {
    const blank = parseFacts(FACTS);
    const used = parseFacts(FACTS + "\nsignature=/dev/sda gpt\nsignature=/dev/sda2 ext4");
    const mac = "52:54:00:12:34:56";
    assertEquals(guardDecision("olympia", blank, {}, mac).go, true);
    const stop = guardDecision("olympia", used, {}, mac);
    assert(!stop.go);
    assertStringIncludes(stop.why, "/dev/sda gpt");
    assertStringIncludes(stop.fix, "--confirm-destroy olympia");
    assertEquals(guardDecision("olympia", used, { confirmDestroy: true }, mac).go, true);
    assertEquals(guardDecision("olympia", used, {}, mac, { mac, macSource: "installed" }).go, true);
    // A typed MAC proves nothing about what the disks hold.
    assertEquals(guardDecision("olympia", used, {}, mac, { mac, macSource: "operator" }).go, false);
    assertEquals(guardDecision("olympia", used, { reinstall: true, mac }, mac).go, true);
    assertEquals(
      guardDecision("olympia", used, { reinstall: true, mac: "52:54:00:00:00:01" }, mac).go,
      false,
    );
    assertEquals(
      guardDecision("olympia", parseFacts("mem_kib=1"), { confirmDestroy: true }, mac).go,
      false,
    );
  },
);

proves(
  ["051-machine-identity FR-005"],
  "051: the guard script is valid sh, reports facts, and fails closed",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const script = `${dir}/guard.sh`;
      await fs.writeTextFile(script, GUARD_SCRIPT);
      const n = await proc.run(["sh", "-n", script]);
      assert(n.success, n.stderr);
      // A fake boot server: records the facts, answers ok.
      let posted = "";
      const ac = new AbortController();
      const server = await serve({ port: 0, signal: ac.signal }, async (req) => {
        posted = await req.text();
        return new Response(new URL(req.url).pathname.endsWith("/facts") ? "ok\n" : "no\n");
      });
      const base = `http://127.0.0.1:${server.addr.port}/install/x/t/`;
      const ok = await proc.output(["sh", script, base], { stdout: "null", stderr: "null" });
      assert(ok.success);
      assertStringIncludes(posted, "mem_kib=");
      assertStringIncludes(posted, "cpus=");
      // Every disk this machine has is reported (a virtio or NVMe disk's major is
      // assigned at boot: the guard must not filter by it).
      const here = await proc.run(["lsblk", "-dnro", "NAME,TYPE"]).then(
        (o) => o.stdout,
        () => "",
      );
      for (const l of here.split("\n")) {
        const [name = "", type] = l.split(" ");
        if (type === "disk" && !name.startsWith("zram")) {
          assertStringIncludes(posted, `disk=${name} `);
        }
      }
      // A disk with partitions is never reported blank.
      const parts = await proc.run(["lsblk", "-nrpo", "NAME,TYPE"]).then(
        (o) => o.stdout,
        () => "",
      );
      for (const l of parts.split("\n")) {
        const [name = "", type] = l.split(" ");
        if (type === "part") assertStringIncludes(posted, `signature=${name} `);
      }
      ac.abort();
      await server.finished;
      // No server: it must not exit 0 (the installer would go on). Its poweroff is
      // replaced so the test machine stays up.
      const failing = GUARD_SCRIPT.replace("poweroff -f", "exit 3").replace("sleep 30", "true");
      await fs.writeTextFile(script, failing);
      const closed = await proc.output(["sh", script, "http://127.0.0.1:9/"], {
        stdout: "null",
        stderr: "null",
      });
      assertEquals(closed.code, 3);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["051-machine-identity FR-007"],
  "051: a machine that takes the image and goes quiet is named, with the fix",
  () => {
    const fired: string[] = [];
    const timers = new Map<number, () => void>();
    let next = 1;
    const w = new StallWatch(
      (a) => fired.push(a),
      1000,
      (f) => (timers.set(next, f), next++),
      (id) => timers.delete(id as number),
    );
    w.imageServed("10.0.0.5");
    w.imageServed("10.0.0.6");
    w.heard("10.0.0.6"); // its installer asked for its configuration
    for (const f of timers.values()) f();
    assertEquals(fired, ["10.0.0.5"]);
    assertStringIncludes(stallMessage("olympia"), "8 GiB");
    assertStringIncludes(stallMessage("olympia"), "host bootstrap olympia");
  },
);

proves(
  ["051-machine-identity FR-005"],
  "051: the installer runs the guard first, before anything touches a disk",
  async () => {
    const { userData } = await import("../src/archon/render/autoinstall.ts");
    const { fleet, host } = await import("./fixtures.ts");
    const text = userData(
      { fleet: fleet(), host: host(), base: "http://10.0.0.1:8080/install/alpha/tok/" },
      { passwordHash: "$6$x$y" },
    );
    const cfg = json(
      text.replace(/^#cloud-config\n/, ""),
      object({ autoinstall: object({ "early-commands": array(string) }) }),
    );
    assert(cfg.kind === "ok", text);
    const early = cfg.value.autoinstall["early-commands"];
    assertStringIncludes(the(early[0]), "install/alpha/tok/guard.sh");
    assertStringIncludes(the(early[0]), "poweroff -f");
  },
);

proves(
  ["051-machine-identity FR-008"],
  "051: bootstrap reads the machine first, and refuses the wrong release or the wrong machine",
  async () => {
    const { BOOTSTRAP_FACTS, parseBootstrapFacts, bootstrapRefusal } =
      await import("../src/archon/install/host-bootstrap.ts");
    // The probe is valid sh and runs here (any Linux).
    const out = await proc.run(["sh", "-c", BOOTSTRAP_FACTS]);
    assert(out.success, "the probe must exit 0 (bootstrap treats a failure as an error)");
    const here = parseBootstrapFacts(out.stdout);
    assert(here.versionId !== undefined || here.summary.includes("Ubuntu"));
    const f = parseBootstrapFacts(
      "version_id=26.04\nhostname=ubuntu\nsys_vendor=QEMU\nproduct_name=Standard PC\nmem_kib=4029000\ncpus=2\nuplink=52:54:00:12:34:56\nnic=52:54:00:12:34:56\n",
    );
    assertEquals(f.uplink, "52:54:00:12:34:56");
    assertEquals(f.summary, "QEMU Standard PC, Ubuntu 26.04, 2 CPUs, 3.8 GiB RAM");
    assertEquals(bootstrapRefusal("e2e", f, "26.04"), undefined);
    assertEquals(bootstrapRefusal("e2e", f, "26.04", "52:54:00:12:34:56"), undefined);
    assertStringIncludes(the(bootstrapRefusal("e2e", f, "28.04")), "Ubuntu 28.04");
    assertStringIncludes(
      the(bootstrapRefusal("e2e", f, "26.04", "52:54:00:00:00:99")),
      "--mac-address 52:54:00:12:34:56",
    );
  },
);

proves(
  ["051-machine-identity FR-009"],
  "051: the machine's inventory, from itself; its registered card is checked",
  async () => {
    const { collectInventory } = await import("../src/archon/state/inventory.ts");
    const inv = await collectInventory();
    assert(inv.cpus >= 1);
    assert(Array.isArray(inv.disks) && Array.isArray(inv.macs));
    const { registeredCardCheck } = await import("../src/archon/model/identity-check.ts");
    const c = registeredCardCheck("52:54:00:12:34:56");
    assertEquals(c.level, "warn");
    assertStringIncludes(c.command, "52:54:00:12:34:56");
    const { platform } = await import("../src/archon/capabilities/platform.ts");
    const { fleet, host } = await import("./fixtures.ts");
    const registered = platform()({
      host: host({
        registration: {
          sshHostKeys: [],
          mac: "52:54:00:12:34:56",
          macSource: "installed",
          added: "2026-01-01",
        },
      }),
      fleet: fleet(),
      users: [],
    });
    assert(registered.checks?.some((x) => x.name === "identity:registered-network-card"));
    const typed = platform()({ host: host(), fleet: fleet(), users: [] });
    assert(!typed.checks?.some((x) => x.name === "identity:registered-network-card"));
  },
);

proves(
  ["051-machine-identity FR-005"],
  "051: the guard's probe finds a partition table that udev has not seen (a disk image)",
  async () => {
    const probe = "wipefs -n --noheadings -O DEVICE,TYPE";
    assertStringIncludes(GUARD_SCRIPT, probe);
    const dir = await fs.makeTempDir();
    try {
      const img = `${dir}/disk.raw`;
      const blank = `${dir}/blank.raw`;
      const mbr = new Uint8Array(512);
      // One partition (Linux, from sector 2048) and the boot signature.
      mbr.set([0, 0, 0, 0, 0x83, 0, 0, 0, 0x00, 0x08, 0, 0, 0xa0, 0x86, 0x01, 0], 446);
      mbr[510] = 0x55;
      mbr[511] = 0xaa;
      for (const f of [img, blank]) {
        const h = await fs.open(f, { create: true, write: true });
        await h.truncate(64 * 1024 * 1024);
        h.close();
      }
      const h = await fs.open(img, { write: true });
      await h.write(mbr);
      h.close();
      const run = async (f: string): Promise<string> =>
        (await proc.run(["sh", "-c", `${probe} ${f}`])).stdout;
      assertStringIncludes(await run(img), "dos");
      assertEquals((await run(blank)).trim(), "");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);
