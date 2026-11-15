// Spec 084: connectors are labeled with NIST and analyst categories. (The estate graph of spec 085
// is spec 090's now: tests/estate090_test.ts.)
import { assert } from "./assert.ts";
import { MARKET_CATEGORIES, SERVICE_MODELS } from "../src/archon/connect/connector.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";

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
