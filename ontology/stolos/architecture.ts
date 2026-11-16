/**
 * The architecture of Stolos (constitution Article 0, spec 101-ladder FR-001 to FR-003): the ladder of eight rungs, each with its purpose,
 * its homes in the repository, the rungs it may rely on and the commands that prove it. Every folder of `src/`, every top-level folder and
 * every file of the root is on exactly one rung, by the most specific home (commons 0015-trace FR-009). `bun run gen` writes the
 * constitution's table and `AGENTS.md`'s layout from these individuals, and `bun run check:layers` holds every import to them.
 *
 * @remarks
 * The guides are the `@module` documentation of `src/**\/mod.ts` and of the few modules `core/guides.ts` names beside them, so they are
 * on rung 7; a `mod.ts` that is code, not a guide (`capabilities/mod.ts`, `personas/mod.ts`), is named on its folder's rung, since one
 * path beats every glob. The state store's schema and `archon.sql` have no file of their own: the schema is written in
 * `src/archon/state/store.ts`, which is the store (rung 3). The tests prove every rung below and so rely on all of them: they are on rung
 * 7 beside the documentation they make executable.
 *
 * @module
 */
// Spec: 101-ladder FR-001, FR-002, FR-003
import { rdf } from "@intellectual-frontiers/commons/ts/kernel";
import { RungSchema, STOLOS } from "./vocabulary.ts";

const { en, term } = rdf;

/** The spec every rung comes from. */
const SPEC = ["101-ladder FR-001"];

/** Rung 0: the ontology. */
export const rung0 = RungSchema.make(term(STOLOS, "rung-0"), {
  label: en("Ontology"),
  rungNumber: 0,
  definition: en(
    "Terms, classes and code lists, stated once as TypeScript on commons' kernel RDF; Turtle and the code's unions are generated from it.",
  ),
  home: ["ontology/", "src/archon/ontology.auto.ts"],
  provedBy: ["bun run check:ontology", "bun run check:trace"],
  spec: SPEC,
});

/** Rung 1: the specifications. */
export const rung1 = RungSchema.make(term(STOLOS, "rung-1"), {
  label: en("Specifications"),
  rungNumber: 1,
  definition: en(
    "What each part must do, in Spec Kit (specify, clarify, plan, tasks, implement), using only terms the ontology defines.",
  ),
  home: [".specify/", "specs/"],
  mayRelyOn: [rung0],
  provedBy: ["bun run check:trace", "bun run test"],
  spec: SPEC,
});

/** Rung 2: governed data. */
export const rung2 = RungSchema.make(term(STOLOS, "rung-2"), {
  label: en("Governed data"),
  rungNumber: 2,
  definition: en(
    "The shapes of what is kept: the fleet model's types and the site's, the estate's tables and the schema language and vocabulary they are declared in.",
  ),
  home: [
    "src/archon/model/types.ts",
    "src/archon/model/site.ts",
    "src/archon/estate/schema.ts",
    "src/archon/schema/",
    "src/archon/ocsf/classes.ts",
  ],
  mayRelyOn: [rung0, rung1],
  provedBy: ["bun run check", "bun run check:layers"],
  spec: SPEC,
});

/** Rung 3: data operations. */
export const rung3 = RungSchema.make(term(STOLOS, "rung-3"), {
  label: en("Data operations"),
  rungNumber: 3,
  definition: en(
    "Work as close to the data as possible: the model loaded and validated, the state store (archon.sql), the estate graph and the vault.",
  ),
  home: ["src/archon/model/", "src/archon/state/", "src/archon/estate/", "src/archon/vault/"],
  mayRelyOn: [rung0, rung1, rung2],
  provedBy: ["bun run check:layers", "bun run test"],
  spec: SPEC,
});

/** Rung 4: infrastructure rules. */
export const rung4 = RungSchema.make(term(STOLOS, "rung-4"), {
  label: en("Infrastructure rules"),
  rungNumber: 4,
  definition: en(
    "Logic every part reuses, neutral to any one service: the core (output, paths, exec, secrets), identity and keys, install, the web front door, telemetry's names, and the use of commons.",
  ),
  home: [
    "src/archon/core/",
    "src/archon/identity/",
    "src/archon/install/",
    "src/archon/web/",
    "src/archon/telemetry/",
    "src/archon/version.ts",
    "src/archon/assets.auto.ts",
    ".gitattributes",
    ".gitignore",
    ".vscode/",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "tsconfig.json",
  ],
  mayRelyOn: [rung0, rung1, rung3],
  provedBy: ["bun run check:layers", "bun run test"],
  spec: SPEC,
});

