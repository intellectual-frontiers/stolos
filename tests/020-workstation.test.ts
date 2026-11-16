/**
 * Spec 020: what a workstation host is in the model, and what it may not have.
 *
 * @module
 */
import { assert, assertEquals, proves } from "@intellectual-frontiers/commons/ts/runtime/test";
import { workstation } from "../src/archon/capabilities/mod.ts";
import { isWorkstation, usersFor } from "../src/archon/model/load.ts";
import type { HostDef } from "../src/archon/model/types.ts";
import { validateFleet } from "../src/archon/model/validate.ts";
import { fleet, host } from "./fixtures.ts";

const ws = (over: Partial<HostDef> = {}): HostDef => ({
  name: "pc",
  kind: "workstation",
  arch: "amd64",
  capabilities: workstation(),
  spec: "020-workstation",
  ...over,
});

proves(
  ["020-workstation FR-001"],
  "020: kind is server by default or workstation; a workstation names its existing account and has no machine fields",
  () => {
    // Server by default.
    assertEquals(host().kind, undefined);
    assert(!isWorkstation(host()));
    assert(isWorkstation(ws()));
    // Its account: the fleet admin's name unless it names one; never created (no UID, no keys).
    assertEquals(
      usersFor(fleet(), ws()).map((u) => [u.name, u.uid, u.sshKeys]),
      [["alice", undefined, []]],
    );
    assertEquals(usersFor(fleet(), ws({ user: "bob" }))[0]?.name, "bob");
    assertEquals(validateFleet(fleet(), [ws()]), []);
    // None of what a server's install or backup needs.
    const fields: Array<[string, Partial<HostDef>]> = [
      ["mac", { mac: "aa:bb:cc:dd:ee:ff" }],
      ["disk", { disk: { match: "largest", layout: "lvm" } }],
      [
        "guests",
        { guests: [{ name: "g", kind: "container", image: "ubuntu:26.04", data: "ephemeral" }] },
      ],
      ["backup", { backup: { keep: 3 } }],
      [
        "users",
        {
          users: [
            {
              name: "carol",
              fullName: "Carol Example",
              personas: ["standard"],
              admin: false,
              sshKeys: [],
              spec: "006-accounts",
            },
          ],
        },
      ],
    ];
    for (const [field, over] of fields) {
      const ps = validateFleet(fleet(), [ws(over)]).map((p) => p.message);
      assertEquals(ps, [`a workstation has no ${field}`], field);
    }
    assert(
      validateFleet(fleet(), [ws({ user: "Not A User" })]).some((p) =>
        p.message.includes("is not a usable account name"),
      ),
    );
  },
);
