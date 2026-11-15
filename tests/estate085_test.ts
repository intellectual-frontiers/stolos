// Spec 085: the estate graph: entities from every source, one SQL question across them, and the
// cross-system policies; spec 084: connectors are labeled with NIST and analyst categories.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "./assert.ts";
import {
  buildEstate,
  estatePolicies,
  estateQuery,
  estateRefusal,
  mergeEntities,
} from "../src/archon/connect/estate.ts";
import { MARKET_CATEGORIES, SERVICE_MODELS } from "../src/archon/connect/connector.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";

const hr = {
  people: [
    { email: "Alice@Example.org", name: "Alice", status: "active" as const },
    { email: "bob@example.org", name: "Bob", status: "terminated" as const, end: "2026-10-31" },
  ],
};
const idp = {
  accounts: [
    {
      system: "google",
      id: "1",
      name: "alice",
      email: "alice@example.org",
      active: true,
      admin: true,
      mfa: false,
    },
    {
      system: "google",
      id: "2",
      name: "bob",
      email: "BOB@example.org",
      active: true,
      admin: false,
      mfa: true,
    },
    { system: "github", id: "3", name: "ci-bot", active: true, service: true },
    { system: "github", id: "4", name: "mallory", active: true },
  ],
  repositories: [{ system: "github", name: "example/app", private: true, protected: false }],
};
const fleet = {
  devices: [{
    source: "adopted",
    id: "a",
    name: "alice-mbp",
    owner: "alice@example.org",
    managed: false,
    encrypted: false,
  }],
};

Deno.test("085: people merge by email; accounts join to them, whatever the case", () => {
  const all = mergeEntities([hr, idp]);
  assertEquals(all.people.map((p) => p.email), ["alice@example.org", "bob@example.org"]);
  assertEquals(all.accounts[1].email, "bob@example.org");
});

Deno.test("085: the cross-system policies say what no single source can", () => {
  const by = Object.fromEntries(
    estatePolicies(buildEstate([hr, idp, fleet])).map((p) => [p.id, p]),
  );
  assertEquals(by.leavers.status, "fail");
  assertStringIncludes(by.leavers.detail, "bob@example.org in google");
  assertEquals(by.orphans.status, "warn");
  assertStringIncludes(by.orphans.detail, "mallory in github");
  assert(!by.orphans.detail.includes("ci-bot"), "a service account is not an orphan");
  assertEquals(by["admins-mfa"].status, "fail");
  assertEquals(by["devices-encrypted"].status, "fail");
  assertEquals(by["devices-for-people"].status, "pass");
  assertEquals(by["repos-protected"].status, "fail");
  for (const p of Object.values(by)) assert(p.scf.length > 0, p.id);
});

Deno.test("085: one SELECT across sources; anything else is refused", () => {
  const e = buildEstate([hr, idp, fleet]);
  const rows = estateQuery(
    e,
    "select p.email, a.system from people p join accounts a on a.email = p.email where p.status = 'terminated' and a.active = 1",
  );
  assertEquals(rows, [{ email: "bob@example.org", system: "google" }]);
  for (
    const bad of [
      "delete from people",
      "select 1; select 2",
      "pragma table_info(people)",
      "attach database 'x' as y",
      "",
    ]
  ) {
    assert(estateRefusal(bad), bad);
    assertThrows(() => estateQuery(e, bad));
  }
});

Deno.test("084: every connector's service models are NIST's, and its markets are named by analyst firms", () => {
  const ids = new Set(MARKET_CATEGORIES.map((m) => m.id));
  for (const c of CONNECTORS) {
    assert(
      c.serviceModels.length > 0 &&
        c.serviceModels.every((m) => (SERVICE_MODELS as readonly string[]).includes(m)),
      c.id,
    );
    assert(c.markets.length > 0 && c.markets.every((m) => ids.has(m)), `${c.id}: ${c.markets}`);
  }
  for (const m of MARKET_CATEGORIES) {
    assert(/^(Gartner|Forrester|IDC|NIST)/.test(m.source), `${m.id}: a published source`);
  }
});
