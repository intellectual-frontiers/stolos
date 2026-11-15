// Spec 088: the connector registry. A third-party connector is added from a pinned URL with a lock
// entry, like the engine: here a local "GitHub" serves the engine checkout and the connector
// template (examples/connector-template) at tags, a fleet repository pins the engine there, and
// `connector add` checks the template in a restricted probe, runs its fixtures, writes the import
// and Stolos's entry, and locks it in deno.lock. It refuses a clashing id, a bad label, a made-up
// SCF id, and failing fixtures, changing nothing; the added connector then appears in
// `estate observe`'s list.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  declarationProblems,
  fromIndex,
  labelProblems,
  parseIndex,
  pinSource,
  registryEntries,
  registrySource,
  satisfies,
} from "../src/archon/connect/registry.ts";
import {
  connectorAdd,
  connectorList,
  connectorRemove,
  connectorTest,
  lockedHash,
} from "../src/archon/connect/registry-commands.ts";
import { declare } from "../src/archon/connect/registry-contract.ts";
import * as template from "../examples/connector-template/mod.ts";
import { defineLabel } from "../src/archon/schema/define.ts";
import { VULNERABILITY } from "../src/archon/connect/labels.ts";
import { SCF } from "../src/archon/compliance/scf.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";
import { VERSION } from "../src/archon/version.ts";
import { ui } from "../src/archon/core/ui.ts";
import { sandbox } from "./sandbox.ts";

const ENGINE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CHECK = {
  builtIns: CONNECTORS.map((c) => c.id),
  others: [],
  version: VERSION,
  scf: new Set(SCF.map((c) => c.id)),
};

