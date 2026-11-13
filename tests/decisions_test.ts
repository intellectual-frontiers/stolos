// Spec 047 (Article 25): operators' decisions live in Git (decisions.ts),
// written by archon decide; they win over a host's own record, so they
// survive a re-install and say whether a host is durable while it is offline.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { decisionsSource } from "../src/archon/fleet/decisions.ts";
import { sandbox } from "./sandbox.ts";

const ENGINE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("047: decisions.ts has one form: sorted, every value written one way", () => {
  const a = decisionsSource({
    optIns: {
      s3: { enabled: false, by: "alice", at: "t2", data: "ephemeral" },
      pg: { enabled: true, by: "alice", at: "t1", data: "durable" },
    },
  });
  assert(a.indexOf('"pg"') < a.indexOf('"s3"'));
  assertStringIncludes(a, "} satisfies HostDecisions;");
  assertEquals(
    decisionsSource({
      optIns: {
        pg: { at: "t1", by: "alice", enabled: true, data: "durable" },
        s3: { data: "ephemeral", enabled: false, at: "t2", by: "alice" },
      },
    }),
    a,
  );
});

Deno.test("047: archon decide writes Git's decision; the model and the data class follow it", async () => {
  const sb = await sandbox("archon-decide-test-");
  const repo = `${sb.home}/fleet`;
  try {
    await Deno.mkdir(`${repo}/fleets`, { recursive: true });
    await new Deno.Command("cp", {
      args: ["-r", `${ENGINE}/examples/fleets/lab`, `${repo}/fleets/lab`],
    })
      .output();
    const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
    const archon = (args: string[]) => sb.run(`${ENGINE}/src/archon/main.ts`, args, "", env);

    // Turning on an opt-in that holds end users' data needs the choice.
    let r = await archon(["decide", "pg", "on", "--host", "beta"]);
    assert(r.code !== 0, r.out);
    r = await archon(["decide", "pg", "on", "--durable", "--host", "beta"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "git commit -S");
    const text = await Deno.readTextFile(`${repo}/fleets/lab/hosts/beta/decisions.ts`);
    assertStringIncludes(text, '"pg": {\n      enabled: true,\n      data: "durable",');
    r = await archon(["validate"]);
    assertEquals(r.code, 0, r.out);

    // The model sees it, with no record on any machine: beta is durable from Git alone.
    const probe = `
      import { loadHosts } from "${ENGINE}/src/archon/model/load.ts";
      import { hostData } from "${ENGINE}/src/archon/model/durable.ts";
      const b = (await loadHosts()).find((h) => h.name === "beta");
      console.log(JSON.stringify({ pg: b.optIn.pg, data: hostData(b).class }));`;
    // Next to the engine, so its import map (@stolos/) applies.
    const probeFile = `${ENGINE}/tests/.probe-decisions-${crypto.randomUUID()}.ts`;
    await Deno.writeTextFile(probeFile, probe);
    try {
      r = await sb.run(probeFile, [], "", env);
    } finally {
      await Deno.remove(probeFile);
    }
    const got = JSON.parse(r.out.trim().split("\n").pop()!);
    assertEquals([got.pg.enabled, got.pg.data, got.data], [true, "durable", "durable"]);

    // Durable to ephemeral removes a protection: only with --confirm-destroy beta.
    r = await archon(["decide", "pg", "on", "--ephemeral", "--host", "beta"]);
    assert(r.code !== 0 && /confirm-destroy/.test(r.out), r.out);
    // A hand edit that leaves the form is refused by build.
    await Deno.writeTextFile(
      `${repo}/fleets/lab/hosts/beta/decisions.ts`,
      text.replace("enabled: true", "enabled:true"),
    );
    r = await archon(["validate"]);
    assert(r.code !== 0 && /not in the form archon decide writes/.test(r.out), r.out);
  } finally {
    await Deno.remove(sb.home, { recursive: true });
  }
});
