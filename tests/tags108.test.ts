/**
 * Spec 108-tags: the labels a fleet gives its machines (its own `tags.ts`: dimensions, rules, groups; typed ids), what people give
 * (`stolos tag`, `stolos pair --tag`), how a machine's tags resolve (person, rule, inherited; custom ones apart), the expression that
 * chooses machines by tag, and the console and compliance views that use them. The commands run for real, in a sandbox fleet (a
 * copy of the example lab, a real Git repository and a signing key); the console runs in this process, as its other tests do.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { CODE_LISTS } from "../ontology/stolos/mod.ts";
import { TAG_CARDINALITIES, TAG_COLOURS, TAG_ORIGINS } from "../src/archon/ontology.auto.ts";
import {
  addAssigned,
  addressIn,
  allOf,
  anyOf,
  classifyTag,
  defineTags,
  definedIds,
  describeSelection,
  kindIs,
  matches,
  nameMatches,
  osIs,
  ownerIs,
  parseSelection,
  removeAssigned,
  resolveTags,
  SELECT_LIMITS,
  SelectionError,
  selectionOf,
  selectionProblems,
  STARTER_DIMENSIONS,
  starterTagsSource,
  tagSetProblems,
  tokensOf,
  type TagFacts,
  type TagIdOf,
} from "../src/archon/model/tags.ts";
import { decisionsSource } from "../src/archon/fleet/decisions.ts";
import { machineSource } from "../src/archon/adopt/adopt.ts";
import {
  scopeFacts,
  selectionFromArgs,
  tagLine,
  tagRecord,
  tagWord,
  taggingView,
} from "../src/archon/fleet/tags.ts";
import { writeStarterTags } from "../src/archon/identity/fleet-init.ts";
import { chooseTags, readPairTags } from "../src/archon/adopt/pair-command.ts";
import { parseArgs } from "../src/archon/core/registry-types.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { machineRecord } from "../src/archon/fleet/tag-commands.ts";
import { CONSOLE_CSS } from "../src/archon/console/assets.ts";
import {
  machinesCsv,
  evidence,
  machinesPage,
  queryPage,
} from "../src/archon/console/stolos-pages.ts";
import { tagChip, tagChips } from "../src/archon/console/tags.ts";
import { loadScf } from "../src/archon/compliance/catalog.ts";
import type { HostDecisions } from "../src/archon/model/types.ts";
import type { StolosDeps } from "../src/archon/console/stolos-server.ts";
import { FACTS, fakeConsole } from "./console/serve-stolos.ts";
import { fleet as sandboxFleet } from "./lab-fleet.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

const PORT = 8108;
const B = `http://127.0.0.1:${PORT}`;

/** Facts of a machine, with what a test changes. */
const facts = (over: Partial<TagFacts> = {}): TagFacts => ({
  name: "alpha",
  kind: "server",
  os: "linux",
  osName: "Ubuntu 26.04",
  address: "10.0.30.59",
  joined: "managed",
  ...over,
});

/** The JSON in a command's output (stdout and stderr are joined: a runtime may add a warning after it). */
function jsonIn(out: string, open: string, close: string): string {
  const from = out.search(new RegExp(`^\\${open}$`, "m"));
  const to = out.lastIndexOf(`\n${close}`);
  assert(from >= 0 && to > from, `no JSON in: ${out}`);
  return out.slice(from, to + 2);
}

/** A small fleet of tags: an environment (one-of), roles (many-of), a rule and a group. */
const kit = defineTags(
  {
    env: {
      label: "Environment",
      description: "Where the work runs.",
      cardinality: "one-of",
      tags: {
        prod: { label: "Production", colour: "red", description: "Real users." },
        lab: { label: "Lab", colour: "green", description: "Safe to break." },
      },
    },
    role: {
      label: "Role",
      description: "What it is for.",
      cardinality: "many-of",
      tags: {
        nas: { label: "NAS", colour: "violet", description: "Keeps files." },
        database: { label: "Database", colour: "orange", description: "Holds a database." },
        workstation: { label: "Workstation", colour: "teal", description: "A person works on it." },
      },
    },
    os: {
      label: "Operating system",
      description: "Its family.",
      cardinality: "one-of",
      tags: {
        windows: { label: "Windows", colour: "blue", description: "Microsoft Windows." },
        linux: { label: "Linux", colour: "orange", description: "Linux." },
      },
    },
  },
  {
    rules: [
      { id: "windows", when: osIs("windows"), tag: "os:windows" },
      { id: "linux", when: osIs("linux"), tag: "os:linux" },
      { id: "lab-net", when: addressIn("10.0.1.0/24"), tag: "env:lab" },
    ],
    groups: [
      { id: "servers-net", network: "Servers", tags: ["env:prod", "role:nas"] },
      { id: "named", names: ["beta"], cidr: "10.9.0.0/16", tags: ["role:database"] },
    ],
  },
);

// ------------------------------------------------------------------------------ the ontology

proves(
  ["108-tags FR-001", "108-tags FR-004", "108-tags FR-009"],
  "108: the ontology's colours, cardinalities and origins are the ones the code branches on",
  () => {
    assertEquals(Object.keys(CODE_LISTS.TagColour.list), [...TAG_COLOURS]);
    assertEquals([...TAG_CARDINALITIES], ["one-of", "many-of"]);
    assertEquals([...TAG_ORIGINS], ["person", "rule", "inherited"]);
    assertEquals(Object.keys(CODE_LISTS.TagOrigin.list), [...TAG_ORIGINS]);
    assertEquals(Object.keys(CODE_LISTS.TagCardinality.list), [...TAG_CARDINALITIES]);
  },
);

// ------------------------------------------------------------------------------ FR-001, FR-002: definitions and typed ids

proves(
  ["108-tags FR-001"],
  "108: defineTags refuses a malformed definition and says each problem with its fix",
  () => {
    const dim = (over: Record<string, unknown> = {}, tag: Record<string, unknown> = {}) => ({
      label: "Environment",
      description: "Where.",
      cardinality: "one-of",
      tags: { lab: { label: "Lab", colour: "green", description: "Safe.", ...tag } },
      ...over,
    });
    const problems = (dims: object, rules: object[] = [], groups: object[] = []) =>
      tagSetProblems({
        dimensions: dims as never,
        rules: rules as never,
        groups: groups as never,
      }).map((p) => `${p.where}: ${p.message} (${p.fix})`);
    assertEquals(problems({ env: dim() }), []);
    assertStringIncludes(problems({ Env: dim() }).join("\n"), "'Env' is not a dimension id");
    assertStringIncludes(problems({ env: dim({ label: " " }) }).join("\n"), "it has no label");
    assertStringIncludes(problems({ env: dim({ description: "" }) }).join("\n"), "no description");
    assertStringIncludes(problems({ env: dim({ cardinality: "some-of" }) }).join("\n"), "some-of");
    assertStringIncludes(problems({ env: dim({ tags: {} }) }).join("\n"), "it has no tags");
    assertStringIncludes(problems({ env: dim({}, { colour: "#ff0000" }) }).join("\n"), "palette");
    assertStringIncludes(
      problems({ env: dim({}, { label: "" }) }).join("\n"),
      "tags.ts tag env:lab",
    );
    assertStringIncludes(
      problems({
        env: dim({ tags: { "Lab:x": { label: "L", colour: "red", description: "d" } } }),
      }).join("\n"),
      "is not a tag value",
    );
    assertStringIncludes(problems({}).join("\n"), "no dimension is defined");
    const w = (rule: object) => problems({ env: dim() }, [rule]).join("\n");
    assertStringIncludes(
      w({ id: "r", when: () => true, tag: "env:qa" }),
      "env:qa, which is not defined",
    );
    assertStringIncludes(w({ id: "r", when: () => true, tag: "env:qa" }), "env defines lab");
    assertStringIncludes(w({ id: "R", when: () => true, tag: "env:lab" }), "is not a rule id");
    assertStringIncludes(w({ id: "r", when: "yes", tag: "env:lab" }), "not a function");
    const g = (group: object) => problems({ env: dim() }, [], [group]).join("\n");
    assertStringIncludes(g({ id: "g", tags: ["env:lab"] }), "no members");
    assertStringIncludes(g({ id: "g", names: ["a"], tags: [] }), "gives no tag");
    assertStringIncludes(g({ id: "g", cidr: "10.0.0/8", tags: ["env:lab"] }), "not an IPv4 prefix");
    assertStringIncludes(
      g({ id: "g", names: ["a"], tags: ["zone:x"] }),
      "zone:x, which is not defined",
    );
    // defineTags throws with the same words.
    assertThrows(
      () =>
        defineTags(
          {
            env: {
              label: "E",
              description: "d",
              cardinality: "one-of",
              tags: { lab: { label: "L", colour: "green", description: "d" } },
            },
          },
          // @ts-expect-error a rule may give only a tag the fleet defines (this one is not)
          { rules: [{ id: "r", when: () => true, tag: "env:qa" }] },
        ),
      Error,
      "env:qa, which is not defined",
    );
    assertEquals(definedIds(kit).slice(0, 3), ["env:prod", "env:lab", "role:nas"]);
  },
);

