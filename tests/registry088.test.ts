/**
 * Spec 088: the connector registry. A third-party connector is added from a pinned URL: here a
 * local "GitHub" serves the connector template (examples/connector-template) at tags, and a fleet
 * repository installs the engine (this checkout) as its package. `connector add` fetches the
 * module, checks it in a probe of its own process, runs its fixtures, copies it into the fleet
 * repository as checked, and writes the import and Stolos's lock entry (its SHA-256). It refuses a
 * clashing id, a bad label, a made-up SCF id, and failing fixtures, changing nothing; the engine
 * then loads the added connector beside its own, and leaves it out once its copy changes.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import {
  declarationProblems,
  forgetRegistry,
  fromIndex,
  labelProblems,
  loadRegistry,
  parseIndex,
  pinSource,
  registryEntries,
  registrySource,
  engineSuits,
} from "../src/archon/connect/registry.ts";
import {
  connectorAdd,
  connectorList,
  connectorRemove,
  connectorTest,
} from "../src/archon/connect/registry-commands.ts";
import { declare } from "../src/archon/connect/registry-contract.ts";
import * as template from "../examples/connector-template/mod.ts";
import { defineLabel } from "../src/archon/schema/define.ts";
import { VULNERABILITY } from "../src/archon/connect/labels.ts";
import { SCF } from "../src/archon/compliance/scf.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";
import { VERSION } from "../src/archon/version.ts";
import { ui } from "../src/archon/core/ui.ts";
import { sha256 } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path, type Server, serve, stdio } from "@intellectual-frontiers/ifc-ts/runtime";

const ENGINE = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const CHECK = {
  builtIns: CONNECTORS.map((c) => c.id),
  others: [],
  version: VERSION,
  scf: new Set(SCF.map((c) => c.id)),
};

proves(
  ["088-wave3-registry FR-001"],
  "088: a source and a tag pin a module URL; a branch or no ref is refused",
  () => {
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
    for (const bad of [
      "https://github.com/example/x@main",
      "https://github.com/example/x",
      "http://example.com/a/b@v1.0.0",
      "https://github.com/example@v1.0.0",
    ]) {
      let threw = false;
      try {
        pinSource(bad);
      } catch {
        threw = true;
      }
      assert(threw, bad);
    }
  },
);

proves(["088-wave3-registry FR-001"], "088: engine ranges", () => {
  assertEquals(engineSuits("0.112.0", ">=0.112.0 <1.0.0"), true);
  assertEquals(engineSuits("1.0.0", ">=0.112.0 <1.0.0"), false);
  assertEquals(engineSuits("0.112.5", "^0.112.0"), true);
  assertEquals(engineSuits("0.113.0", "^0.112.0"), false);
  assertEquals(engineSuits("1.9.0", "^1.2.0"), true);
  assertEquals(engineSuits("0.112.0", "latest"), undefined);
});

proves(
  ["088-wave3-registry FR-001"],
  "088: an index anyone can host names a connector's source and tags",
  () => {
    const index = parseIndex(
      JSON.stringify({
        format: "stolos-connector-index/1",
        connectors: [
          {
            id: "example-scanner",
            title: "Example Scanner",
            source: "https://github.com/example/stolos-connector-example",
            tags: ["v1.0.0", "v1.1.0"],
          },
        ],
      }),
    );
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
  },
);

proves(
  ["088-wave3-registry FR-001"],
  "088: the template's declaration passes every check; each kind of fault is named",
  async () => {
    const d = await declare({ ...template });
    assertEquals(d.id, "example-scanner");
    assertEquals(
      d.fixtures.map((f) => f.ok),
      [true, true],
    );
    assertEquals(declarationProblems(d, CHECK), []);
    const named = (x: Partial<typeof d>, what: string): void =>
      assert(
        declarationProblems({ ...d, ...x }, CHECK).some((p) => p.includes(what)),
        `${what}: ${declarationProblems({ ...d, ...x }, CHECK).join("; ")}`,
      );
    named({ id: "github" }, "one of the engine's own connectors");
    named({ scf: ["XYZ-99"] }, "XYZ-99");
    named({ engine: ">=9.0.0" }, "this engine is");
    const { engine: _engine, ...unranged } = d;
    assert(
      declarationProblems(unranged, CHECK).some((p) => p.includes("no engine range")),
      "no engine range",
    );
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
  },
);

proves(
  ["088-wave3-registry FR-001"],
  "088: the connectors file round-trips its entries, read without running",
  () => {
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
    assertStringIncludes(
      text,
      'import connector_example_scanner from "./connectors/example-scanner.ts";',
    );
    assertEquals(registryEntries(text), [e]);
  },
);

/** A local "GitHub": connector modules at example/<repo>/<tag>/mod.ts, from the folder `root`. */
function server(root: string): Promise<Server> {
  return serve({ hostname: "127.0.0.1", port: 0 }, async (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname);
    try {
      return new Response(await fs.readTextFile(`${root}${file}`), {
        headers: { "content-type": "application/typescript" },
      });
    } catch {
      return new Response("not found\n", { status: 404 });
    }
  });
}

