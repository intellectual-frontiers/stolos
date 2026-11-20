/**
 * Spec 101-ladder: the ladder of Article 0, stated in the ontology and written into the constitution
 * and `AGENTS.md`; every file on one rung; the ontology's generated files fresh and its unions the
 * code's; and the trace and layers checks, which fail on a new finding and on a stale baseline line.
 *
 * @module
 */
import { layers } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals, proves } from "@intellectual-frontiers/commons/ts/runtime/test";
import { CODE_LISTS, definedTerms, ladder, rungs } from "../ontology/stolos/mod.ts";
import {
  between,
  generate,
  ladderTable,
  layoutList,
  turtleText,
  undefinedTerms,
  unionsText,
} from "../tools/ontology.ts";
import * as layersTool from "../tools/layers.ts";
import * as traceTool from "../tools/trace.ts";
import {
  COMMAND_TIERS,
  DATA_CLASSES,
  FILE_KINDS,
  INTEGRATION_KINDS,
  MACHINE_KINDS,
  OUTCOME_LEVELS,
  SIGNER_ROLES,
} from "../src/archon/ontology.auto.ts";
import { INTEGRATIONS } from "../src/archon/adopt/integrate.ts";
import { fileKindOf } from "../src/archon/fleet/records.ts";
import type { Tier } from "../src/archon/core/registry-types.ts";
import type { ProblemLevel } from "../src/archon/core/ui.ts";
import type { PcMachine } from "../src/archon/console/pc.ts";
import type { DataClass, SignerDef } from "../src/archon/model/types.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

const ROOT = ENGINE_ROOT;
const read = (rel: string): Promise<string> => fs.readTextFile(path.join(ROOT, rel));

/** Write files into a folder, making the folders they need. */
async function put(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await fs.ensureDir(path.dirname(path.join(root, rel)));
    await fs.writeTextFile(path.join(root, rel), text);
  }
}

