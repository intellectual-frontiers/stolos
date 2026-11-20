/**
 * Spec 037: file shares over SMB, off until an operator turns them on.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { fs, proc } from "@intellectual-frontiers/system";
import { engineFile } from "../src/archon/core/assets.ts";
import { fleet, host } from "./fixtures.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { usersFor } from "../src/archon/model/load.ts";
import { SMB, smbConf, smbName, smbUsers } from "../src/archon/smb/config.ts";

const webFleet = () => ({ ...fleet(), web: { domain: "lab.example.net" } });

proves(
  ["037-smb FR-002", "037-smb FR-003"],
  "037: smb.conf: SMB3, encryption desired, no guests, no NetBIOS, local networks only",
  async () => {
    const users = usersFor(fleet(), host());
    const conf = smbConf(fleet(), host(), users);
    for (const line of [
      "server min protocol = SMB3",
      "server smb encrypt = desired",
      "map to guest = never",
      "restrict anonymous = 2",
      "disable netbios = yes",
      "smb ports = 445",
      "load printers = no",
      "usershare max shares = 0",
    ])
      assertStringIncludes(conf, line);
    assert(
      !/hosts (allow|deny)/.test(conf),
      "no network restriction in smb.conf (the router decides)",
    );
    // Everyone with an account but ops; each home folder its owner's only.
    assertEquals(smbUsers(users), ["alice"]);
    assertStringIncludes(conf, "valid users = alice\n");
    assertStringIncludes(conf, "[homes]");
    assertStringIncludes(conf, "valid users = %S");
    assertStringIncludes(conf, `path = ${SMB.shared}`);
    assertStringIncludes(conf, `force group = ${SMB.group}`);
    // Samba's own check, where Samba is installed.
    if (proc.which("testparm") !== undefined) {
      const file = await fs.makeTempFile({ suffix: ".conf" });
      await fs.writeTextFile(file, conf);
      const r = await proc.run(["testparm", "-s", file], { stdout: "null" });
      assertEquals(r.code, 0, r.stderr);
      await fs.remove(file);
    }
  },
);

proves(
  ["037-smb FR-001", "037-smb FR-004", "037-smb FR-006"],
  "037: every server has Samba, off (masked) behind the operator's switch; workstations don't",
  async () => {
    const plan = resolvePlan(host(), webFleet());
    assert(plan.packages.some((p) => p.name === "samba"));
    const smbd = plan.units.find((u) => u.unitName === "smbd.service");
    assertEquals(smbd?.state, "masked");
    assertEquals(smbd?.switch, "smb");
    assertEquals(plan.units.find((u) => u.unitName === "nmbd.service")?.state, "masked");
    assert(
      plan.ports.some((p) => p.port === 445),
      "445 open (the router decides who reaches it)",
    );
    assert(
      plan.files.some((f) => f.path === "/etc/samba/smb.conf" && f.validate?.[0] === "testparm"),
    );
    assertEquals(smbName(webFleet(), host()), "smb.alpha.lab.example.net");
    const { workstation } = await import("../src/archon/capabilities/mod.ts");
    const { mac: _mac, disk: _disk, ...server } = host();
    const ws = resolvePlan(
      {
        ...server,
        name: "pc",
        kind: "workstation",
        user: "alice",
        capabilities: workstation(),
        spec: "020-workstation",
      },
      fleet(),
    );
    assert(!ws.packages.some((p) => p.name === "samba"));
  },
);

proves(
  ["037-smb FR-004"],
  "037: the switch is the host's recorded state; on only when it says enabled",
  async () => {
    const { switchOn } = await import("../src/archon/apply/apply.ts");
    const root = await fs.makeTempDir({ prefix: "archon-smb-test-" });
    try {
      assertEquals(await switchOn("alpha", "smb", root), false);
      const { putRecord } = await import("../src/archon/state/store.ts");
      const rec = (enabled: boolean) =>
        putRecord(
          "alpha",
          "optin",
          "smb",
          { enabled, by: "alice", at: "2026-11-12T17:00:00Z" },
          root,
        );
      await rec(true);
      assertEquals(await switchOn("alpha", "smb", root), true);
      await rec(false);
      assertEquals(await switchOn("alpha", "smb", root), false);
      await putRecord("alpha", "optin", "smb", "not a record", root);
      assertEquals(await switchOn("alpha", "smb", root), false);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
);

proves(
  ["037-smb FR-005", "037-smb FR-007", "037-smb FR-009"],
  "037: commands, backups, and the guide",
  async () => {
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    const byName = (n: string) => COMMANDS.find((c) => c.name === n);
    assertEquals(byName("fs smb on")?.tier, "mutate");
    assertEquals(byName("fs smb off")?.tier, "mutate");
    assertEquals(byName("fs smb status")?.tier, "read");
    assertEquals(byName("fs smb passwd"), undefined, "no separate SMB passwords");
    const { DEFAULT_BACKUP } = await import("../src/archon/capabilities/backup.ts");
    assert(DEFAULT_BACKUP.paths.includes("/var/lib/samba/private"));
    const { guideFor } = await import("../src/archon/guide/guide.ts");
    const item = guideFor(resolvePlan(host(), webFleet())).find((x) => x.id === "smb");
    assert(item?.use?.some((u) => u.cmd === "\\\\smb.alpha.lab.example.net\\shared") === true);
    const { GUIDES } = await import("../src/archon/web/serve.ts");
    assert(GUIDES.some((g) => g.name === "smb"));
    assertStringIncludes(engineFile("docs/smb.md"), "your Linux username and password");
  },
);
