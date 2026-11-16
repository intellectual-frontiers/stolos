/**
 * Spec 048: where a machine keeps its state, what is written to it, `archon state`, and how the
 * boot machine asks the servers (`fleet status`, `fleet query`) over MCP. The servers are stand-ins
 * here: an `ssh` on the PATH that answers newline-delimited JSON-RPC as a server's `archon mcp`
 * does. tests/e2e/lib.sh asks a real installed server the same way (its `fleet query` step).
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";
import { at, list } from "./fixtures.ts";

/** The example lab as a fleet repository in a sandbox, with stand-in servers. */
async function lab() {
  const sb = await sandbox("archon-observe-test-");
  const repo = path.join(sb.home, "fleet");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await proc.output([
    "cp",
    "-r",
    path.join(ENGINE_ROOT, "examples/fleets/lab"),
    `${repo}/fleets/lab`,
  ]);
  await linkEngine(repo);
  const servers = path.join(sb.home, "servers");
  const bin = path.join(sb.home, "bin");
  await fs.mkdir(servers, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  // A server with an answer file answers; one without does not (ssh's 255). Every answering server
  // waits until all have been asked (at most 5 s): asked one after another, the first would time out.
  await fs.writeTextFile(
    path.join(bin, "ssh"),
    `#!/bin/sh
D='${servers}'
for a; do last="$a"; done
h=\${last#*@}; h=\${h%%.*}
echo "$*" > "$D/asked.$h"
[ -f "$D/answer.$h" ] || { echo "ssh: connect to host $h port 22: No route to host" >&2; exit 255; }
i=0
while [ $i -lt 50 ] && [ "$(ls "$D" | grep -c '^asked\\.')" -lt "$(ls "$D" | grep -c '^answer\\.')" ]; do sleep 0.1; i=$((i+1)); done
while read -r l; do case "$l" in *'"id":2'*) cat "$D/answer.$h"; exit 0;; esac; done
`,
  );
  await fs.chmod(path.join(bin, "ssh"), 0o755);
  const answer = async (h: string, text: string | undefined): Promise<void> => {
    const f = path.join(servers, `answer.${h}`);
    if (text === undefined) await fs.remove(f).catch(() => {});
    else {
      await fs.writeTextFile(
        f,
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } })}\n`,
      );
    }
  };
  const reset = async () => {
    for await (const e of fs.readDir(servers)) {
      if (e.name.startsWith("asked.")) await fs.remove(path.join(servers, e.name));
    }
  };
  const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab", PATH: `${bin}:${proc.env.get("PATH")}` };
  const stolos = (...args: string[]) => sb.run("src/stolos/main.ts", args, "", env);
  const archon = (...args: string[]) => sb.run("src/archon/main.ts", args, "", env);
  const script = async (name: string, body: string) => {
    const f = path.join(sb.home, name);
    await fs.writeTextFile(f, body);
    return await sb.run(f, [], "", env);
  };
  const src = (rel: string) =>
    JSON.stringify(new URL(`../src/archon/${rel}`, import.meta.url).href);
  return { sb, repo, servers, answer, reset, stolos, archon, script, src };
}

proves(
  ["048-observe-by-query FR-002", "048-observe-by-query FR-003", "048-observe-by-query FR-006"],
  "048: this PC keeps state per fleet; verify, provenance, and switches are written; archon state reads them",
  async () => {
    const l = await lab();
    try {
      // FR-002: not an installed machine: this user's data folder, per fleet.
      let r = await l.script(
        "where.ts",
        `import { P } from ${l.src("core/paths.ts")};\nconsole.log(P.state);\n`,
      );
      if (!(await fs.exists("/etc/archon/host"))) {
        assertEquals(r.out.trim(), path.join(l.sb.home, "data", "stolos", "state", "lab"));
      }
      // FR-003: the latest verify, an apply's provenance, and an operator's switch with its class.
      r = await l.script(
        "write.ts",
        `import { recordVerify } from ${l.src("state/verify.ts")};
import { recordActivity } from ${l.src("prov/prov.ts")};
import { writeOptIn } from ${l.src("optin/optin.ts")};
import { listRecords } from ${l.src("state/store.ts")};
await recordVerify("alpha", [
  { resource: "ssh.service", command: "true", ok: true, output: "" },
  { resource: "tool:jc", command: "false", ok: false, output: "" },
]);
await recordActivity("alpha", { started: new Date(), ended: new Date(), changes: ["/etc/motd"], failed: false });
await writeOptIn("alpha", "s3", true, "alice", undefined, "durable");
console.log(JSON.stringify((await listRecords("alpha", "prov")).map((x) => x.body)));
`,
      );
      assertEquals(r.code, 0, r.out);
      const prov: unknown = JSON.parse(r.out.trim().split("\n").pop() ?? "[]");
      assertEquals(list(prov).length, 1);
      assertEquals(at(prov, 0, "command"), "apply");
      assertEquals(at(prov, 0, "detail"), ["/etc/motd"]);
      const sql = await fs.readTextFile(
        path.join(l.sb.home, "data", "stolos", "state", "lab", "archon.sql"),
      );
      for (const kind of ["verify", "prov", "optin"]) assertStringIncludes(sql, `'${kind}'`);

      // FR-006: archon state, as JSON and as text.
      r = await l.archon("--host", "alpha", "--json", "state");
      assertEquals(r.code, 0, r.out);
      const st: unknown = JSON.parse(r.out.slice(r.out.indexOf("{")));
      assertEquals(at(st, "host"), "alpha");
      assertEquals([at(st, "verify", "passed"), at(st, "verify", "total")], [1, 2]);
      assertEquals(at(st, "verify", "failed"), ["tool:jc"]);
      assertEquals(
        [at(st, "optIns", "s3", "enabled"), at(st, "optIns", "s3", "data")],
        [true, "durable"],
      );
      assertEquals(at(st, "data", "class"), "durable", "the switch's data class decides it");
      r = await l.archon("--host", "alpha", "state");
      assertStringIncludes(r.out, "failing: tool:jc");
      assertStringIncludes(r.out, "State of alpha   durable (S3)");
      const { COMMANDS } = await import("../src/archon/commands/registry.ts");
      assertEquals(COMMANDS.find((c) => c.name === "state")?.tier, "read");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
);

proves(
  ["048-observe-by-query FR-006"],
  "048: fleet status asks each server for archon_state over SSH as ops, and caches each answer",
  async () => {
    const l = await lab();
    try {
      const state = {
        host: "alpha",
        install: {
          at: "2026-11-12T13:43:21Z",
          body: { ok: true, checks: { passed: 96, total: 96 } },
        },
        verify: {
          passed: 95,
          total: 96,
          failed: ["tool:jc"],
          warned: [],
          since: "2026-11-13T08:00:00Z",
        },
        optIns: {},
        data: { class: "ephemeral", reasons: [] },
        at: "2026-11-13T09:00:00Z",
      };
      await l.answer("alpha", JSON.stringify(state));
      await l.answer("beta", JSON.stringify({ ...state, host: "beta" }));
      let r = await l.stolos("fleet", "status");
      assertEquals(r.code, 0, r.out);
      const asked = await fs.readTextFile(path.join(l.servers, "asked.alpha"));
      assert(asked.trim().endsWith("ops@alpha"), asked);
      assertStringIncludes(r.out, "failing at its last verify: tool:jc");
      assertStringIncludes(r.out, "95/96 checks");
      // Unreachable now: what each said last, from this PC's cache.
      await l.answer("alpha", undefined);
      await l.answer("beta", undefined);
      await l.reset();
      r = await l.stolos("fleet", "status");
      assertStringIncludes(r.out, "unreachable now");
      assertStringIncludes(r.out, "showing what it said last");
      assertStringIncludes(r.out, "95/96 checks");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script" },
);

proves(
  ["048-observe-by-query FR-007"],
  "048: fleet query runs archon_query on every server at once; rows by machine; the unreachable named",
  async () => {
    const l = await lab();
    try {
      await l.answer("alpha", JSON.stringify([{ ok: 1, passed: 96, total: 96 }]));
      await l.answer("beta", JSON.stringify([{ ok: 1, passed: 90, total: 96 }]));
      let r = await l.stolos(
        "--json",
        "fleet",
        "query",
        "select ok, passed, total from archon_install",
      );
      assertEquals(r.code, 0, r.out);
      const rows: unknown = JSON.parse(r.out.slice(r.out.indexOf("[")));
      assertEquals(
        list(rows).map((a) => [at(a, "machine"), at(a, "rows", 0, "passed")]),
        [
          ["alpha", 96],
          ["beta", 90],
        ],
        "both answered: asked in parallel (each waits until the other is asked)",
      );
      assertStringIncludes(await fs.readTextFile(path.join(l.servers, "asked.alpha")), "ops@alpha");
      // beta does not answer: it is named, and the command says so.
      await l.answer("beta", undefined);
      await l.reset();
      r = await l.stolos("fleet", "query", "select ok, passed, total from archon_install");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "beta: ssh: connect to host beta port 22: No route to host");
      assertStringIncludes(r.out, "1 row(s) from 1 of 2 machine(s)");
      // Not an MCP tool: it runs on the PC.
      const { COMMANDS } = await import("../src/archon/commands/registry.ts");
      const { listed } = await import("../src/archon/mcp/server.ts");
      const q = COMMANDS.find((c) => c.name === "fleet query");
      assert(q !== undefined && !listed(q, "mutate"), "fleet query is not served over MCP");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script" },
);
