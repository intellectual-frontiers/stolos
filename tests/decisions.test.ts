/**
 * Spec 047 (Article 25): operators' decisions live in Git (decisions.ts),
 * written by stolos decide; they win over a host's own record, so they
 * survive a re-install and say whether a host is durable while it is offline.
 *
 * @module
 */
import { fs, path } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  test,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { decisionsSource } from "../src/archon/fleet/decisions.ts";
import { ENGINE_ROOT as ENGINE, sandbox, linkEngine } from "./sandbox.ts";
import { at } from "./fixtures.ts";

proves(
  ["047-intent-and-identity FR-006"],
  "047: decisions.ts has one form: sorted, every value written one way",
  () => {
    const a = decisionsSource({
      optIns: {
        s3: { enabled: false, by: "alice", at: "t2", data: "ephemeral" },
        pg: { enabled: true, by: "alice", at: "t1", data: "durable" },
      },
    });
    assert(a.indexOf("pg: {") < a.indexOf("s3: {"), "sorted, with bare keys");
    assert(
      decisionsSource({ optIns: { "otel-ui": { enabled: true, by: "a", at: "t" } } }).includes(
        '"otel-ui": {',
      ),
      "quoted only when it must be",
    );
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
  },
);

proves(
  ["047-intent-and-identity FR-006"],
  "047: stolos decide writes Git's decision; the model and the data class follow it",
  async () => {
    const sb = await sandbox("archon-decide-test-");
    const repo = `${sb.home}/fleet`;
    try {
      await fs.mkdir(`${repo}/fleets`, { recursive: true });
      await fs.copy(`${ENGINE}/examples/fleets/lab`, `${repo}/fleets/lab`);
      await linkEngine(repo);
      await linkEngine(repo);
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      const archon = (args: string[]) => sb.run(`${ENGINE}/src/stolos/main.ts`, args, "", env);

      // Turning on an opt-in that holds end users' data needs the choice.
      let r = await archon(["decide", "pg", "on", "--host", "beta"]);
      assert(r.code !== 0, r.out);
      r = await archon(["decide", "pg", "on", "--durable", "--host", "beta"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "bun run stolos apply");
      const text = await fs.readTextFile(`${repo}/fleets/lab/hosts/beta/decisions.ts`);
      assertStringIncludes(text, 'pg: {\n      enabled: true,\n      data: "durable",');
      r = await archon(["validate"]);
      assertEquals(r.code, 0, r.out);

      // The model sees it, with no record on any machine: beta is durable from Git alone.
      const src = (rel: string): string =>
        JSON.stringify(path.toFileUrl(path.join(ENGINE, "src", "archon", rel)).href);
      const probe = `
      import { loadHosts } from ${src("model/load.ts")};
      import { hostData } from ${src("model/durable.ts")};
      const b = (await loadHosts()).find((h) => h.name === "beta");
      console.log(JSON.stringify({ pg: b.optIn.pg, data: hostData(b).class }));`;
      // Next to the engine, so its import map (@stolos/) applies.
      const probeFile = `${ENGINE}/tests/.probe-decisions-${crypto.randomUUID()}.ts`;
      await fs.writeTextFile(probeFile, probe);
      try {
        r = await sb.run(probeFile, [], "", env);
      } finally {
        await fs.remove(probeFile);
      }
      const got: unknown = JSON.parse(r.out.trim().split("\n").pop() ?? "");
      assertEquals(
        [at(got, "pg", "enabled"), at(got, "pg", "data"), at(got, "data")],
        [true, "durable", "durable"],
      );

      // Durable to ephemeral removes a protection: only with --confirm-destroy beta.
      r = await archon(["decide", "pg", "on", "--ephemeral", "--host", "beta"]);
      assert(r.code !== 0 && /confirm-destroy/.test(r.out), r.out);
      // A hand edit that leaves the form is refused by build.
      await fs.writeTextFile(
        `${repo}/fleets/lab/hosts/beta/decisions.ts`,
        text.replace("enabled: true", "enabled:true"),
      );
      r = await archon(["validate"]);
      assert(r.code !== 0 && /not in the form stolos decide writes/.test(r.out), r.out);
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

test("062: a Windows checkout (CRLF line endings) passes the fixed-form checks", async () => {
  const sb = await sandbox("archon-crlf-test-");
  const repo = `${sb.home}/fleet`;
  try {
    await fs.mkdir(`${repo}/fleets`, { recursive: true });
    await fs.copy(`${ENGINE}/examples/fleets/lab`, `${repo}/fleets/lab`);
    await linkEngine(repo);
    const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
    const archon = (args: string[]) => sb.run(`${ENGINE}/src/stolos/main.ts`, args, "", env);
    assertEquals((await archon(["decide", "pg", "on", "--durable", "--host", "beta"])).code, 0);
    // As Git for Windows checks them out without .gitattributes: CRLF everywhere.
    const crlf = async (dir: string) => {
      for await (const e of fs.readDir(dir)) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory) await crlf(p);
        else if (p.endsWith(".ts")) {
          await fs.writeTextFile(p, (await fs.readTextFile(p)).replace(/\r?\n/g, "\r\n"));
        }
      }
    };
    await crlf(`${repo}/fleets/lab`);
    const r = await archon(["validate"]);
    assertEquals(r.code, 0, r.out);
    assert(!r.out.includes("not in the form"), r.out);
  } finally {
    await fs.remove(sb.home, { recursive: true });
  }
});
