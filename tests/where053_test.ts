// Spec 053: where am I, and the one command to run next.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { nextCommand, type WhereFacts, whereSteps } from "../src/archon/guide/where.ts";

const ready: WhereFacts = {
  fleets: ["fcr"],
  fleetId: "fcr",
  pinned: "v0.20.0",
  locked: true,
  signers: { daily: 1, recovery: 1 },
  signingProblems: [],
  adminHash: true,
  mail: { token: true },
  web: { token: true },
  hosts: [{ name: "olympia", workstation: false, installed: true, armed: false, claim: false }],
  dirty: false,
  unpushed: 0,
};

Deno.test("053: everything done: fleet status is next", () => {
  const s = whereSteps(ready);
  assert(s.every((x) => x.state === "done"), JSON.stringify(s));
  assertStringIncludes(nextCommand(s), "fleet status");
});

Deno.test("053: a new repository: create the fleet, or choose one", () => {
  assertStringIncludes(
    nextCommand(whereSteps({ ...ready, fleetId: undefined, fleets: [] })),
    "fleet init",
  );
  assertStringIncludes(
    nextCommand(whereSteps({ ...ready, fleetId: undefined, fleets: ["fcr", "synthetic-uat"] })),
    "fleet use fcr",
  );
});

Deno.test("053: exactly one next step, the first not done; pending never blocks", () => {
  const s = whereSteps({
    ...ready,
    signers: { daily: 0, recovery: 0 },
    mail: { token: false },
    hosts: [{ name: "olympia", workstation: false, installed: false, armed: false, claim: false }],
  });
  assertEquals(s.filter((x) => x.state === "next").length, 1);
  assertStringIncludes(nextCommand(s), "keys setup");
  assert(s.some((x) => x.state === "pending" && x.command === "deno task stolos boot mail-setup"));
  assert(s.some((x) => x.state === "todo" && x.command?.includes("boot arm olympia --claim")));
  // Only a pending item left: it is what to do next.
  const p = whereSteps({ ...ready, mail: { token: false } });
  assertEquals(p.filter((x) => x.state === "next").length, 0);
  assertEquals(nextCommand(p), "deno task stolos boot mail-setup");
});

Deno.test("053: an armed host says to keep the boot server running; no server says host add --claim", () => {
  const armed = whereSteps({
    ...ready,
    hosts: [{ name: "olympia", workstation: false, installed: false, armed: true, claim: true }],
  });
  assertStringIncludes(nextCommand(armed), "boot serve");
  assertStringIncludes(nextCommand(whereSteps({ ...ready, hosts: [] })), "host add <name> --claim");
  assertStringIncludes(nextCommand(whereSteps({ ...ready, unpushed: 2 })), "stolos apply");
});