proves(
  ["101-ladder FR-001"],
  "101: eight rungs in the ontology, written into the constitution and AGENTS.md",
  async () => {
    assertEquals(
      rungs.map((r) => r.values.rungNumber),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    assertEquals(
      ladder().map((r) => r.mayRelyOn.join(",")),
      ["", "0", "0,1", "0,1,2", "0,1,3", "0,1,3,4", "0,1,4,5", "0,1,2,3,4,5,6"],
    );
    const constitution = await read(".specify/memory/constitution.md");
    assert(constitution.includes("## Article 0: The Ladder (NON-NEGOTIABLE)"));
    assert(
      /\*\*Version\*\*: \d+\.\d+\.\d+/.test(constitution),
      "the constitution says its version",
    );
    assert(constitution.includes(ladderTable()), "the constitution's table is the ontology's");
    assert(
      (await read("AGENTS.md")).includes(layoutList()),
      "AGENTS.md's layout is the ontology's",
    );
    assertEquals(
      between("a <!-- x -->old<!-- y --> b", "NEW", "<!-- x -->", "<!-- y -->"),
      "a NEW b",
    );
    assertEquals(between("no markers", "NEW", "<!-- x -->", "<!-- y -->"), undefined);
  },
);

proves(
  ["101-ladder FR-002"],
  "101: every file the repository tracks, and every folder of src/archon, is on exactly one rung",
  async () => {
    const placement = (await layersTool.findings(ROOT)).filter(
      (f) => f.rule === "layers/unclassified" || f.rule === "layers/ambiguous",
    );
    assertEquals(placement, []);
    const r = await proc.run(["git", "-C", ROOT, "ls-files", "-c"]);
    const folders = [
      ...r.stdout.split("\n").filter((f) => f !== ""),
      ...(await fs.listDirs(path.join(ROOT, "src", "archon"))).map((d) => `src/archon/${d}/x.ts`),
    ];
    const unplaced = folders.filter((p) => layers.placeOf(ladder(), p).kind !== "one");
    assertEquals(unplaced, []);
    const rung = (p: string): number => {
      const x = layers.placeOf(ladder(), p);
      return x.kind === "one" ? x.rung.number : -1;
    };
    assertEquals(rung("src/archon/model/types.ts"), 2);
    assertEquals(rung("src/archon/model/load.ts"), 3);
    assertEquals(rung("src/archon/model/mod.ts"), 7);
    assertEquals(rung("src/archon/capabilities/mod.ts"), 5);
    assertEquals(rung("src/archon/ontology.auto.ts"), 0);
    assertEquals(rung("src/archon/console/pages.ts"), 6);
  },
);

proves(
  ["101-ladder FR-003", "101-ladder FR-008"],
  "101: check:layers fails on a new violation and on a stale baseline line",
  async () => {
    await fs.withTempDir(async (root) => {
      await put(root, {
        "src/archon/core/x.ts": 'import type { T } from "../model/types.ts";\n',
        "src/archon/model/types.ts": "export type T = 1;\n",
      });
      const found = await layersTool.findings(root);
      assertEquals(
        found.map((f) => f.key),
        ["layers/around src/archon/core/x.ts -> src/archon/model/types.ts"],
      );
      assertEquals(await layersTool.main([], root), 1, "a new violation fails");
      assertEquals(await layersTool.main(["--write-baseline"], root), 0);
      assertEquals(await layersTool.main([], root), 0, "held by the baseline");
      await put(root, { "src/archon/core/x.ts": "export const x = 1;\n" });
      assertEquals(await layersTool.main([], root), 1, "a stale baseline line fails");
    });
  },
);

proves(
  ["101-ladder FR-007", "101-ladder FR-008"],
  "101: check:trace fails on a file with no Spec: line and on a stale baseline line",
  async () => {
    await fs.withTempDir(async (root) => {
      await put(root, {
        "specs/001-demo/spec.md": "**Status**: Draft\n\n- **FR-001** It works.\n",
        "src/a.ts": "/** A. @module */\nexport const a = 1;\n",
        "src/b.auto.ts": "export const b = 1;\n",
      });
      const keys = (await traceTool.findings(root)).map((f) => f.key);
      assert(keys.includes("trace/no-spec-line src/a.ts"));
      assert(!keys.some((k) => k.includes("b.auto.ts")), "generated files are exempt");
      assertEquals(await traceTool.main([], root), 1, "a new finding fails");
      assertEquals(await traceTool.main(["--write-baseline"], root), 0);
      assertEquals(await traceTool.main([], root), 0, "held by the baseline");
      await put(root, { "src/a.ts": "/** A. @module */\n// Spec: 001-demo FR-001\n" });
      assertEquals(await traceTool.main([], root), 1, "a stale baseline line fails");
      const baseline = await fs.readTextFile(path.join(root, traceTool.BASELINE));
      assert(baseline.startsWith("# The trace's baseline"));
    });
    const real = await traceTool.findings(ROOT);
    assertEquals(
      real.filter((f) => f.rule !== "trace/no-spec-line").map((f) => f.key),
      [],
      "no unknown citation, no unproved requirement, no uncited term in the engine",
    );
  },
);

proves(["101-ladder FR-004"], "101: the ontology's classes, and a spec on every term", () => {
  const terms = definedTerms();
  for (const c of [
    "Fleet",
    "Host",
    "Controller",
    "AdoptedMachine",
    "Device",
    "Signer",
    "ConsoleDevice",
    "Capability",
    "Check",
    "Finding",
    "Record",
    "Decision",
  ])
    assert(terms.has(`stolos:${c}`), c);
  const cites = traceTool.ontologyCitations();
  assert(cites.length > 60, `${cites.length} terms`);
  assertEquals(
    cites.filter((c) => c.cites.length === 0).map((c) => c.term),
    [],
  );
});

proves(
  ["101-ladder FR-005"],
  "101: the generated Turtle and unions are fresh; an undefined term a spec names stops the generator",
  async () => {
    assertEquals(await generate(true), 0);
    assertEquals(await read("ontology/stolos.auto.ttl"), turtleText());
    assertEquals(await read("src/archon/ontology.auto.ts"), unionsText());
    assert(turtleText().startsWith("# AUTO-GENERATED by tools/ontology.ts"));
    assertEquals(await undefinedTerms(), []);
    await fs.withTempDir(async (root) => {
      await put(root, {
        "specs/001-demo/plan.md":
          "Uses `stolos:Controller` and `stolos:Nope`; not urn:stolos:fleet.\n",
      });
      assertEquals(await undefinedTerms(root), ["specs/001-demo/plan.md: stolos:Nope"]);
    });
    const pkg = await read("package.json");
    assert(pkg.includes('"check:ontology": "bun tools/ontology.ts --check"'));
  },
);

proves(
  ["101-ladder FR-006"],
  "101: the code's unions are the ontology's code lists, with the same words",
  () => {
    const keys = (name: keyof typeof CODE_LISTS): string[] => Object.keys(CODE_LISTS[name].list);
    assertEquals([...OUTCOME_LEVELS], keys("OutcomeLevel"));
    assertEquals([...MACHINE_KINDS], keys("MachineKind"));
    assertEquals([...SIGNER_ROLES], keys("SignerRole"));
    assertEquals([...COMMAND_TIERS], keys("CommandTier"));
    assertEquals([...DATA_CLASSES], keys("DataClass"));
    assertEquals([...INTEGRATION_KINDS], keys("IntegrationKind"));
    assertEquals([...FILE_KINDS], keys("FileKind"));
    assertEquals([...INTEGRATIONS], ["discover", "adopt", "osquery", "server", "workstation"]);
    assertEquals(fileKindOf("fleets/lab/hosts/alpha/registration.ts"), "record");
    assertEquals(fileKindOf("fleets/lab/access.ts"), "decision");
    assertEquals(fileKindOf("fleets/lab/fleet.ts"), undefined);
    // The words the code used before, still accepted, and only those.
    const tiers: Tier[] = ["read", "repo", "mutate", "destructive"];
    const problems: ProblemLevel[] = ["warn", "fail", "pending", "action"];
    const kinds: PcMachine["kind"][] = [
      "server",
      "workstation",
      "adopted",
      "device",
      "discovered",
      "cloud",
    ];
    const roles: SignerDef["role"][] = ["daily", "recovery"];
    const data: DataClass[] = ["durable", "ephemeral"];
    assertEquals(tiers.length + problems.length + kinds.length + roles.length + data.length, 18);
    // @ts-expect-error the controller is listed as adopted by the console, never as its own kind
    const controller: PcMachine["kind"] = "controller";
    assertEquals(controller, "controller");
  },
);

proves(
  ["101-ladder FR-009"],
  "101: bun run ci runs the three checks before the tests",
  async () => {
    const ci = /"ci": "([^"]*)"/.exec(await read("package.json"))?.[1] ?? "";
    const at = (s: string): number => ci.indexOf(s);
    for (const c of ["check:ontology", "check:trace", "check:layers"]) {
      assert(at(c) >= 0, c);
      assert(at(c) < at("test:ci"), `${c} runs before the tests`);
    }
  },
);