const TEMPLATE = await fs.readTextFile(
  path.join(ENGINE, "examples", "connector-template", "mod.ts"),
);

/** The template, changed, published at a tag. */
async function publish(www: string, tag: string, change?: (s: string) => string): Promise<void> {
  const dir = `${www}/example/stolos-connector-example/${tag}`;
  await fs.mkdir(dir, { recursive: true });
  const text = change === undefined ? TEMPLATE : change(TEMPLATE);
  if (change !== undefined && text === TEMPLATE) {
    throw new Error(`${tag}: the change did not apply`);
  }
  await fs.writeTextFile(`${dir}/mod.ts`, text);
}

/** One run's problems, as the command line shows them. */
async function run(f: () => Promise<number>): Promise<{ code: number; problems: string[] }> {
  ui.problems.length = 0;
  const code = await f();
  return { code, problems: ui.problems.map((p) => p.message) };
}

/** What `f` writes to standard output (`--json`), while it runs. */
async function stdoutOf(f: () => Promise<number>): Promise<string> {
  const out: string[] = [];
  const write = stdio.stdout.writeSync.bind(stdio.stdout);
  stdio.stdout.writeSync = (d: Uint8Array | string): number => {
    out.push(typeof d === "string" ? d : new TextDecoder().decode(d));
    return d.length;
  };
  try {
    await f();
  } finally {
    stdio.stdout.writeSync = write;
  }
  return out.join("");
}

