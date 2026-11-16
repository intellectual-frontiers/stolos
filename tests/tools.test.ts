/**
 * Tools (spec 010): the catalog.
 *
 * @module
 */
import { assert, assertEquals, test } from "@intellectual-frontiers/commons/ts/runtime/test";

test("a tool that refuses root (Steampipe) is smoke-tested and verified as nobody", async () => {
  const { TOOLS } = await import("../src/archon/tools/catalog.ts");
  const sp = TOOLS.find((t) => t.id === "steampipe");
  assert(sp, "steampipe is in the catalog");
  assertEquals(sp.unprivileged, true);
  // nobody's home does not exist: the check gives it one it can write.
  assert(sp.verify.startsWith("env HOME=/tmp "));
});

test("096: Bun is in the catalog at the engine's pin, with the pinned SHA-256, never the newest", async () => {
  const { TOOLS } = await import("../src/archon/tools/catalog.ts");
  const { pinnedRelease } = await import("../src/archon/tools/sync.ts");
  const { BUN_SHA256, BUN_VERSION } = await import("../src/archon/core/bun-pin.ts");
  const bun = TOOLS.find((t) => t.id === "bun");
  assert(bun?.github?.pinned, "bun is pinned");
  assertEquals(bun.github.pinned.version, BUN_VERSION);
  const rel = await pinnedRelease(bun.github.pinned);
  assertEquals(rel.version, BUN_VERSION);
  const [asset] = rel.assets;
  assert(asset !== undefined);
  assert(bun.github.asset("amd64", BUN_VERSION).test(asset.name), asset.name);
  const target = asset.name.replace(/^bun-/, "").replace(/\.zip$/, "");
  assert(
    Object.entries(BUN_SHA256).some(([k, v]) => k === target && asset.digest === `sha256:${v}`),
  );
});
