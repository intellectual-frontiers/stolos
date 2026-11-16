/**
 * Spec 006: the admin account from the fleet identity, ops, Archon's groups and sudo rule, and
 * ops' GitHub access.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { groupsFor } from "../src/archon/personas/mod.ts";
import { userData } from "../src/archon/render/autoinstall.ts";
import { fleet, host, KEY } from "./fixtures.ts";

const plan = resolvePlan(host(), fleet());
const file = (p: string) => plan.files.find((f) => f.path === p);

proves(
  ["006-accounts FR-001"],
  "006: the admin account is the installer's, from the fleet identity, and stays an administrator",
  () => {
    const u = userData(
      { fleet: fleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/t/" },
      { passwordHash: "$6$salt$hash" },
    );
    const ai = (
      JSON.parse(u.slice("#cloud-config\n".length)) as {
        autoinstall: { identity: Record<string, string> };
      }
    ).autoinstall;
    // Ubuntu's installer creates it (and puts it in the sudo group, as it does for every install).
    assertEquals(ai.identity, {
      hostname: "alpha",
      username: "alice",
      realname: "Alice Example",
      password: "$6$salt$hash",
    });
    // Archon keeps that account: the same name and UID, an administrator (apply adds it to sudo).
    const admin = plan.users[0];
    assertExists(admin);
    assertEquals([admin.name, admin.uid, admin.admin], ["alice", 1000, true]);
    assertEquals(admin.sshKeys, [KEY]);
    assert(
      (plan.notes["006-accounts"] ?? []).some((n) =>
        n.includes("alice is also in Ubuntu's sudo group"),
      ),
    );
  },
);

proves(
  ["006-accounts FR-002"],
  "006: ops is the operator account; its keys can only start archon mcp at the fleet's tier",
  () => {
    const ops = plan.users.find((u) => u.name === "ops");
    assertExists(ops);
    assertEquals([ops.personas, ops.admin], [["operator"], false]);
    assertEquals(ops.sshKeys, [
      `restrict,command="env ARCHON_AGENT=mcp /usr/local/bin/archon mcp --max-tier mutate" ${KEY}`,
    ]);
    const read = resolvePlan(host(), fleet({ mcp: { maxTier: "read" } })).users.find(
      (u) => u.name === "ops",
    );
    assertStringIncludes(read?.sshKeys?.[0] ?? "", 'archon mcp --max-tier read" ');
  },
);

proves(
  ["006-accounts FR-003", "017-guests FR-004"],
  "006: Archon's groups from sysusers.d; operators (in lxd too) get passwordless sudo for archon only",
  () => {
    const sysusers = file("/etc/sysusers.d/archon.conf");
    assertExists(sysusers);
    for (const g of ["archon", "archon-dev", "archon-ops"]) {
      assert((sysusers.content ?? "").split("\n").includes(`g ${g} - - -`), g);
    }
    const sudo = file("/etc/sudoers.d/archon");
    assertExists(sudo);
    assertEquals(sudo.mode, "0440");
    assertEquals(sudo.validate, ["visudo", "-cf", "{}"]);
    const rules = (sudo.content ?? "").split("\n").filter((l) => /^%/.test(l));
    assertEquals(rules, [
      "%archon-ops ALL=(root) NOPASSWD: /usr/local/bin/archon, /usr/local/bin/archon *",
    ]);
    // Operators are in archon-ops (and lxd, for guests: spec 017); developers are not operators.
    const ops = groupsFor(["operator"]);
    for (const g of ["archon", "archon-dev", "archon-ops", "lxd"]) assert(ops.includes(g), g);
    assert(!groupsFor(["developer"]).includes("archon-ops"));
    assert(!groupsFor(["developer"]).includes("lxd"));
  },
);

proves(
  ["006-accounts FR-004"],
  "006: ops reaches GitHub over SSH with the host's deploy key",
  () => {
    const cfg = file("/home/ops/.ssh/config");
    assertExists(cfg);
    assertEquals([cfg.owner, cfg.mode], ["ops", "0600"]);
    for (const line of [
      "Host github.com",
      "  User git",
      "  IdentityFile /home/ops/.ssh/archon_deploy_key",
      "  IdentitiesOnly yes",
      "  UserKnownHostsFile /etc/archon/github_known_hosts",
    ]) {
      assert((cfg.content ?? "").split("\n").includes(line), line);
    }
    // The install delivers the deploy key; the first boot hands it to ops at that path.
    const u = userData(
      { fleet: fleet(), host: host(), base: "http://x/" },
      {
        passwordHash: "x",
        deployKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nk\n-----END OPENSSH PRIVATE KEY-----",
      },
    );
    assertStringIncludes(u, '"path": "/etc/archon/deploy_key"');
  },
);
