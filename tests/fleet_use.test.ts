/**
 * Spec 046: `stolos fleet use <id>` remembers this checkout's fleet (in .git,
 * never committed); --fleet still wins for one command.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals, assertStringIncludes, test } from "@intellectual-frontiers/test";
import { sandbox, linkEngine } from "./sandbox.ts";

test("046: fleet use remembers the fleet for this checkout; --fleet wins once", async () => {
  const sb = await sandbox("archon-fleet-use-");
  try {
    const repo = path.join(sb.home, "fleet");
    for (const id of ["alpha", "beta"]) {
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await proc.output(["cp", "-r", "examples/fleets/lab", path.join(repo, "fleets", id)]);
      await linkEngine(repo);
      const f = path.join(repo, "fleets", id, "fleet.ts");
      await fs.writeTextFile(f, (await fs.readTextFile(f)).replace(/id: "lab"/, `id: "${id}"`));
    }
    await proc.output(["git", "init", "-q", "-b", "main", repo]);
    const env = { ARCHON_REPO: repo };
    const archon = (args: string[]) => sb.run("src/stolos/main.ts", args, "", env);

    let r = await archon(["validate"]);
    assert(r.code !== 0, r.out);
    assertStringIncludes(r.out, "bun run stolos fleet use <id> (one of: alpha, beta)");
    r = await archon([]);
    assertStringIncludes(r.out, "bun run stolos fleet use alpha");

    r = await archon(["fleet", "use", "gamma"]);
    assertEquals(r.code, 1, r.out);
    assertStringIncludes(r.out, "no fleet gamma");

    r = await archon(["fleet", "use", "beta"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "now using fleet beta");
    assertEquals(
      (await fs.readTextFile(path.join(repo, ".git", "stolos", "fleet"))).trim(),
      "beta",
    );
    r = await archon([]);
    assertStringIncludes(r.out, "fleet beta");
    r = await archon(["--fleet", "alpha"]);
    assertStringIncludes(r.out, "fleet alpha");
    r = await archon(["fleet", "use", "beta"]);
    assertStringIncludes(r.out, "already using fleet beta");
  } finally {
    await fs.remove(sb.home, { recursive: true });
  }
});