Deno.test("088: a source and a tag pin a module URL; a branch or no ref is refused", () => {
  assertEquals(pinSource("https://github.com/example/stolos-connector-example@v1.2.0"), {
    source: "https://github.com/example/stolos-connector-example",
    ref: "v1.2.0",
    module: "https://raw.githubusercontent.com/example/stolos-connector-example/v1.2.0/mod.ts",
  });
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assertEquals(
    pinSource(`https://github.com/example/connectors/scanner/mod.ts@${sha}`).module,
    `https://raw.githubusercontent.com/example/connectors/${sha}/scanner/mod.ts`,
  );
  for (
    const bad of [
      "https://github.com/example/x@main",
      "https://github.com/example/x",
      "http://example.com/a/b@v1.0.0",
      "https://github.com/example@v1.0.0",
    ]
  ) {
    let threw = false;
    try {
      pinSource(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

Deno.test("088: engine ranges", () => {
  assertEquals(satisfies("0.112.0", ">=0.112.0 <1.0.0"), true);
  assertEquals(satisfies("1.0.0", ">=0.112.0 <1.0.0"), false);
  assertEquals(satisfies("0.112.5", "^0.112.0"), true);
  assertEquals(satisfies("0.113.0", "^0.112.0"), false);
  assertEquals(satisfies("1.9.0", "^1.2.0"), true);
  assertEquals(satisfies("0.112.0", "latest"), undefined);
});

Deno.test("088: an index anyone can host names a connector's source and tags", () => {
  const index = parseIndex(JSON.stringify({
    format: "stolos-connector-index/1",
    connectors: [{
      id: "example-scanner",
      title: "Example Scanner",
      source: "https://github.com/example/stolos-connector-example",
      tags: ["v1.0.0", "v1.1.0"],
    }],
  }));
  assertEquals(
    fromIndex(index, "example-scanner@v1.0.0"),
    "https://github.com/example/stolos-connector-example@v1.0.0",
  );
  assertEquals(
    fromIndex(index, "example-scanner"),
    "https://github.com/example/stolos-connector-example@v1.1.0",
  );
  let threw = false;
  try {
    fromIndex(index, "example-scanner@v9.0.0");
  } catch {
    threw = true;
  }
  assert(threw, "a tag the index does not list");
});

Deno.test("088: the template's declaration passes every check; each kind of fault is named", async () => {
  const d = await declare(template as unknown as Record<string, unknown>);
  assertEquals(d.id, "example-scanner");
  assertEquals(d.fixtures.map((f) => f.ok), [true, true]);
  assertEquals(declarationProblems(d, CHECK), []);
  const named = (x: Partial<typeof d>, what: string) =>
    assert(
      declarationProblems({ ...d, ...x }, CHECK).some((p) => p.includes(what)),
      `${what}: ${declarationProblems({ ...d, ...x }, CHECK).join("; ")}`,
    );
  named({ id: "github" }, "one of the engine's own connectors");
  named({ scf: ["XYZ-99"] }, "XYZ-99");
  named({ engine: ">=9.0.0" }, "this engine is");
  named({ engine: undefined }, "no engine range");
  named({ fixtures: [] }, "no fixture tests");
  named({ fixtures: [{ name: "f", ok: false, problems: ["x"] }] }, 'fixture "f" fails');
  named({ connectHelp: ["make a token"] }, "read-only credential");
  named({ sdk: false }, "defineConnector");
  // Labels: a D3FEND, OCSF, or UDM term, never a built-in redeclared.
  const bad = defineLabel({
    name: "Findings",
    terms: [{ from: "ocsf", term: "findings" }],
    doc: "",
    props: {},
  });
  const { label: _l, ...view } = bad;
  assert(labelProblems([view]).length > 0);
  const redeclared = defineLabel({
    ...VULNERABILITY.label,
    props: { cve: { type: "text", doc: "" } },
  });
  const { label: _r, ...rv } = redeclared;
  assertStringIncludes(labelProblems([rv]).join(" "), "redeclares");
  assertEquals(labelProblems([(({ label: _, ...v }) => v)(VULNERABILITY)]), []);
});

Deno.test("088: the connectors file round-trips its entries, read without running", () => {
  const e = {
    id: "example-scanner",
    title: "Example Scanner",
    source: "https://github.com/example/stolos-connector-example",
    ref: "v1.0.0",
    module: "https://raw.githubusercontent.com/example/stolos-connector-example/v1.0.0/mod.ts",
    sha256: "ab".repeat(32),
    engine: ">=0.112.0 <1.0.0",
    checkedWith: VERSION,
    fixtures: 2,
    added: "2026-11-15",
  };
  const text = registrySource([e]);
  assertStringIncludes(text, `import connector_example_scanner from "${e.module}";`);
  assertEquals(registryEntries(text), [e]);
});

/** A local "GitHub": the engine checkout at stolos/<tag>/, and connector modules at example/<repo>/<tag>/. */
function server(root: string) {
  return Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    try {
      return new Response(await Deno.readFile(`${root}${path}`), {
        headers: { "content-type": "application/typescript" },
      });
    } catch {
      return new Response("not found\n", { status: 404 });
    }
  });
}

const TEMPLATE = await Deno.readTextFile(
  new URL("../examples/connector-template/mod.ts", import.meta.url),
);

/** The template, changed, published at a tag. */
async function publish(www: string, tag: string, change: (s: string) => string = (s) => s) {
  const dir = `${www}/example/stolos-connector-example/${tag}`;
  await Deno.mkdir(dir, { recursive: true });
  const text = change(TEMPLATE);
  if (text === TEMPLATE && change.toString() !== ((s: string) => s).toString()) {
    throw new Error(`${tag}: the change did not apply`);
  }
  await Deno.writeTextFile(`${dir}/mod.ts`, text);
}

/** One run's problems, as the command line shows them. */
async function run(f: () => Promise<number>): Promise<{ code: number; problems: string[] }> {
  ui.problems.length = 0;
  const code = await f();
  return { code, problems: ui.problems.map((p) => p.message) };
}

Deno.test({
  name:
    "088: connector add pins, checks, and locks a third-party connector; refuses faults; estate observe lists it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "stolos-registry-" });
    const www = `${dir}/www`;
    await Deno.mkdir(`${www}/stolos`, { recursive: true });
    await Deno.symlink(ENGINE, `${www}/stolos/v${VERSION}`);
    const srv = server(www);
    const host = `http://127.0.0.1:${srv.addr.port}`;
    const repo = `${dir}/fleet`;
    const fleetDir = `${repo}/fleets/lab`;
    const o = { repo, fleetDir, today: "2026-11-15" };
    try {
      await Deno.mkdir(`${repo}/fleets`, { recursive: true });
      await new Deno.Command("cp", { args: ["-r", `${ENGINE}/examples/fleets/lab`, fleetDir] })
        .output();
      await Deno.writeTextFile(
        `${repo}/deno.json`,
        JSON.stringify({ imports: { "@stolos/": `${host}/stolos/v${VERSION}/src/` } }, null, 2),
      );
      await Deno.writeTextFile(
        `${repo}/stolos.ts`,
        'import { run } from "@stolos/stolos/main.ts";\n\nawait run();\n',
      );
      await publish(www, "v1.0.0");
      await publish(www, "v1.0.1", (s) => s.replace('id: "example-scanner"', 'id: "github"'));
      await publish(www, "v1.0.2", (s) =>
        s.replace(
          "label: VULNERABILITY,",
          'label: defineLabel({ name: "Findings", terms: [{ from: "ocsf", term: "findings" }], doc: "x", props: VULNERABILITY.label.props }),',
        ).replace(
          "import type { ConnectorFixture }",
          'import { defineLabel } from "@stolos/archon/schema/define.ts";\nimport type { ConnectorFixture }',
        ));
      await publish(www, "v1.0.3", (s) =>
        s.replace(
          '    fresh(o, now, "example-scanner"),',
          '    fresh(o, now, "example-scanner"),\n    { id: "made-up", title: "x", scf: ["XYZ-99"], status: "pass", detail: "" },',
        ));
      await publish(www, "v1.0.4", (s) => s.replace("vulnOpen: 2", "vulnOpen: 3"));
      const source = `${host}/example/stolos-connector-example`;
      const file = `${fleetDir}/connectors.ts`;

      // Refused, each with its reason, and nothing written.
      const refused: Array<[string, string]> = [
        ["v1.0.1", "one of the engine's own connectors"],
        ["v1.0.2", "label Findings"],
        ["v1.0.3", "XYZ-99"],
        ["v1.0.4", "vulnOpen"],
        ["main", "not a version tag"],
      ];
      for (const [tag, why] of refused) {
        const r = await run(() => connectorAdd(`${source}@${tag}`, o));
        assertEquals(r.code, 1, tag);
        assert(r.problems.some((p) => p.includes(why)), `${tag}: ${r.problems.join("; ")}`);
        assertEquals(await Deno.stat(file).then(() => true, () => false), false, tag);
      }

      // Added: the import, Stolos's lock entry, and deno.lock's hash of the same bytes.
      const ok = await run(() => connectorAdd(`${source}@v1.0.0`, o));
      assertEquals(ok, { code: 0, problems: [] });
      const text = await Deno.readTextFile(file);
      const module = `${source}/v1.0.0/mod.ts`;
      assertStringIncludes(text, `from "${module}"`);
      const [entry] = registryEntries(text);
      assertEquals(
        [entry.id, entry.ref, entry.engine, entry.fixtures, entry.checkedWith],
        ["example-scanner", "v1.0.0", template.engine, 2, VERSION],
      );
      const sha = [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TEMPLATE)),
        ),
      ]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      assertEquals(entry.sha256, sha);
      assertEquals(await lockedHash(repo, module), sha, "deno.lock holds the module's hash");
      const lock = await Deno.readTextFile(`${repo}/deno.lock`);
      assertStringIncludes(lock, `${host}/stolos/v${VERSION}/src/archon/connect/sdk.ts`);

      // A second connector with the same id from another source is refused.
      await Deno.mkdir(`${www}/other/x/v1.0.0`, { recursive: true });
      await Deno.writeTextFile(`${www}/other/x/v1.0.0/mod.ts`, TEMPLATE);
      const twice = await run(() => connectorAdd(`${host}/other/x@v1.0.0`, o));
      assertEquals(twice.code, 1);
      assert(twice.problems.some((p) => p.includes("already added")), twice.problems.join("; "));

      // list and test, at the pin.
      const out: string[] = [];
      const log = console.log;
      console.log = (x: string) => out.push(x);
      try {
        assertEquals(await connectorList(true, o), 0);
      } finally {
        console.log = log;
      }
      assertEquals(
        JSON.parse(out.join("\n")).map((e: { id: string; suits: boolean }) => [e.id, e.suits]),
        [
          ["example-scanner", true],
        ],
      );
      assertEquals((await run(() => connectorTest(undefined, o))).code, 0);

      // estate observe, as the fleet runs it: the added connector is in its list.
      const sb = await sandbox("stolos-registry-observe-");
      try {
        const r = await sb.run(
          `--config=${repo}/deno.json`,
          [`${repo}/stolos.ts`, "estate", "observe"],
          "",
          {
            ARCHON_REPO: repo,
            ARCHON_FLEET: "lab",
          },
        );
        assertStringIncludes(r.out, "Example Scanner");
        assert(!/added connector left out/.test(r.out), r.out);
      } finally {
        await Deno.remove(sb.home, { recursive: true });
      }

      // remove: the import and the entry go.
      assertEquals((await run(() => connectorRemove("example-scanner", o))).code, 0);
      assertEquals(await Deno.stat(file).then(() => true, () => false), false);
    } finally {
      await srv.shutdown();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
