/**
 * Spec 088: the connector template's own fixture test, as its author runs it (`bun test`): the
 * engine's runner, the same one `stolos connector add` uses, must pass every fixture.
 *
 * @module
 */
import { test } from "@intellectual-frontiers/test";
import connector, { engine, fixtures } from "./mod.ts";
import { runFixtures } from "@intellectual-frontiers/stolos/archon/connect/registry-contract";

test("the connector's recorded fixtures pass", async () => {
  if (!/^[<>=^]/.test(engine)) throw new Error("export an engine range");
  const { results } = await runFixtures(connector, fixtures);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(failed.map((r) => `${r.name}: ${r.problems.join("; ")}`).join("\n"));
  }
});