/** Rung 5: business rules. */
export const rung5 = RungSchema.make(term(STOLOS, "rung-5"), {
  label: en("Business rules"),
  rungNumber: 5,
  definition: en(
    "The engine's own logic: capabilities and what they render, compliance and controls, adopt and pair, access, update, proposals and the other services.",
  ),
  home: [
    "src/archon/access/",
    "src/archon/adopt/",
    "src/archon/apply/",
    "src/archon/audit/",
    "src/archon/backup/",
    "src/archon/build.ts",
    "src/archon/capabilities/",
    "src/archon/capabilities/mod.ts",
    "src/archon/clients/",
    "src/archon/compliance/",
    "src/archon/connect/",
    "src/archon/containers/",
    "src/archon/controls/",
    "src/archon/device/",
    "src/archon/doctor/",
    "src/archon/dotfiles/",
    "src/archon/evidence/",
    "src/archon/export/",
    "src/archon/fedramp/",
    "src/archon/fleet/",
    "src/archon/guests/",
    "src/archon/guide/",
    "src/archon/notify/",
    "src/archon/observe/",
    "src/archon/ocsf/",
    "src/archon/optin/",
    "src/archon/otelui/",
    "src/archon/people/",
    "src/archon/personas/",
    "src/archon/personas/mod.ts",
    "src/archon/pg/",
    "src/archon/proposal/",
    "src/archon/prov/",
    "src/archon/reconcile/",
    "src/archon/render/",
    "src/archon/report/",
    "src/archon/risk/",
    "src/archon/s3/",
    "src/archon/shell/",
    "src/archon/smb/",
    "src/archon/tools/",
    "src/archon/trust/",
    "src/archon/update/",
    "home/",
  ],
  mayRelyOn: [rung0, rung1, rung3, rung4],
  provedBy: ["bun run check:layers", "bun run test"],
  spec: SPEC,
});

/** Rung 6: the application, headless hosts first, then windowed hosts. */
export const rung6 = RungSchema.make(term(STOLOS, "rung-6"), {
  label: en("Application: headless hosts, then windowed hosts"),
  rungNumber: 6,
  definition: en(
    "Two bands: the headless hosts (the stolos and archon command lines and their registry, the MCP server, the REST API, the boot server, the bootstrap scripts and the harness's tools), which reach the operations below with no window, session or person present; then the windowed hosts (the Archon and Stolos consoles), which draw a model and call those operations.",
  ),
  home: [
    "src/stolos/",
    "src/archon/main.ts",
    "src/archon/commands/",
    "src/archon/mcp/",
    "src/archon/api/",
    "src/archon-boot/",
    "bin/",
    "tools/",
    ".github/",
    "src/archon/console/",
    "vendor/",
  ],
  mayRelyOn: [rung0, rung1, rung4, rung5],
  provedBy: ["bun run check:layers", "bun run test"],
  spec: SPEC,
});

/** Rung 7: the documentation. */
export const rung7 = RungSchema.make(term(STOLOS, "rung-7"), {
  label: en("Documentation"),
  rungNumber: 7,
  definition: en(
    "The guides (each module's @module documentation, src/**/mod.ts first), docs/, the manuals site (docs.config.ts), the example fleet, this repository's own documents, and the tests that prove every rung below.",
  ),
  home: [
    "src/**/mod.ts",
    "src/releasing.ts",
    "src/archon/connect/registry-guide.ts",
    "src/archon/install/workstation-guide.ts",
    "docs/",
    "docs.config.ts",
    "examples/",
    "tests/",
    "AGENTS.md",
    "LICENSE",
    "LICENSING.md",
    "README.md",
  ],
  mayRelyOn: [rung0, rung1, rung2, rung3, rung4, rung5, rung6],
  provedBy: ["bun run docs:lint", "bun run check:layers"],
  spec: SPEC,
});

/** The rungs, lowest first. */
export const rungs = [rung0, rung1, rung2, rung3, rung4, rung5, rung6, rung7] as const;
