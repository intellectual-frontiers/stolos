/**
 * Spec 097: the controller PC as a fleet machine: observed locally by the probe, with its own facts
 * and policies, and no SSH.
 *
 * @module
 */

import { assert, assertEquals, proves } from "@intellectual-frontiers/test";
import { type AdoptedDef, type Observed, probe, toObserved } from "../src/archon/adopt/adopt.ts";
import {
  controllerDef,
  type ControllerFacts,
  controllerFacts,
  controllerName,
  localProbe,
} from "../src/archon/adopt/controller.ts";
import { parseProbe, PROBE_SCRIPT_WINDOWS, PROBE_VERSION } from "../src/archon/adopt/probe.ts";
import { policies } from "../src/archon/adopt/policy.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");

const base: Observed = {
  at: "2026-11-16T11:00:00Z",
  probe: "2",
  os: {
    family: "windows",
    name: "Windows 11 Pro",
    version: "26200",
    kernel: "Windows",
    arch: "AMD64",
    hostname: "ALPHA-PC",
  },
  hardware: {},
  security: {
    diskEncryption: "on",
    firewall: "on",
    autoUpdates: "on",
    antivirus: "on",
    admins: ["alice"],
  },
  software: {},
  listening: [135, 445],
};

const good: ControllerFacts = {
  signingKey: "locked",
  inAgent: false,
  backup: "current",
  backupAt: "2026-11-16T10:00:00Z",
  unbacked: 0,
  recoveryInVault: true,
  recoveryCheckedAt: "2026-11-01T00:00:00Z",
};

const machine: AdoptedDef = {
  name: "alpha-pc",
  role: "controller",
  ssh: { user: "alice", address: "ALPHA-PC" },
  hostKeys: [],
  adopted: "2026-11-16T00:00:00Z",
};

const status = (o: Observed, id: string): string | undefined =>
  policies(machine, o, NOW).find((r) => r.id === id)?.status;

proves(
  ["097-controller FR-002"],
  "097: the probe runs locally on the controller and answers facts",
  async () => {
    const r = await localProbe("facts");
    assert(r.ok, r.err);
    const o = toObserved(parseProbe(r.out));
    assert(o.os.family !== "unknown", "the OS is known");
    assertEquals(o.probe, PROBE_VERSION);
    const v = await localProbe("version");
    assertEquals(v.out.trim(), PROBE_VERSION);
  },
);

proves(
  ["097-controller FR-004"],
  "097: the controller's policies pass on a careful PC and fail where they should",
  () => {
    const ok: Observed = { ...base, controller: good };
    for (const id of [
      "controller-signing-key",
      "controller-backup",
      "controller-recovery-key",
      "controller-no-ssh-server",
    ]) {
      assertEquals(status(ok, id), "pass", id);
    }
    assertEquals(
      status({ ...ok, controller: { ...good, inAgent: true } }, "controller-signing-key"),
      "fail",
    );
    assertEquals(
      status({ ...ok, controller: { ...good, signingKey: "unlocked" } }, "controller-signing-key"),
      "fail",
    );
    assertEquals(
      status(
        { ...ok, controller: { ...good, backup: "behind", unbacked: 2 } },
        "controller-backup",
      ),
      "fail",
    );
    assertEquals(
      status({ ...ok, controller: { ...good, backup: "never", unbacked: 3 } }, "controller-backup"),
      "fail",
    );
    assertEquals(
      status(
        { ...ok, controller: { ...good, recoveryCheckedAt: "2026-01-01T00:00:00Z" } },
        "controller-recovery-key",
      ),
      "fail",
      "checked more than 6 months ago",
    );
    assertEquals(
      status({ ...ok, controller: { ...good, recoveryInVault: false } }, "controller-recovery-key"),
      "fail",
    );
    assertEquals(status({ ...ok, listening: [22, 445] }, "controller-no-ssh-server"), "fail");
    // An adopted machine that is not a controller has none of these.
    assertEquals(status(base, "controller-backup"), undefined);
  },
);

proves(
  ["097-controller FR-001", "097-controller FR-006"],
  "097: the controller is declared with no host keys; another controller is not probed",
  async () => {
    const d = await controllerDef();
    assertEquals([d.role, d.hostKeys, d.name], ["controller", [], await controllerName()]);
    const other = await probe({ ...machine, name: "zz-other-controller" }, "facts");
    assert(!other.ok && other.err.includes("another controller PC"), other.err);
    const self = await probe(d, "version");
    assertEquals([self.ok, self.out.trim()], [true, PROBE_VERSION]);
  },
);

proves(
  ["097-controller FR-003"],
  "097: the controller's facts are states and dates, never a key or a secret",
  async () => {
    const f = await controllerFacts();
    const allowed = new Set([
      "signingKey",
      "inAgent",
      "backup",
      "backupAt",
      "unbacked",
      "recoveryInVault",
      "recoveryCheckedAt",
    ]);
    for (const k of Object.keys(f)) assert(allowed.has(k), `unexpected field ${k}`);
    assert(["locked", "unlocked", "missing"].includes(f.signingKey));
    assert(["current", "behind", "never"].includes(f.backup));
    const text = JSON.stringify(f);
    assert(!/ssh-ed25519|PRIVATE KEY|secrets[\\/]/i.test(text), text);
  },
);

proves(
  ["097-controller FR-005"],
  "097: the Windows probe reads BitLocker without administrator rights when the usual ways cannot",
  () => {
    const i = PROBE_SCRIPT_WINDOWS.indexOf("System.Volume.BitLockerProtection");
    assert(i > 0, "the Shell's BitLocker property is the fallback");
    // It is the fallback: after Get-BitLockerVolume and Win32_EncryptableVolume, which need an administrator.
    assert(PROBE_SCRIPT_WINDOWS.indexOf("Get-BitLockerVolume") < i);
    assert(PROBE_SCRIPT_WINDOWS.indexOf("Win32_EncryptableVolume") < i);
    assert(/\$bp -eq 1 -or \$bp -eq 3\) \{ kv disk_encryption 'on' \}/.test(PROBE_SCRIPT_WINDOWS));
  },
);