proves(
  ["088-wave3-registry FR-001"],
  "088: connector add pins, checks, copies and locks a third-party connector; refuses faults; the engine loads it",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-registry-" });
    const www = `${dir}/www`;
    await fs.mkdir(www, { recursive: true });
    const srv = await server(www);
    const host = `http://127.0.0.1:${srv.addr.port}`;
    const repo = `${dir}/fleet`;
    const fleetDir = `${repo}/fleets/lab`;
    const o = { repo, fleetDir, today: "2026-11-15" };
    try {
      // The fleet repository installs the engine (here: this checkout) as its package.
      await fs.mkdir(`${repo}/node_modules/@intellectual-frontiers`, { recursive: true });
      await fs.symlink(ENGINE, `${repo}/node_modules/@intellectual-frontiers/stolos`);
      await fs.mkdir(`${repo}/fleets`, { recursive: true });
      await fs.copy(`${ENGINE}/examples/fleets/lab`, fleetDir);
      await publish(www, "v1.0.0");
      await publish(www, "v1.0.1", (s) => s.replace('id: "example-scanner"', 'id: "github"'));
      await publish(www, "v1.0.2", (s) =>
        s
          .replace(
            "label: VULNERABILITY,",
            'label: defineLabel({ name: "Findings", terms: [{ from: "ocsf", term: "findings" }], doc: "x", props: VULNERABILITY.label.props }),',
          )
          .replace(
            "import type { ConnectorFixture }",
            'import { defineLabel } from "@intellectual-frontiers/stolos/archon/schema/define";\nimport type { ConnectorFixture }',
          ),
      );
      await publish(www, "v1.0.3", (s) =>
        s.replace(
          '    fresh(o, now, "example-scanner"),',
          '    fresh(o, now, "example-scanner"),\n    { id: "made-up", title: "x", scf: ["XYZ-99"], status: "pass", detail: "" },',
        ),
      );
      await publish(www, "v1.0.4", (s) => s.replace("vulnOpen: 2", "vulnOpen: 3"));
      const source = `${host}/example/stolos-connector-example`;
      const file = `${fleetDir}/connectors.ts`;
      const copy = `${fleetDir}/connectors/example-scanner.ts`;
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
        assert(
          r.problems.some((p) => p.includes(why)),
          `${tag}: ${r.problems.join("; ")}`,
        );
        assertEquals(await fs.exists(file), false, tag);
        assertEquals(await fs.exists(copy), false, tag);
      }
      // Added: the copy as checked, the import of it, and Stolos's lock entry with its hash.
      const ok = await run(() => connectorAdd(`${source}@v1.0.0`, o));
      assertEquals(ok, { code: 0, problems: [] });
      const text = await fs.readTextFile(file);
      assertStringIncludes(text, 'from "./connectors/example-scanner.ts"');
      assertEquals(await fs.readTextFile(copy), TEMPLATE, "the copy is the module as checked");
      const [entry] = registryEntries(text);
      assertExists(entry);
      assertEquals(
        [entry.id, entry.ref, entry.engine, entry.fixtures, entry.checkedWith, entry.module],
        ["example-scanner", "v1.0.0", template.engine, 2, VERSION, `${source}/v1.0.0/mod.ts`],
      );
      assertEquals(entry.sha256, await sha256(TEMPLATE));
      // A second connector with the same id from another source is refused.
      await fs.mkdir(`${www}/other/x/v1.0.0`, { recursive: true });
      await fs.writeTextFile(`${www}/other/x/v1.0.0/mod.ts`, TEMPLATE);
      const twice = await run(() => connectorAdd(`${host}/other/x@v1.0.0`, o));
      assertEquals(twice.code, 1);
      assert(
        twice.problems.some((p) => p.includes("already added")),
        twice.problems.join("; "),
      );
      // list and test, at the pin.
      const listed = JSON.parse(await stdoutOf(() => connectorList(true, o))) as Array<{
        id: string;
        suits: boolean;
      }>;
      assertEquals(
        listed.map((e) => [e.id, e.suits]),
        [["example-scanner", true]],
      );
      assertEquals((await run(() => connectorTest(undefined, o))).code, 0);
      // The engine loads it beside its own, while its copy hashes as locked.
      const builtIns = CONNECTORS.map((c) => c.id);
      forgetRegistry();
      const loaded = await loadRegistry(fleetDir, VERSION, builtIns);
      assertEquals(loaded.problems, []);
      assertEquals(
        loaded.connectors.map((c) => c.id),
        ["example-scanner"],
      );
      await fs.writeTextFile(copy, TEMPLATE.replace("Example Scanner", "Changed Scanner"));
      forgetRegistry();
      const changed = await loadRegistry(fleetDir, VERSION, builtIns);
      assertEquals(changed.connectors, []);
      assertStringIncludes(changed.problems.join(" "), "does not hash as connectors.ts locks it");
      assertEquals((await run(() => connectorTest(undefined, o))).code, 1);
      await fs.writeTextFile(copy, TEMPLATE);
      // remove: the import, the entry, and the copy go.
      assertEquals((await run(() => connectorRemove("example-scanner", o))).code, 0);
      assertEquals(await fs.exists(file), false);
      assertEquals(await fs.exists(copy), false);
    } finally {
      forgetRegistry();
      await srv.shutdown();
      await fs.remove(dir, { recursive: true });
    }
  },
  { timeout: 120_000 },
);
