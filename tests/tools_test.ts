// Tools (spec 010): the catalog.
import { assert, assertEquals } from "./assert.ts";

Deno.test("a tool that refuses root (Steampipe) is smoke-tested and verified as nobody", async () => {
  const { TOOLS } = await import("../src/archon/tools/catalog.ts");
  const sp = TOOLS.find((t) => t.id === "steampipe")!;
  assertEquals(sp.unprivileged, true);
  // nobody's home does not exist: the check gives it one it can write.
  assert(sp.verify.startsWith("env HOME=/tmp "));
});