const PILOTS = ["097-controller", "098-pair", "099-engine-update", "100-remote-access"] as const;

proves(
  ["101-ladder FR-010"],
  "101: the pilot specs have plans and tasks, cite their terms, and their sources name them",
  async () => {
    const baseline = await read(traceTool.BASELINE);
    for (const spec of [...PILOTS, "101-ladder"]) {
      for (const f of ["spec.md", "plan.md", "tasks.md"])
        assert(await fs.exists(path.join(ROOT, "specs", spec, f)), `${spec}/${f}`);
      assert(
        (await read(`specs/${spec}/spec.md`)).includes("## Ontology"),
        `${spec} cites its terms`,
      );
    }
    const pilotSources = [
      "src/archon/adopt/controller.ts",
      "src/archon/adopt/pair.ts",
      "src/archon/adopt/pair-command.ts",
      "src/archon/adopt/mesh.ts",
      "src/archon/fleet/records.ts",
      "src/archon/fleet/releases.ts",
      "src/archon/update/operator.ts",
      "src/archon/console/askpass.ts",
      ...(await fs.listFiles(path.join(ROOT, "src/archon/access"), ".ts")).map(
        (f) => `src/archon/access/${f}`,
      ),
    ];
    for (const f of pilotSources) {
      const text = await read(f);
      assert(
        PILOTS.some((p) => text.includes(`// Spec: ${p}`)),
        `${f} names its pilot spec`,
      );
      assert(!baseline.includes(` ${f}\n`), `${f} is not in the trace's baseline`);
    }
  },
);
