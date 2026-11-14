// Spec 046: `archon fleet use <id>` remembers this checkout's fleet (in .git,
// never committed); --fleet still wins for one command.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";
import { sandbox } from "./sandbox.ts";

Deno.test("046: fleet use remembers the fleet for this checkout; --fleet wins once", async () => {
  const sb = await sandbox("archon-fleet-use-");
  try {
    const repo = join(sb.home, "fleet");
    for (const id of ["alpha", "beta"]) {
      await Deno.mkdir(join(repo, "fleets"), { recursive: true });
      await new Deno.Command("cp", {
        args: ["-r", "examples/fleets/lab", join(repo, "fleets", id)],
      }).output();
      const f = join(repo, "fleets", id, "fleet.ts");
      await Deno.writeTextFile(
        f,
        (await Deno.readTextFile(f)).replace(/"id": "lab"/, `"id": "${id}"`),
      );
    }
    await new Deno.Command("git", { args: ["init", "-q", "-b", "main", repo] }).output();
    const env = { ARCHON_REPO: repo };
    const archon = (args: string[]) => sb.run("src/archon/main.ts", args, "", env);

    let r = await archon(["validate"]);
    assert(r.code !== 0, r.out);
    assertStringIncludes(r.out, "deno task archon fleet use <id> (one of: alpha, beta)");
    r = await archon([]);
    assertStringIncludes(r.out, "deno task archon fleet use alpha");

    r = await archon(["fleet", "use", "gamma"]);
    assertEquals(r.code, 1, r.out);
    assertStringIncludes(r.out, "no fleet gamma");

    r = await archon(["fleet", "use", "beta"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "now using fleet beta");
    assertEquals(
      (await Deno.readTextFile(join(repo, ".git", "archon", "fleet"))).trim(),
      "beta",
    );
    r = await archon([]);
    assertStringIncludes(r.out, "fleet beta");
    r = await archon(["--fleet", "alpha"]);
    assertStringIncludes(r.out, "fleet alpha");
    r = await archon(["fleet", "use", "beta"]);
    assertStringIncludes(r.out, "already using fleet beta");
  } finally {
    await Deno.remove(sb.home, { recursive: true });
  }
});
