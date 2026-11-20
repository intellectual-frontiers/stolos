/**
 * The lab baseline's tests (spec 078): each control over fixtures, with `bun test`.
 *
 * @module
 */
import { test } from "@intellectual-frontiers/test";

import { fixtureEstate, testControl } from "@intellectual-frontiers/stolos/archon/controls/mod";
import { fewAdmins, noTelnet, pack } from "./pack.ts";

const eq = (got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

const admin = (id: string) => ({
  system: "okta",
  id,
  name: `admin${id}`,
  email: `admin${id}@lab.example.net`,
  active: true,
  admin: true,
  mfa: true,
});

test("baseline: four administrators in one system warn; three pass", () => {
  const estate = (n: number) =>
    fixtureEstate({
      sources: [
        {
          connector: "okta",
          observation: {
            at: "2026-11-01T00:00:00Z",
            provider: "okta",
            account: "lab.okta.com",
            assets: [],
            posture: {},
            gaps: [],
            entities: { accounts: Array.from({ length: n }, (_, i) => admin(String(i + 1))) },
          },
        },
      ],
    });
  const [four] = testControl(fewAdmins, { estate: estate(4) });
  eq([four?.status, four?.detail], ["warn", "4 administrators in okta"]);
  eq(
    testControl(fewAdmins, { estate: estate(3) }).map((r) => r.status),
    ["pass"],
  );
  // No account says whether it is an administrator: the control does not apply.
  eq(testControl(fewAdmins, { estate: estate(0) }), []);
});

test("baseline: telnet fails where it listens, and an accepted risk applies", () => {
  const machines = { alpha: [{ port: 23, address: "0.0.0.0" }], beta: [] };
  eq(
    testControl(noTelnet, { machines }).map((r) => [r.machine, r.status]),
    [
      ["alpha", "fail"],
      ["beta", "pass"],
    ],
  );
  const accepted = [
    {
      policy: "no-telnet",
      reason: "the lab's terminal server",
      by: "alice",
      until: "2099-12-31",
    },
  ];
  eq(
    testControl(noTelnet, { machines, accepted }).map((r) => r.status),
    ["accepted", "pass"],
  );
});

test("baseline: the pack has both controls", () => {
  eq(
    pack.controls.map((c) => c.id),
    ["few-admins", "no-telnet"],
  );
});