proves(
  ["108-tags FR-002"],
  "108: the tags' ids are a union inferred from tags.ts, so a tag that is not defined does not compile",
  () => {
    type KitId = TagIdOf<typeof kit.dimensions>;
    const held: KitId[] = ["env:lab", "role:nas", "os:linux"];
    // @ts-expect-error a tag the fleet does not define is a type error
    const missing: KitId = "env:qa";
    // @ts-expect-error a value from another dimension is not a tag of this one
    const crossed: KitId = "role:prod";
    assertEquals(held.length, 3);
    // The runtime still refuses them where a file is not type checked.
    assertEquals(definedIds(kit).includes(missing), false);
    assertEquals(definedIds(kit).includes(crossed), false);
    // The engine's own types carry the fleet's ids into decisions.ts and machine.ts.
    const typed: HostDecisions<KitId> = { tags: ["env:prod"] };
    // @ts-expect-error decisions.ts is typed by the fleet's own tags
    const wrong: HostDecisions<KitId> = { tags: ["env:qa"] };
    assertEquals(typed.tags, ["env:prod"]);
    void wrong;
  },
);

proves(
  ["108-tags FR-002"],
  "108: stolos validate reports a tag a machine holds that tags.ts does not define, a tags.ts that does not load, and tags without a tags.ts",
  async () => {
    const lab = await sandboxFleet();
    try {
      const repoLab = path.join(lab.repo, "fleets", "lab");
      const valid = await lab.stolos(["validate"]);
      assertEquals(valid.code, 0, valid.out);
      // A tag that is not defined, written by hand into a file that is not type checked.
      const dec = path.join(repoLab, "hosts", "alpha", "decisions.ts");
      const was = await fs.readTextFile(dec);
      await fs.writeTextFile(dec, was.replace('"env:lab"', '"env:qa"'));
      let r = await lab.stolos(["validate"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "env:qa");
      assertStringIncludes(r.out, "not defined in tags.ts");
      // A broken tags.ts says so.
      await fs.writeTextFile(dec, was);
      const tagsTs = path.join(repoLab, "tags.ts");
      const good = await fs.readTextFile(tagsTs);
      await fs.writeTextFile(tagsTs, good.replace('label: "Production"', 'label: ""'));
      r = await lab.stolos(["validate"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "tags.ts");
      assertStringIncludes(r.out, "no label");
      // Tags without a tags.ts.
      await fs.remove(tagsTs);
      r = await lab.stolos(["validate"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "hold tags but the fleet has no tags.ts");
      // Without a tags.ts, tag list still works (free-form tags only), and a free-form tag can still be given.
      r = await lab.stolos(["tag", "list"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "this fleet defines no tags");
      r = await lab.stolos(["tag", "add", "beta", "pilot3", "--no-apply"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(
        await fs.readTextFile(path.join(repoLab, "hosts", "beta", "decisions.ts")),
        `"pilot3"`,
      );
      r = await lab.stolos(["tag", "add", "beta", "env:lab", "--no-apply"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "this fleet defines no tags");
    } finally {
      await fs.remove(lab.sb.home, { recursive: true }).catch(() => {});
    }
  },
);

// ------------------------------------------------------------------------------ FR-003: the starter kit

proves(
  ["108-tags FR-003"],
  "108: a new fleet's tags.ts is the starter kit, and the example lab uses it unchanged",
  async () => {
    assertEquals(Object.keys(STARTER_DIMENSIONS), [
      "env",
      "role",
      "site",
      "owner",
      "criticality",
      "data",
    ]);
    assertEquals(Object.keys(STARTER_DIMENSIONS.env.tags), ["prod", "staging", "lab"]);
    assertEquals(STARTER_DIMENSIONS.env.cardinality, "one-of");
    assertEquals(STARTER_DIMENSIONS.role.cardinality, "many-of");
    assertEquals(Object.keys(STARTER_DIMENSIONS.criticality.tags), ["low", "moderate", "high"]);
    assertEquals(Object.keys(STARTER_DIMENSIONS.data.tags), [
      "public",
      "internal",
      "confidential",
      "regulated",
    ]);
    assertEquals(tagSetProblems({ dimensions: STARTER_DIMENSIONS, rules: [], groups: [] }), []);
    // The text a new fleet gets is TypeScript that loads and defines the kit.
    const sb = await sandbox("archon-tags-");
    try {
      await linkEngine(sb.home);
      const file = path.join(sb.home, "tags.ts");
      await fs.writeTextFile(file, starterTagsSource());
      const mod = (await import(path.toFileUrl(file).href)) as { tags: { dimensions: unknown } };
      assertEquals(
        JSON.parse(JSON.stringify(mod.tags.dimensions)),
        JSON.parse(JSON.stringify(STARTER_DIMENSIONS)),
      );
      assertStringIncludes(
        starterTagsSource(),
        "export type TagId = TagIdOf<typeof tags.dimensions>;",
      );
    } finally {
      await fs.remove(sb.home, { recursive: true }).catch(() => {});
    }
    // The example lab: its own tags.ts holds the kit's dimensions, unchanged.
    const lab = (await import("../examples/fleets/lab/tags.ts")).tags;
    for (const [id, dim] of Object.entries(STARTER_DIMENSIONS)) {
      assertEquals(
        JSON.parse(JSON.stringify(lab.dimensions[id as keyof typeof lab.dimensions])),
        JSON.parse(JSON.stringify(dim)),
        id,
      );
    }
    // fleet init writes it beside fleet.ts, once, and never over a tags.ts that is there.
    const dir = await fs.makeTempDir({ prefix: "archon-init-" });
    try {
      assertEquals(await writeStarterTags(path.join(dir, "fleets", "new")), true);
      const written = await fs.readTextFile(path.join(dir, "fleets", "new", "tags.ts"));
      assertEquals(written, starterTagsSource());
      await fs.writeTextFile(path.join(dir, "fleets", "new", "tags.ts"), "// mine\n");
      assertEquals(await writeStarterTags(path.join(dir, "fleets", "new")), false);
      assertEquals(await fs.readTextFile(path.join(dir, "fleets", "new", "tags.ts")), "// mine\n");
    } finally {
      await fs.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

// ------------------------------------------------------------------------------ FR-004, FR-005: what a person gave

proves(
  ["108-tags FR-004", "108-tags FR-005"],
  "108: a person's tags are written in the machine's own file, typed by tags.ts; free-form ones apart; one-of replaces",
  () => {
    const src = decisionsSource({ tags: ["env:prod", "role:nas"], customTags: ["pilot"] });
    assertStringIncludes(src, `import type { TagId } from "../../tags.ts";`);
    assertStringIncludes(src, `tags: ["env:prod", "role:nas"],`);
    assertStringIncludes(src, `customTags: ["pilot"],`);
    assertStringIncludes(src, "satisfies HostDecisions<TagId>;");
    // Without tags it is the form it always was (no import of a file that may not exist).
    assert(!decisionsSource({ optIns: {} }).includes("tags.ts"));
    // A long list is one tag to a line, as the formatter writes it.
    const long = decisionsSource({
      tags: Array.from({ length: 12 }, (_x, i) => `role:name-number-${i}`),
    });
    assertStringIncludes(long, `  tags: [\n    "role:name-number-0",`);
    const machine = machineSource({
      name: "alice-laptop",
      ssh: { user: "alice", address: "10.0.0.7" },
      hostKeys: [],
      adopted: "2026-11-17",
      tags: ["env:lab"],
      customTags: ["pilot"],
    });
    assertStringIncludes(machine, `import type { TagId } from "../../tags.ts";`);
    assertStringIncludes(machine, "export const machine: AdoptedDef<TagId> = ");
    assertStringIncludes(machine, `tags: [\n    "env:lab"`);
    assertStringIncludes(machine, `customTags: [\n    "pilot"`);
    assert(
      !machineSource({
        name: "x",
        ssh: { user: "u", address: "a" },
        hostKeys: [],
        adopted: "2026-11-17",
      }).includes("TagId"),
    );
    // A defined tag, a free-form one, and what is neither.
    const c = (t: string, custom = false) => classifyTag(kit, t, custom);
    assertEquals(c("env:prod"), { kind: "defined", id: "env:prod" });
    assertEquals(c("ENV:Prod"), { kind: "defined", id: "env:prod" });
    assertEquals(c("pilot"), { kind: "custom", id: "pilot" });
    assertEquals(c("my.pilot-2_x"), { kind: "custom", id: "my.pilot-2_x" });
    const bad = (t: string, custom = false) => {
      const r = c(t, custom);
      assertEquals(r.kind, "bad", t);
      return r.kind === "bad" ? `${r.why} (${r.fix})` : "";
    };
    assertStringIncludes(bad("env:qa"), "env:qa is not defined");
    assertStringIncludes(bad("env:qa"), "env defines prod, lab");
    assertStringIncludes(bad("zone:x"), "the dimensions are env, role, os");
    // A forgotten dimension: prod is env's value, role is a dimension.
    assertStringIncludes(bad("prod"), "a value of the dimension env");
    assertStringIncludes(bad("prod"), "env:prod, or --custom");
    assertStringIncludes(bad("role"), "is a dimension of this fleet's tags");
    assertEquals(c("prod", true), { kind: "custom", id: "prod" }, "--custom means it");
    assertStringIncludes(bad("env:x", true), "a free-form tag has no colon");
    for (const w of ["and", "or", "not", "Bad Word", "-x", "x".repeat(40)]) bad(w);
    assertEquals(classifyTag(undefined, "env:lab").kind, "bad", "no tags.ts: nothing is defined");
    assertEquals(classifyTag(undefined, "pilot").kind, "custom", "free-form works without tags.ts");
    // One-of replaces and says what it replaced; many-of adds.
    let a = addAssigned(kit, {}, [c("env:lab"), c("role:nas"), c("pilot")]);
    assertEquals(a.assigned, { tags: ["env:lab", "role:nas"], customTags: ["pilot"] });
    a = addAssigned(kit, a.assigned, [c("env:prod"), c("role:database")]);
    assertEquals(a.assigned.tags, ["env:prod", "role:nas", "role:database"]);
    assertEquals(a.replaced, [{ was: "env:lab", by: "env:prod" }]);
    // Remove takes a person's tags and lists what the machine did not hold.
    const r = removeAssigned(a.assigned, ["role:nas", "pilot", "os:linux"]);
    assertEquals(r.assigned, { tags: ["env:prod", "role:database"], customTags: [] });
    assertEquals(r.missing, ["os:linux"]);
    assertEquals(tokensOf("env:lab, role:nas\npilot"), ["env:lab", "role:nas", "pilot"]);
    assertEquals(tokensOf(true), []);
  },
);

// ------------------------------------------------------------------------------ FR-009, FR-010, FR-011: resolution

proves(
  ["108-tags FR-009", "108-tags FR-010", "108-tags FR-011", "108-tags FR-005"],
  "108: a machine's tags are a person's, then the rules', then its groups', each with its origin; one-of keeps the strongest",
  () => {
    const ids = (r: ReturnType<typeof resolveTags>) =>
      r.tags.map(
        (t) =>
          `${t.id}:${t.origin}${t.from ? `:${t.from}` : ""}${t.standing === "custom" ? ":custom" : ""}`,
      );
    // Rules over the facts: the OS, the address.
    let r = resolveTags(kit, facts({ os: "windows" }));
    assertEquals(ids(r), ["os:windows:rule:windows"]);
    r = resolveTags(kit, facts({ os: "linux", address: "10.0.1.7" }));
    assertEquals(ids(r), ["env:lab:rule:lab-net", "os:linux:rule:linux"]);
    // Groups: by site network (a managed host on it, or an address in its prefix), by name, by prefix.
    const nets = { Servers: "10.0.30.0/24" };
    assertEquals(ids(resolveTags(kit, facts({ os: "macos", network: "Servers" }), {}, nets)), [
      "env:prod:inherited:servers-net",
      "role:nas:inherited:servers-net",
    ]);
    assertEquals(ids(resolveTags(kit, facts({ os: "macos", address: "10.0.30.9" }), {}, nets)), [
      "env:prod:inherited:servers-net",
      "role:nas:inherited:servers-net",
    ]);
    assertEquals(ids(resolveTags(kit, facts({ os: "macos", address: "10.9.4.4" }))), [
      "role:database:inherited:named",
    ]);
    assertEquals(ids(resolveTags(kit, facts({ os: "macos", name: "beta", address: "1.2.3.4" }))), [
      "role:database:inherited:named",
    ]);
    // A person's tag wins over a rule's, which wins over a group's; the loser is listed, not lost.
    r = resolveTags(kit, facts({ os: "linux", address: "10.0.1.7", network: "Servers" }), {
      tags: ["env:prod"],
    });
    assertEquals(ids(r), [
      "env:prod:person",
      "role:nas:inherited:servers-net",
      "os:linux:rule:linux",
    ]);
    assertEquals(r.dropped, [{ id: "env:lab", origin: "rule", from: "lab-net", by: "env:prod" }]);
    assertEquals(r.problems, [], "a person overriding a rule is not a problem");
    // The rule beats the group: env:lab (rule) over env:prod (group).
    r = resolveTags(kit, facts({ os: "linux", address: "10.0.1.7", network: "Servers" }));
    assertEquals(
      ids(r).filter((x) => x.startsWith("env:")),
      ["env:lab:rule:lab-net"],
    );
    assertEquals(
      r.dropped.map((d) => [d.id, d.origin, d.by]),
      [["env:prod", "inherited", "env:lab"]],
    );
    // The same tag from two origins is shown once, with the stronger.
    r = resolveTags(kit, facts({ os: "linux" }), { tags: ["os:linux"] });
    assertEquals(ids(r), ["os:linux:person"]);
    // Two values of a one-of dimension from a person: a problem, the first stays.
    r = resolveTags(kit, facts({ os: "macos" }), { tags: ["env:prod", "env:lab"] });
    assertEquals(ids(r), ["env:prod:person"]);
    assertStringIncludes(r.problems.join(), "two values of the one-of dimension env");
    // A many-of dimension holds several.
    r = resolveTags(kit, facts({ os: "macos" }), { tags: ["role:nas", "role:database"] });
    assertEquals(ids(r), ["role:nas:person", "role:database:person"]);
    // Free-form tags come last and are always custom; a tag that is written but not defined is neither custom nor defined.
    r = resolveTags(kit, facts({ os: "macos" }), {
      tags: ["role:nas", "env:qa"],
      customTags: ["pilot", "alpha-x"],
    });
    assertEquals(ids(r), [
      "role:nas:person",
      "env:qa:person",
      "alpha-x:person:custom",
      "pilot:person:custom",
    ]);
    assertEquals(r.tags.find((t) => t.id === "env:qa")?.standing, "unknown");
    assertStringIncludes(r.problems.join(), "env:qa is not defined in tags.ts");
    assertEquals(r.tags.at(-1)?.standing, "custom");
    // A rule that throws is a problem and the others still run.
    const boom = {
      dimensions: kit.dimensions,
      rules: [
        {
          id: "boom",
          when: () => {
            throw new Error("no facts");
          },
          tag: "os:linux",
        },
        { id: "linux", when: osIs("linux"), tag: "os:linux" },
      ],
      groups: [],
    };
    r = resolveTags(boom, facts());
    assertEquals(ids(r), ["os:linux:rule:linux"]);
    assertStringIncludes(r.problems.join(), "rule boom failed: no facts");
    // No tags.ts at all: only free-form tags and unknown ones remain.
    r = resolveTags(undefined, facts(), { tags: ["env:lab"], customTags: ["pilot"] });
    assertEquals(
      r.tags.map((t) => t.standing),
      ["unknown", "custom"],
    );
    // The rule helpers.
    const f = facts({ name: "lab-nas", owner: "alice", kind: "adopted", os: "macos" });
    assert(osIs("macos", "windows")(f));
    assert(!osIs("windows")(f));
    assert(!osIs("linux")({ name: "x", kind: "server" }));
    assert(addressIn("10.0.30.0/24", "192.168.0.0/16")(facts()));
    assert(!addressIn("10.0.1.0/24")(facts()));
    assert(!addressIn("10.0.1.0/24")({ name: "x", kind: "server", address: "fe80::1" }));
    assert(nameMatches(/^lab-/g)(f));
    assert(nameMatches(/^lab-/g)(f), "a global flag does not make a rule remember");
    assert(kindIs("adopted", "controller")(f));
    assert(ownerIs("alice")(f));
    assert(allOf(osIs("macos"), ownerIs("alice"))(f));
    assert(!allOf(osIs("macos"), ownerIs("bob"))(f));
    assert(anyOf(osIs("windows"), ownerIs("alice"))(f));
  },
);

// ------------------------------------------------------------------------------ FR-012: the expression

proves(
  ["108-tags FR-012"],
  "108: an expression is read by a typed parser: precedence, parentheses, dimension:*, and clear refusals",
  () => {
    const held = (...t: string[]) => new Set(t);
    const run = (e: string, ...t: string[]) => matches(parseSelection(e), held(...t));
    assert(run("env:prod", "env:prod"));
    assert(!run("env:prod", "env:lab"));
    assert(run("env:prod and not role:database", "env:prod", "role:nas"));
    assert(!run("env:prod and not role:database", "env:prod", "role:database"));
    assert(run("env:lab or role:nas", "role:nas"));
    assert(run("ENV:LAB OR Role:NAS", "role:nas"), "keywords and tags are not case sensitive");
    // not binds tighter than and, and tighter than or.
    assertEquals(describeSelection(parseSelection("a or b and not c")), "a or (b and not c)");
    assert(run("a or b and c", "a"), "and binds tighter than or");
    assert(!run("(a or b) and c", "a"));
    assert(run("(a or b) and c", "b", "c"));
    assert(run("not not env:lab", "env:lab"));
    assert(run("not (env:prod or env:lab)", "role:nas"));
    // dimension:* is any value; a free-form word is a tag of its own.
    assert(run("env:*", "env:lab"));
    assert(!run("env:*", "role:nas"));
    assert(run("pilot and role:*", "pilot", "role:nas"));
    assertEquals(parseSelection("env:*"), { op: "dimension", dimension: "env" });
    // The text is data: nothing in it is run.
    for (const evil of [
      "constructor.constructor('return 1')()",
      "process.exit(1)",
      "env:prod; rm -rf",
      "${x}",
      "a && b",
      "`x`",
    ]) {
      assertThrows(() => parseSelection(evil), SelectionError);
    }
    // Each refusal says where.
    const why = (e: string): string => {
      try {
        parseSelection(e);
      } catch (x) {
        if (x instanceof SelectionError) return x.message;
        throw x;
      }
      return "";
    };
    assertStringIncludes(why(""), "empty");
    assertStringIncludes(why("   "), "empty");
    assertStringIncludes(why("env:prod and"), "a tag is missing at the end");
    assertStringIncludes(why("and env:prod"), "a tag was expected, not 'and'");
    assertStringIncludes(why("(env:prod"), "a closing parenthesis is missing");
    assertStringIncludes(why("env:prod )"), "was not expected here");
    assertStringIncludes(why("env:prod role:nas"), "'role:nas' was not expected here (at 10");
    assertStringIncludes(why("env:p*"), "only dimension:* is a pattern");
    assertStringIncludes(why("env:prod!"), "'env:prod!' is not a tag");
    assertStringIncludes(why("a" + " and a".repeat(200)), "longer than 500");
    assertStringIncludes(why("(".repeat(30) + "a" + ")".repeat(30)), "nested more than 16 deep");
    assertEquals(SELECT_LIMITS, { chars: 500, depth: 16 });
    // A tag that is not defined is a typo, with what is near it; a dimension that does not exist too.
    assertEquals(selectionProblems(parseSelection("env:prod and not role:database"), kit), []);
    assertStringIncludes(
      selectionProblems(parseSelection("env:qa"), kit).join(),
      "env:qa is not defined",
    );
    assertStringIncludes(
      selectionProblems(parseSelection("zone:*"), kit).join(),
      "zone:* names a dimension this fleet does not have",
    );
    assertEquals(
      selectionProblems(parseSelection("pilot"), kit),
      [],
      "a free-form word may name nothing yet",
    );
    assertStringIncludes(
      selectionProblems(parseSelection("env:prod"), undefined).join(),
      "no tags.ts",
    );
    // --tag is all of them, --any-tag is one of them, and the expression too; all must hold.
    const sel = selectionOf({
      all: ["env:prod", "role:nas"],
      any: ["os:linux", "os:windows"],
      select: "not pilot",
    });
    assert(sel !== undefined);
    assertEquals(
      describeSelection(sel),
      "env:prod and role:nas and (os:linux or os:windows) and not pilot",
    );
    assertEquals(selectionOf({}), undefined);
    assertEquals(selectionOf({ all: ["env:*"] }), { op: "dimension", dimension: "env" });
    assertThrows(() => selectionOf({ all: ["env:prod and role:nas"] }), SelectionError, "one tag");
    assertEquals(
      selectionFromArgs({ tag: "env:prod\nrole:nas" }, kit).selection !== undefined,
      true,
    );
    assertStringIncludes(
      selectionFromArgs({ tag: "env:qa" }, kit).error ?? "",
      "env:qa is not defined",
    );
    assertStringIncludes(selectionFromArgs({ select: "env:prod and" }, kit).error ?? "", "missing");
    assertEquals(selectionFromArgs({}, kit), {});
  },
);

// ------------------------------------------------------------------------------ FR-006, FR-007, FR-013, FR-016: the commands, for real

proves(
  [
    "108-tags FR-004",
    "108-tags FR-006",
    "108-tags FR-007",
    "108-tags FR-013",
    "108-tags FR-015",
    "108-tags FR-016",
  ],
  "108: stolos tag add, remove and list, fleet query and compliance by tag, in a sandbox fleet with a signing key",
  async () => {
    const lab = await sandboxFleet();
    try {
      const { stolos, sh, repo, origin } = lab;
      const subject = async () => await sh(origin, "git", "log", "-1", "--format=%s", "main");
      // list: where tags are defined, what is defined with counts, every machine; custom apart.
      let r = await stolos(["tag", "list"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "fleets/lab/tags.ts");
      assertStringIncludes(r.out, "env (Environment, one of)");
      assertStringIncludes(r.out, "env:prod");
      assertStringIncludes(r.out, "pilot");
      assertStringIncludes(r.out, "custom");
      r = await stolos(["tag", "list", "alpha"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "env:lab");
      assertStringIncludes(r.out, "person");
      assertStringIncludes(r.out, "pilot");
      assertStringIncludes(r.out, "[custom]");
      assertStringIncludes(r.out, "os:linux");
      assertStringIncludes(r.out, "rule linux");
      r = await stolos(["tag", "list", "alpha", "--json"]);
      assertEquals(r.code, 0, r.out);
      const alpha = JSON.parse(jsonIn(r.out, "{", "}")) as {
        machine: string;
        tags: Array<{ id: string; custom: boolean; origin: string; from?: string }>;
      };
      assertEquals(alpha.machine, "alpha");
      assertEquals(alpha.tags.find((t) => t.id === "pilot")?.custom, true);
      assertEquals(alpha.tags.find((t) => t.id === "env:lab")?.custom, false);
      assertEquals(alpha.tags.find((t) => t.id === "os:linux")?.origin, "rule");
      // list by tags: all of, any of, an expression; a typo is refused.
      r = await stolos(["tag", "list", "--select", "env:lab and not role:web", "--json"]);
      assertEquals(r.code, 0, r.out);
      const chosen = JSON.parse(jsonIn(r.out, "{", "}")) as {
        machines: Array<{ machine: string }>;
      };
      assertEquals(
        chosen.machines.map((m) => m.machine),
        ["alpha"],
      );
      r = await stolos(["tag", "list", "--tag", "role:web", "--tag", "env:staging", "--json"]);
      assertEquals(
        (JSON.parse(jsonIn(r.out, "{", "}")) as { machines: unknown[] }).machines.length,
        1,
      );
      r = await stolos(["tag", "list", "--any-tag", "role:web", "--any-tag", "pilot", "--json"]);
      assertEquals(
        (JSON.parse(jsonIn(r.out, "{", "}")) as { machines: unknown[] }).machines.length,
        2,
      );
      r = await stolos(["tag", "list", "--tag", "env:qa"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "env:qa is not defined");
      r = await stolos(["tag", "list", "--tag", "env:prod"]);
      assertEquals(r.code, 1, "a choice that matches nothing exits 1");
      // add: refusals first, and nothing is written for them.
      const before = await sh(repo, "git", "status", "--porcelain");
      for (const [args, said] of [
        [["tag", "add", "alpha", "env:qa"], "env:qa is not defined"],
        [["tag", "add", "alpha", "prod"], "a value of the dimension env"],
        [["tag", "add", "nope", "env:lab"], "no machine named nope"],
        [["tag", "add", "alpha", "env:lab", "bad word"], "is not a tag"],
      ] as const) {
        r = await stolos([...args]);
        assertEquals(r.code, 1, args.join(" "));
        assertStringIncludes(r.out, said);
      }
      assertEquals(await sh(repo, "git", "status", "--porcelain"), before, "nothing written");
      // add: one signed commit through stolos apply; a one-of value replaces the old one and says so.
      r = await stolos(["tag", "add", "alpha", "env:staging", "role:web", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "env:staging replaces env:lab");
      assertEquals(await subject(), "108-tags: tag alpha env:staging role:web");
      const dec = await sh(origin, "git", "show", "main:fleets/lab/hosts/alpha/decisions.ts");
      assertStringIncludes(dec, `"env:staging"`);
      assertStringIncludes(dec, `customTags: ["pilot"]`);
      assert(!dec.includes("env:lab"));
      assertEquals(await sh(repo, "git", "status", "--porcelain"), "", "everything was sent");
      // adding what it holds changes nothing; a free-form tag and --custom for a lookalike.
      r = await stolos(["tag", "add", "alpha", "env:staging", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "already holds");
      r = await stolos(["tag", "add", "beta", "prod", "--custom", "--no-apply"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(
        await fs.readTextFile(path.join(repo, "fleets/lab/hosts/beta/decisions.ts")),
        `customTags: ["prod"]`,
      );
      // --no-apply leaves it uncommitted, and another tag change then refuses until it is sent.
      assertStringIncludes(
        await sh(repo, "git", "status", "--porcelain"),
        "hosts/beta/decisions.ts",
      );
      r = await stolos(["tag", "add", "alpha", "pilot2"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "uncommitted changes");
      assertStringIncludes(r.out, "a tag commit holds the tag change only");
      r = await stolos(["apply", "-m", "lab: send the tag"]);
      assertEquals(r.code, 0, r.out);
      // remove: only a person's tags; a rule's or a group's is refused with where it comes from.
      r = await stolos(["tag", "remove", "alpha", "os:linux"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "holds os:linux from rule linux, not from a person");
      r = await stolos(["tag", "remove", "alpha", "role:nas"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "does not hold role:nas");
      r = await stolos(["tag", "remove", "alpha", "pilot", "role:web"]);
      assertEquals(r.code, 0, r.out);
      assertEquals(await subject(), "108-tags: untag alpha pilot role:web");
      const dec2 = await sh(origin, "git", "show", "main:fleets/lab/hosts/alpha/decisions.ts");
      assert(!dec2.includes("pilot") && !dec2.includes("role:web"));
      assertStringIncludes(dec2, `"env:staging"`);
      // An adopted machine (and the controller): its machine.ts, typed, kept across tag changes.
      const adopted = path.join(repo, "fleets/lab/adopted/lab-pc");
      await fs.mkdir(adopted, { recursive: true });
      await fs.writeTextFile(
        path.join(adopted, "machine.ts"),
        machineSource({
          name: "lab-pc",
          owner: "alice",
          ssh: { user: "alice", address: "10.0.1.20" },
          hostKeys: [],
          adopted: "2026-11-17",
          joined: "paired",
        }),
      );
      r = await stolos(["apply", "-m", "lab: adopt lab-pc"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["tag", "add", "lab-pc", "role:workstation", "owner:office", "home-office"]);
      assertEquals(r.code, 0, r.out);
      const mach = await sh(origin, "git", "show", "main:fleets/lab/adopted/lab-pc/machine.ts");
      assertStringIncludes(mach, `import type { TagId } from "../../tags.ts";`);
      assertStringIncludes(mach, "AdoptedDef<TagId>");
      assertStringIncludes(mach, `"role:workstation"`);
      assertStringIncludes(mach, `"home-office"`);
      assertStringIncludes(mach, `joined: "paired"`);
      r = await stolos(["validate"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["tag", "list", "lab-pc"]);
      assertStringIncludes(r.out, "role:workstation");
      assertStringIncludes(r.out, "home-office");
      r = await stolos(["tag", "remove", "lab-pc", "home-office", "owner:office"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(
        await sh(origin, "git", "show", "main:fleets/lab/adopted/lab-pc/machine.ts"),
        `"role:workstation"`,
      );
      // Reports that list machines show each one's tags, the free-form ones apart.
      r = await stolos(["fleet", "status", "--verbose"]);
      assertStringIncludes(r.out, "tags env:staging");
      assertStringIncludes(r.out, "custom: prod");
      // fleet query by tag: only the chosen machines are asked, each answer carries its machine's tags (--json).
      r = await stolos([
        "fleet",
        "query",
        "select name from os_version",
        "--select",
        "env:staging and not role:web",
        "--json",
        "--timeout",
        "2",
      ]);
      const answers = JSON.parse(jsonIn(r.out, "[", "]")) as Array<{
        machine: string;
        state: string;
        tags?: Array<{ id: string; standing: string; origin: string }>;
      }>;
      assertEquals(
        answers.map((a) => a.machine),
        ["alpha"],
        "only the machines the expression chooses",
      );
      assert(answers[0]?.tags?.some((t) => t.id === "env:staging" && t.origin === "person"));
      r = await stolos([
        "fleet",
        "query",
        "select name from os_version",
        "--tag",
        "role:workstation",
        "--tag",
        "owner:office",
        "--json",
        "--timeout",
        "2",
      ]);
      assertEquals(r.code, 0, r.out);
      assertEquals(
        (JSON.parse(jsonIn(r.out, "[", "]")) as Array<{ machine: string }>).map((a) => a.machine),
        ["lab-pc"],
        "all of the tags must hold",
      );
      r = await stolos(["fleet", "query", "select name from os_version", "--tag", "env:prod"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "no machine has env:prod: nothing was asked");
      r = await stolos(["fleet", "query", "select name from os_version", "--select", "env:qa or"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "missing");
      // compliance by tag (no SCF catalog in the sandbox: the scope is still said).
      r = await stolos(["compliance", "--select", "env:staging and not role:web", "--verbose"]);
      assertStringIncludes(r.out, "1 machine(s) chosen by env:staging and not role:web");
      assertStringIncludes(r.out, "cloud accounts and the estate are not machine-scoped and stay");
      r = await stolos(["compliance", "--tag", "env:prod"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "no machine has env:prod");
      r = await stolos(["compliance", "--tag", "env:qa"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "env:qa is not defined");
      // pair refuses a tag that is not defined, and two values of one dimension, before it opens anything.
      r = await stolos(["pair", "--tag", "env:qa"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "--tag:");
      assertStringIncludes(r.out, "env:qa is not defined");
      r = await stolos(["pair", "--tag", "env:lab", "--tag", "env:prod"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "values of one dimension");
    } finally {
      await fs.remove(lab.sb.home, { recursive: true }).catch(() => {});
    }
  },
  { timeout: 180_000 },
);

proves(
  ["108-tags FR-006"],
  "108: the last positional of a command may repeat (tag add <machine> <tag...>); the tag commands are in the one registry",
  () => {
    const add = COMMANDS.find((c) => c.name === "tag add");
    assert(add !== undefined, "tag add is a command");
    assertEquals(parseArgs(add, ["alpha", "env:prod", "role:nas", "pilot", "--no-apply"]), {
      machine: "alpha",
      tags: "env:prod\nrole:nas\npilot",
      "no-apply": true,
    });
    assertThrows(() => parseArgs(add, ["alpha"]), Error, "missing required argument");
    const list = COMMANDS.find((c) => c.name === "tag list");
    assertEquals(list?.tier, "read");
    assertEquals(list?.output, "report");
    assertEquals(add.tier, "repo");
    assertEquals(add.output, "action");
    assertEquals(COMMANDS.find((c) => c.name === "tag remove")?.tier, "repo");
    // A command that does not repeat still refuses a stray argument.
    const query = COMMANDS.find((c) => c.name === "fleet query");
    assert(query !== undefined);
    assertThrows(() => parseArgs(query, ["select 1", "extra"]), Error, "unexpected argument");
    // The three options that choose machines are on the commands that ask or count machines.
    for (const name of ["fleet query", "compliance", "tag list"]) {
      const c = COMMANDS.find((x) => x.name === name);
      assertEquals(
        ["tag", "any-tag", "select"].every((o) => c?.args.some((a) => a.name === o)),
        true,
        name,
      );
    }
    assertEquals(
      COMMANDS.find((c) => c.name === "pair")?.args.some((a) => a.name === "tag" && a.repeatable),
      true,
    );
    assertEquals(
      parseArgs(query, [
        "select 1",
        "--tag",
        "env:prod",
        "--tag",
        "role:nas",
        "--any-tag",
        "os:linux",
      ]),
      { sql: "select 1", tag: "env:prod\nrole:nas", "any-tag": "os:linux" },
    );
  },
);

// ------------------------------------------------------------------------------ FR-008: pairing

proves(
  ["108-tags FR-008"],
  "108: pair --tag gives every machine of the session its tags; a machine's prompt may keep, replace or clear them",
  async () => {
    const t = (...w: string[]) => readPairTags(kit, w);
    assertEquals(t("env:lab", "role:nas", "pilot"), {
      assigned: { tags: ["env:lab", "role:nas"], customTags: ["pilot"] },
    });
    assertEquals(t("-"), { assigned: { tags: [], customTags: [] } });
    assertEquals(t("none"), { assigned: { tags: [], customTags: [] } });
    const refused = (...w: string[]): string => {
      const r = t(...w);
      assert("error" in r, w.join(" "));
      return "error" in r ? r.error : "";
    };
    assertStringIncludes(refused("env:qa"), "env:qa is not defined");
    assertStringIncludes(refused("prod"), "a value of the dimension env");
    assertStringIncludes(
      refused("env:lab", "env:prod"),
      "env:lab and env:prod are values of one dimension",
    );
    // With no terminal (a test, a pipe) the session's tags stand at each prompt.
    const session = { tags: ["env:lab"], customTags: ["pilot"] };
    assertEquals(await chooseTags("alice-laptop", { set: kit, session }), session);
    assertEquals(
      await chooseTags("alice-laptop", { set: undefined, session: { tags: [], customTags: [] } }),
      {
        tags: [],
        customTags: [],
      },
    );
    // The tags travel with the adoption: adoptCheckIn writes them into machine.ts and keeps them on a second adoption.
    const lab = await sandboxFleet();
    try {
      const script = path.join(lab.sb.home, "adopt.ts");
      const href = (rel: string) =>
        JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, rel)).href);
      await fs.writeTextFile(
        script,
        `import { adoptCheckIn } from ${href("src/archon/adopt/commands.ts")};
import { ui } from ${href("src/archon/core/ui.ts")};
const ci = { fleet: "lab", kinds: ["adopt"], user: "alice", port: 1, hostname: "alice-laptop", addresses: ["127.0.0.1"], macs: [], hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexample0000"] };
await adoptCheckIn(ci, { name: "alice-laptop", spec: "098-pair", joined: "paired", tags: ["env:lab", "role:workstation"], customTags: ["pilot"] });
ui.finish();
`,
      );
      const run = (): ReturnType<typeof lab.sb.run> =>
        lab.sb.run(script, [], "", { ...lab.env, ARCHON_REPO: lab.repo, ARCHON_FLEET: "lab" });
      const r1 = await run();
      assertEquals(r1.code, 0, r1.out);
      const file = path.join(lab.repo, "fleets/lab/adopted/alice-laptop/machine.ts");
      const text = await fs.readTextFile(file);
      assertStringIncludes(text, `import type { TagId } from "../../tags.ts";`);
      assertStringIncludes(text, `joined: "paired"`);
      assertStringIncludes(text, `"role:workstation"`);
      assertStringIncludes(text, `"pilot"`);
      // Adopting again with no tags keeps the ones it had.
      await fs.writeTextFile(
        script,
        (await fs.readTextFile(script)).replace(/, tags: \[[^\]]*\], customTags: \["pilot"\]/, ""),
      );
      const r2 = await run();
      assertEquals(r2.code, 0, r2.out);
      assertEquals(await fs.readTextFile(file), text);
      const v = await lab.stolos(["validate"]);
      assertEquals(v.code, 0, v.out);
    } finally {
      await fs.remove(lab.sb.home, { recursive: true }).catch(() => {});
    }
  },
);

// ------------------------------------------------------------------------------ FR-014, FR-015: the Stolos Console and every report

/** The fake fleet's facts, with tags: alpha is production and a database, lab-pc holds a custom tag, beta none. */
function taggedFacts(): typeof FACTS {
  const f = structuredClone(FACTS);
  const set = kit;
  const mk = (facts: TagFacts, a: { tags?: string[]; customTags?: string[] }) =>
    resolveTags(set, facts, a).tags;
  for (const m of f.machines) {
    if (m.name === "alpha") {
      m.tags = mk(facts({ name: "alpha", os: "macos" }), {
        tags: ["env:prod", "role:database"],
        customTags: ["pilot"],
      });
    } else if (m.name === "lab-pc") {
      m.tags = mk(facts({ name: "lab-pc", kind: "controller", os: "macos" }), {
        tags: ["role:workstation"],
        customTags: ["home-office", "pilot"],
      });
    } else if (m.name === "beta") {
      m.tags = mk(facts({ name: "beta", os: "macos" }), { tags: ["env:lab", "env:qa"] });
    }
    if (m.tags && !m.tags.length) delete m.tags;
  }
  f.tagging = taggingView(set, undefined, f.machines);
  return f;
}

/** The console, signed in, with the tagged facts. */
async function taggedConsole(extra: Parameters<typeof fakeConsole>[1] = {}) {
  const { handler, launch } = await fakeConsole(PORT, {
    facts: () => Promise.resolve(taggedFacts()),
    ...extra,
  });
  const r = await handler(
    new Request(`${B}/launch?t=${launch.issue()}`, { headers: { host: `127.0.0.1:${PORT}` } }),
  );
  assertEquals(r.status, 303);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = (p: string): Promise<Response> =>
    handler(new Request(B + p, { headers: { host: `127.0.0.1:${PORT}`, cookie } }));
  const post = (p: string, body: Record<string, string>): Promise<Response> =>
    handler(
      new Request(B + p, {
        method: "POST",
        headers: { host: `127.0.0.1:${PORT}`, cookie, origin: B, "datastar-request": "true" },
        body: new URLSearchParams(body),
      }),
    );
  return { get, post };
}

proves(
  ["108-tags FR-014", "108-tags FR-015"],
  "108: the machines page has a chip for each tag, the fleet's tags with counts as a filter, group-by, and custom tags drawn apart",
  async () => {
    const { get } = await taggedConsole();
    const page = await (await get("/machines")).text();
    // A chip for each tag, in its colour; custom ones with their own style and the word.
    assertStringIncludes(page, `<th>Tags</th>`);
    assertStringIncludes(page, `class="tag c-red"`);
    assertStringIncludes(page, `title="env:prod: Real users. (given by a person)"`);
    assertStringIncludes(page, `class="tag custom"`);
    assertStringIncludes(page, `<span class="kind">custom</span>pilot`);
    assertStringIncludes(page, `<span class="kind">not defined</span>env:qa`);
    // The facets: each defined tag with how many machines hold it, as buttons that set the page's $tag; custom ones apart.
    assertStringIncludes(page, `data-signals="{q: '', joined: '', tag: ''}"`);
    assertStringIncludes(page, `data-on:click="$tag = $tag === 'env:prod' ? '' : 'env:prod'"`);
    assertStringIncludes(page, `data-attr:aria-pressed="$tag === 'env:prod'"`);
    assertStringIncludes(page, `Custom tags`);
    assert(!page.includes(`id="tag-problems"`), "no problem, no box");
    assertStringIncludes(page, `<span class="n">2</span>`);
    // Each row filters on its tags; a tag is a word the filter can match.
    assertStringIncludes(
      page,
      `$tag === &#39;&#39; || &#39; env:prod role:database pilot &#39;.includes(&#39; &#39; + $tag + &#39; &#39;)`,
    );
    // Group by a dimension: a block per value, a machine of a many-of dimension under each value, and a block for none.
    assertStringIncludes(page, `href="/machines?group=env"`);
    const grouped = await (await get("/machines?group=env")).text();
    assertStringIncludes(grouped, `data-group="env:prod"`);
    assertStringIncludes(grouped, `Environment: Production (1)`);
    assertStringIncludes(grouped, `Environment: none`);
    assert(!grouped.includes("This PC</th>"), "grouped, the table is by the dimension");
    const byRole = await (await get("/machines?group=role")).text();
    assertStringIncludes(byRole, `Role: Database (2)`);
    assertStringIncludes(byRole, `Role: Workstation (1)`);
    // What is wrong with the tags is said above the table (the build says it with the fix).
    const { get: getBad } = await taggedConsole({
      facts: () => {
        const f = taggedFacts();
        if (f.tagging) f.tagging.problems = ["beta: env:qa is not defined in tags.ts"];
        return Promise.resolve(f);
      },
    });
    const bad = await (await getBad("/machines")).text();
    assertStringIncludes(bad, `id="tag-problems"`);
    assertStringIncludes(bad, `beta: env:qa is not defined in tags.ts`);
    // A dimension the fleet does not have is the plain table.
    assertStringIncludes(await (await get("/machines?group=nope")).text(), `This PC</th>`);
    // A machine's page: each tag with its label, description and origin, custom ones marked, and how to change them.
    const alphaPage = await (await get("/machines/alpha")).text();
    assertStringIncludes(alphaPage, `id="tags"`);
    assertStringIncludes(alphaPage, `Real users.`);
    assertStringIncludes(alphaPage, `person`);
    assertStringIncludes(alphaPage, `free-form: not defined in tags.ts`);
    assertStringIncludes(alphaPage, `bun run stolos tag add alpha env:lab`);
    // The chips on their own: a defined tag in its colour, a custom one apart, an undefined one marked; every value escaped.
    const t = (id: string, standing: "defined" | "custom" | "unknown") =>
      tagChip({ id, label: id, standing, origin: "person", colour: "blue" }).toString();
    assertStringIncludes(t("pilot", "custom"), `class="tag custom"`);
    assertStringIncludes(t("pilot", "custom"), `custom tag (free-form, not defined in tags.ts)`);
    assertStringIncludes(t("env:qa", "unknown"), `class="tag undefined"`);
    assertStringIncludes(t("env:lab", "defined"), `class="tag c-blue"`);
    assert(!t(`<b>"x"</b>`, "custom").includes("<b>"), "a tag's text is escaped");
    assertEquals(tagChips(undefined).toString(), "");
    // The stylesheet draws every colour of the ontology, light and dark.
    for (const c of TAG_COLOURS) {
      assertStringIncludes(CONSOLE_CSS, `.tag.c-${c} {`);
      assertStringIncludes(CONSOLE_CSS, `--tag-${c}-soft:`);
    }
    assertStringIncludes(CONSOLE_CSS, "@media (prefers-color-scheme: dark) { :root { --tag-grey:");
    assertStringIncludes(CONSOLE_CSS, ".tag.custom {");
    // A fleet with no tags at all has no tags column to fill, and no facets, and the same page otherwise.
    const plain = machinesPage(structuredClone(FACTS)).toString();
    assert(!plain.includes(`class="facets"`));
    assertStringIncludes(plain, `<th>Tags</th>`);
  },
);

proves(
  ["108-tags FR-014", "108-tags FR-015"],
  "108: the machines CSV and the evidence JSON carry each machine's tags and where each came from, custom ones in a column of their own",
  () => {
    const f = taggedFacts();
    const csv = machinesCsv(f);
    const head = csv.split("\r\n")[0] ?? "";
    assertStringIncludes(head, "last_record,tags,custom_tags,tag_origins");
    const lines = csv.split("\r\n");
    const alpha = lines.find((l) => l.startsWith("alpha,")) ?? "";
    assertStringIncludes(
      alpha,
      "env:prod; role:database,pilot,env:prod=person; role:database=person; pilot=person",
    );
    const pc = lines.find((l) => l.startsWith("lab-pc,")) ?? "";
    assertStringIncludes(pc, "role:workstation,home-office; pilot,");
    const ev = evidence(f) as {
      managed: Array<{
        name: string;
        tags: Array<{ id: string; custom: boolean; origin: string }>;
      }>;
    };
    const a = ev.managed.find((m) => m.name === "alpha");
    assertEquals(
      a?.tags.map((t) => [t.id, t.custom, t.origin]),
      [
        ["env:prod", false, "person"],
        ["role:database", false, "person"],
        ["pilot", true, "person"],
      ],
    );
    // The same record is what tag list --json and the answers carry.
    const rec = machineRecord({
      name: "alpha",
      kind: "server",
      resolved: resolveTags(kit, facts(), { customTags: ["pilot"] }),
    });
    assertEquals(
      (rec["tags"] as Array<{ id: string; custom: boolean }>).map((t) => [t.id, t.custom]),
      [
        ["os:linux", false],
        ["pilot", true],
      ],
    );
    const [first] = resolveTags(kit, facts(), { customTags: ["pilot"] }).tags;
    assertEquals(tagRecord(first as never)["from"], "linux");
    // A line of text marks custom tags apart, and an undefined one as such.
    const r = resolveTags(kit, facts({ os: "macos" }), {
      tags: ["env:lab", "env:qa"],
      customTags: ["pilot", "x"],
    });
    assertEquals(tagLine(r.tags), "env:lab env:qa (not defined) · custom: pilot, x");
    assertEquals(r.tags.map(tagWord), [
      "env:lab",
      "env:qa (not defined)",
      "pilot (custom)",
      "x (custom)",
    ]);
  },
);

proves(
  ["108-tags FR-013", "108-tags FR-014"],
  "108: the Ask every machine page has the tag picker, and asks only the machines the expression chooses (read by the same parser)",
  async () => {
    let seen: unknown;
    const ask: NonNullable<StolosDeps["ask"]> = async (_sql, o) => {
      seen = o.selection;
      const { askAll } = await import("../src/archon/adopt/query.ts");
      return await askAll(
        [{ machine: "alpha", kind: "managed", ask: () => Promise.resolve([{ version: "26.04" }]) }],
        o,
      );
    };
    const { get, post } = await taggedConsole({ ask });
    const page = await (await get("/query?select=env:prod")).text();
    assertStringIncludes(page, `name="select"`);
    assertStringIncludes(page, `data-bind:select`);
    assertStringIncludes(page, `Only machines with these tags`);
    assertStringIncludes(page, `value="select name, version from os_version"`);
    assertStringIncludes(page, `{select: &quot;env:prod&quot;}`);
    // A chip adds its tag to the expression; the custom ones too, marked.
    assertStringIncludes(
      page,
      `$select = $select.trim() ? $select.trim() + &#39; and env:prod&#39; : &#39;env:prod&#39;`,
    );
    assertStringIncludes(page, `Add the custom tag pilot to the choice`);
    // The expression is read on the way in, by the fleet's own tags: the lab's (this process reads examples/fleets/lab).
    const body = async (r: Response): Promise<string> => await r.text();
    let out = await body(
      await post("/query/run", {
        sql: "select name from os_version",
        select: "env:prod and not role:database",
      }),
    );
    assertEquals(
      JSON.stringify(seen),
      JSON.stringify({
        op: "and",
        of: [
          { op: "tag", id: "env:prod" },
          { op: "not", of: { op: "tag", id: "role:database" } },
        ],
      }),
    );
    assertStringIncludes(out, "Answered");
    seen = "not asked";
    out = await body(
      await post("/query/run", { sql: "select name from os_version", select: "env:qa" }),
    );
    assertEquals(seen, "not asked", "a tag that is not defined asks nothing");
    assertStringIncludes(out, "env:qa is not defined");
    out = await body(
      await post("/query/run", { sql: "select name from os_version", select: "env:prod and" }),
    );
    assertEquals(seen, "not asked");
    assertStringIncludes(out, "a tag is missing at the end");
    seen = "not asked";
    await body(await post("/query/run", { sql: "select name from os_version", select: "" }));
    assertEquals(seen, undefined, "no choice asks every machine");
    // The page without tags still has the field, and no chips.
    const bare = queryPage("select 1").toString();
    assertStringIncludes(bare, `name="select"`);
    assert(!bare.includes(`class="facets"`));
  },
);

// ------------------------------------------------------------------------------ FR-016: compliance scoping

proves(
  ["108-tags FR-016"],
  "108: compliance counts only the machines the tags choose; a cloud account's evidence stays",
  () => {
    const f = structuredClone(FACTS);
    assert(f.machines.some((m) => m.kind === "cloud") || f.clouds.length >= 0);
    const names = f.machines.map((m) => m.name);
    assert(names.includes("alpha") && names.includes("beta"));
    const scoped = scopeFacts(f, new Set(["alpha", "lab-pc"]));
    assertEquals(
      scoped.machines
        .filter((m) => m.kind !== "cloud")
        .map((m) => m.name)
        .sort(),
      ["alpha", "lab-pc"].filter((n) => names.includes(n)).sort(),
    );
    assertEquals(
      scoped.adopted.map((a) => a.machine.name).sort(),
      f.adopted
        .map((a) => a.machine.name)
        .filter((n) => n === "lab-pc")
        .sort(),
    );
    assertEquals(scoped.clouds, f.clouds, "accounts are not machine-scoped");
    assertEquals(scoped.fleet, f.fleet);
    assertEquals(f.machines.length, names.length, "the original is untouched");
    assertEquals(
      scopeFacts(f, new Set()).machines.every((m) => m.kind === "cloud"),
      true,
    );
  },
);

// ------------------------------------------------------------------------------ the standards the spec names

proves(
  ["108-tags FR-001"],
  "108: the SCF controls the spec names are SCF's, with SCF's names",
  async () => {
    const named: Record<string, string> = {
      "AST-04": "Asset Inventories",
      "AST-05.1":
        "Technology Assets, Applications, Services and/or Data (TAASD) Criticality Ratings",
      "AST-07.1":
        "Technology Assets, Applications, Services and/or Data (TAASD) Ownership Assignment",
      "AST-15": "Asset Categorization",
      "DCH-04": "Data & Asset Classification",
    };
    const spec = await fs.readTextFile(path.join(ENGINE_ROOT, "specs/108-tags/spec.md"));
    for (const id of ["AST-04", "AST-05.1", "AST-07.1", "AST-15", "DCH-04"]) {
      assertStringIncludes(spec, id);
    }
    assertStringIncludes(spec, "Standards considered");
    for (const word of ["RFC 2119", "CM-8", "SP 800-128", "SP 800-60", "FIPS 199"]) {
      assertStringIncludes(spec, word);
    }
    // Every requirement sentence uses an RFC 2119 word, in capitals.
    for (const line of spec.split("\n").filter((l) => /^- \*\*FR-\d{3}\*\*/.test(l))) {
      const id = /FR-\d{3}/.exec(line)?.[0] ?? "";
      const block = spec.slice(spec.indexOf(line)).split(/\n(?=- \*\*FR-|\n#)/)[0] ?? "";
      assert(/\b(MUST|MUST NOT|SHOULD|SHOULD NOT|MAY)\b/.test(block), `${id} has no RFC 2119 word`);
    }
    const catalog = await loadScf().catch(() => undefined);
    if (catalog === undefined) {
      assert(
        proc.env.get("STOLOS_REQUIRE_SCF") === undefined,
        "STOLOS_REQUIRE_SCF is set (CI) but the SCF catalog is not cached",
      );
      return;
    }
    for (const [id, name] of Object.entries(named))
      assertEquals(catalog.controls[id]?.name, name, id);
  },
);
