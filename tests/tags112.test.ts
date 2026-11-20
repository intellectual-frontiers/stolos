/**
 * Spec 112-machine-reported-tags: what a machine says about itself (its `/etc/machine-info`, its firmware, its own `archon tag` table),
 * read as untrusted claims, and what the fleet does with them (`fromMachine`: accept, hint, ignore; the fleet always wins; a
 * disagreement is a finding; `stolos tag accept` makes a claim a signed person tag). The parts that touch a machine run for real: the
 * probe script under `sh`, the `archon tag` commands in a host root, osquery's own `osqueryi` over the generated automatic table, and
 * `stolos tag accept` through a real signed `stolos apply` of a copy of the example lab. The servers are stand-ins only where the
 * transport is: an `ssh` on the PATH answering newline-delimited JSON-RPC with what the real `archon state` printed (as spec 048's tests do).
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { CODE_LISTS, STOLOS } from "../ontology/stolos/mod.ts";
import { terms as auditTerms } from "../ontology/stolos/audit.ts";
import { stolos as stolosTerms } from "../ontology/stolos/vocabulary.ts";
import { TAG_ORIGINS, TAG_SOURCES, TAG_TRUSTS } from "../src/archon/ontology.auto.ts";
import {
  claimsFrom,
  claimTag,
  cloudOf,
  kindOfChassisType,
  type MachineReport,
  parseMachineInfo,
  REPORT_LIMITS,
  reportFromProbe,
  sanitizeReport,
  slug,
} from "../src/archon/model/reported.ts";
import {
  defineTags,
  fromMachineOf,
  idSet,
  isUsed,
  type ReportedClaim,
  resolveTags,
  STARTER_DIMENSIONS,
  starterTagsSource,
  type TagFacts,
  tagSetProblems,
} from "../src/archon/model/tags.ts";
import {
  chosen,
  originWords,
  tagLine,
  tagRecord,
  taggingView,
  tagWord,
} from "../src/archon/fleet/tags.ts";
import { claimRecord, machineRecord } from "../src/archon/fleet/tag-commands.ts";
import { archonTables, osqueryConf } from "../src/archon/capabilities/osquery.ts";
import { QUERY_TABLES, queryRefusal } from "../src/archon/state/query.ts";
import { SCHEMA, STATE_SQL, VIEWS } from "../src/archon/state/store.ts";
import {
  listTagRows,
  putLocalTags,
  removeLocalTags,
  replaceFleetTags,
} from "../src/archon/state/tags.ts";
import {
  keepReport,
  lastReport,
  lastReports,
  readMachineInfo,
} from "../src/archon/state/reported.ts";
import { parseProbe, PROBE_SCRIPT, PROBE_VERSION } from "../src/archon/adopt/probe.ts";
import { machineSource } from "../src/archon/adopt/adopt.ts";
import { fleetEvidence } from "../src/archon/compliance/report.ts";
import { loadScf } from "../src/archon/compliance/catalog.ts";
import { claimsPanel, tagChip, tagChips, tagIds } from "../src/archon/console/tags.ts";
import { machinePage, machinesCsv, machinesPage } from "../src/archon/console/stolos-pages.ts";
import { CONSOLE_CSS } from "../src/archon/console/assets.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { listed, mcpToolName } from "../src/archon/mcp/server.ts";
import { parseArgs } from "../src/archon/core/registry-types.ts";
import { FACTS } from "./console/serve-stolos.ts";
import { host as fixtureHost } from "./fixtures.ts";
import { HOST_ROOT_SKIP, hostRoot } from "./host.ts";
import { fleet as sandboxFleet } from "./lab-fleet.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

/** A small fleet of tags: the environment accepts what machines report, roles are hints, criticality is ignored. */
const kit = defineTags(
  {
    env: {
      label: "Environment",
      description: "Where the work runs.",
      cardinality: "one-of",
      fromMachine: "accept",
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
        web: { label: "Web", colour: "blue", description: "Serves pages." },
      },
    },
    criticality: {
      label: "Criticality",
      description: "How much it matters.",
      cardinality: "one-of",
      fromMachine: "ignore",
      tags: {
        low: { label: "Low", colour: "green", description: "Little." },
        high: { label: "High", colour: "red", description: "Much." },
      },
    },
    site: {
      label: "Site",
      description: "Where it is.",
      cardinality: "one-of",
      fromMachine: "accept",
      tags: { main: { label: "Main", colour: "blue", description: "The premises." } },
    },
  },
  {
    rules: [{ id: "lab-net", when: (m) => m.address === "10.0.1.5", tag: "env:lab" }],
    groups: [{ id: "servers-net", names: ["gamma"], tags: ["role:nas"] }],
    machineInfoMap: {
      deployment: { production: "env:prod", development: "env:lab" },
      location: { "main office": "site:main" },
    },
  },
);

const facts = (over: Partial<TagFacts> = {}): TagFacts => ({
  name: "alpha",
  kind: "server",
  os: "linux",
  address: "10.0.30.59",
  joined: "managed",
  ...over,
});

const claim = (
  id: string,
  source: ReportedClaim["source"] = "machine-info",
  origin: ReportedClaim["origin"] = "reported",
): ReportedClaim => ({ id, origin, source });

const AT = "2026-11-17T10:00:00Z";

/** The JSON object in a command's output (stdout and stderr are joined: a runtime may add a warning after it). */
function jsonIn(out: string): string {
  const from = out.search(/^\{$/m);
  const to = out.lastIndexOf("\n}");
  assert(from >= 0 && to > from, `no JSON in: ${out}`);
  return out.slice(from, to + 2);
}

// ------------------------------------------------------------------------------ the ontology

proves(
  [
    "112-machine-reported-tags FR-001",
    "112-machine-reported-tags FR-002",
    "112-machine-reported-tags FR-003",
  ],
  "112: the origins gain reported and announced; the trusts and the sources are code lists; each new class is mapped to a standard",
  () => {
    assertEquals([...TAG_ORIGINS], ["person", "rule", "inherited", "reported", "announced"]);
    assertEquals([...TAG_TRUSTS], ["accept", "hint", "ignore"]);
    assertEquals([...TAG_SOURCES], ["machine-info", "archon-local", "archon-fleet", "smbios"]);
    assertEquals(Object.keys(CODE_LISTS.TagTrust.list), [...TAG_TRUSTS]);
    assertEquals(Object.keys(CODE_LISTS.TagSource.list), [...TAG_SOURCES]);
    assertEquals(Object.keys(CODE_LISTS.TagOrigin.list), [...TAG_ORIGINS]);
    // Each new class has a record of the standard it rests on (spec 104-mizan), none is left unaligned.
    for (const [name, standard] of [
      ["TagClaim", "http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement"],
      ["TagTrust", "http://www.w3.org/2004/02/skos/core#ConceptScheme"],
      ["TagSource", "http://www.w3.org/2004/02/skos/core#ConceptScheme"],
    ] as const) {
      const rec = auditTerms.find((t) => t.values.termIri === stolosTerms[name].iri);
      assertEquals(rec?.values.standardTerm, standard, name);
    }
    assertEquals(STOLOS.iri.endsWith("#") || STOLOS.iri.endsWith("/"), true);
  },
);

// ------------------------------------------------------------------------------ FR-003: fromMachine and machineInfoMap

proves(
  ["112-machine-reported-tags FR-003", "112-machine-reported-tags FR-005"],
  "112: fromMachine is typed, defaults to hint, and is accept for env and site, ignore for criticality and data in the starter kit; machineInfoMap names only defined tags",
  () => {
    assertEquals(fromMachineOf(kit, "env"), "accept");
    assertEquals(fromMachineOf(kit, "role"), "hint", "hint where it says nothing");
    assertEquals(fromMachineOf(kit, "nope"), "hint", "and for a dimension the fleet does not have");
    assertEquals(fromMachineOf(undefined, "env"), "hint");
    const starter = Object.fromEntries(
      Object.entries(STARTER_DIMENSIONS).map(([d, def]) => [d, def.fromMachine]),
    );
    assertEquals(starter, {
      env: "accept",
      role: "hint",
      site: "accept",
      owner: "hint",
      criticality: "ignore",
      data: "ignore",
    });
    // defineTags refuses a value that is none of the three, with the fix.
    assertThrows(
      () =>
        defineTags({
          env: {
            label: "E",
            description: "d",
            cardinality: "one-of",
            // @ts-expect-error not one of accept, hint, ignore
            fromMachine: "trust",
            tags: { lab: { label: "L", colour: "green", description: "d" } },
          },
        }),
      Error,
      "fromMachine 'trust' is not known",
    );
    // machineInfoMap is typed by the fleet's own tags, and checked where it is not typed.
    const bad = tagSetProblems({
      dimensions: kit.dimensions,
      rules: [],
      groups: [],
      machineInfoMap: { deployment: { production: "env:nowhere" }, location: { x: "site:main" } },
    });
    assertEquals(bad.length, 1);
    assertStringIncludes(bad[0]?.message ?? "", "env:nowhere, which is not defined");
    assertThrows(() =>
      defineTags(kit.dimensions, {
        // @ts-expect-error env:nowhere is not a tag of this fleet
        machineInfoMap: { deployment: { production: "env:nowhere" } },
      }),
    );
    // The starter tags.ts says both, and the lab (which carries the kit unchanged) too.
    const text = starterTagsSource();
    assertStringIncludes(text, 'fromMachine: "accept"');
    assertStringIncludes(text, "machineInfoMap");
    assertStringIncludes(text, 'production: "env:prod"');
  },
);

// ------------------------------------------------------------------------------ FR-004: untrusted input

proves(
  ["112-machine-reported-tags FR-004"],
  "112: a machine's words are read with the tag grammar and the caps: hostile strings are dropped and counted, never evaluated",
  () => {
    assertEquals(claimTag("env:prod"), "env:prod");
    assertEquals(claimTag("  ENV:Prod "), "env:prod");
    assertEquals(claimTag("pilot"), "pilot");
    for (const evil of [
      "",
      "   ",
      "and",
      "env:",
      ":prod",
      "env:prod:x",
      "env prod",
      "env:prod; rm -rf /",
      "$(touch /tmp/x)",
      "`id`",
      "${process.exit(1)}",
      "<script>alert(1)</script>",
      "env:‮prod",
      "env:prod\u0000",
      "a".repeat(65),
      `env:${"a".repeat(40)}`,
      "constructor.constructor('return 1')()",
      "../../etc/passwd",
      "__proto__",
    ]) {
      assertEquals(claimTag(evil), undefined, JSON.stringify(evil));
    }
    assertEquals(claimTag(42), undefined);
    assertEquals(claimTag(undefined), undefined);
    // 64 characters is the cap of a tag (the grammar's own 39 stops a free-form word first).
    assertEquals(REPORT_LIMITS.tagChars, 64);
    assertEquals(REPORT_LIMITS.perMachine, 64);
    // A report full of words that are not tags: all dropped, counted, said as gaps, and nothing thrown.
    const evilReport: MachineReport = {
      at: AT,
      machineInfo: {
        DEPLOYMENT: "$(touch /tmp/pwned)",
        LOCATION: "‮\u0000",
        CHASSIS: "spaceship",
        TAGS: `${"a".repeat(80)} env:prod; rm  <b>x</b> ok-tag`,
      },
      tags: [
        { dimension: "env", value: "prod; drop", source: "local" },
        { dimension: "", value: "fine", source: "elsewhere" },
        { dimension: "x".repeat(50), value: "y", source: "fleet" },
      ],
      smbios: { vendor: "‮\u0000", model: "!!!" },
    };
    const read = claimsFrom(evilReport, kit.machineInfoMap);
    assert(read.dropped >= 7, `dropped ${read.dropped}`);
    assert(read.gaps.length > 0 && read.gaps.length <= 8);
    // What survives is only grammar: two plain words (rm, ok-tag) and nothing a shell or a page could read as more.
    assertEquals(
      read.claims.map((c) => c.id),
      ["rm", "ok-tag"],
    );
    for (const c of read.claims) assertEquals(claimTag(c.id), c.id);
    // At most 64 claims a machine, the rest counted.
    const many = claimsFrom({
      at: AT,
      machineInfo: { TAGS: Array.from({ length: 100 }, (_, i) => `t${i}`).join(" ") },
      tags: [],
    });
    assertEquals(many.claims.length, 64);
    assertEquals(many.dropped, 36, "the rest is counted, not read");
    const rows = claimsFrom({
      at: AT,
      tags: Array.from({ length: 100 }, (_, i) => ({
        dimension: "role",
        value: `v${i}`,
        source: "local",
      })),
    });
    assertEquals(rows.claims.length, 64);
    assertEquals(rows.dropped, 36);
    assertStringIncludes(rows.gaps.join(), "36 more claim(s)");
    // The cache's copy is bounded: unknown keys, long strings, control and direction characters, and too many rows.
    const kept = sanitizeReport({
      at: AT,
      machineInfo: { DEPLOYMENT: "x".repeat(5000), EVIL: "y", LOCATION: "a\u0000b‮c" },
      tags: Array.from({ length: 500 }, () => ({ dimension: "a", value: "b", source: "local" })),
      smbios: { vendor: "V".repeat(900) },
      extra: { deep: true },
    });
    assertEquals(Object.keys(kept?.machineInfo ?? {}).sort(), ["DEPLOYMENT", "LOCATION"]);
    assertEquals(kept?.machineInfo?.["DEPLOYMENT"]?.length, REPORT_LIMITS.rawChars);
    assertEquals(kept?.machineInfo?.["LOCATION"], "a b c");
    assertEquals(kept?.tags?.length, REPORT_LIMITS.rows);
    assertEquals(kept?.smbios?.vendor?.length, REPORT_LIMITS.rawChars);
    assertEquals(sanitizeReport("not an object"), undefined);
    assertEquals(sanitizeReport(null), undefined);
    // /etc/machine-info is data: nothing is expanded or run, quotes are removed, only four keys are kept.
    assertEquals(
      parseMachineInfo(
        [
          "# a comment",
          'PRETTY_HOSTNAME="Alpha"',
          'DEPLOYMENT="production"',
          "LOCATION='Main office'",
          "CHASSIS=server",
          "TAGS=$(touch /tmp/pwned) `id` ${HOME}",
          "DEPLOYMENT=staging",
          "no equals sign",
        ].join("\n"),
      ),
      {
        DEPLOYMENT: "production",
        LOCATION: "Main office",
        CHASSIS: "server",
        TAGS: "$(touch /tmp/pwned) `id` ${HOME}",
      },
    );
    // Drawn escaped: the console's chip and panel show a machine's words as text.
    const panel = claimsPanel(
      "alpha",
      [{ id: "pilot", origin: "reported", source: "machine-info", status: "held", trust: "hint" }],
      [],
      { canAccept: true },
    ).toString();
    assert(!panel.includes("<script"), panel);
  },
);

// ------------------------------------------------------------------------------ FR-005, FR-006: the sources

proves(
  ["112-machine-reported-tags FR-005", "112-machine-reported-tags FR-006"],
  "112: machine-info (DEPLOYMENT, LOCATION, CHASSIS, TAGS) and SMBIOS facts become claims, through the fleet's own map",
  () => {
    const mi = parseMachineInfo(
      'DEPLOYMENT=production\nLOCATION="Main office"\nCHASSIS=laptop\nTAGS="role:web pilot bad!tag"\n',
    );
    const withMap = claimsFrom({ at: AT, machineInfo: mi }, kit.machineInfoMap);
    assertEquals(
      withMap.claims.map((c) => `${c.id}@${c.source}`),
      [
        "env:prod@machine-info",
        "site:main@machine-info",
        "kind:laptop@machine-info",
        "role:web@machine-info",
        "pilot@machine-info",
      ],
    );
    assertEquals(withMap.dropped, 1, "bad!tag has a character the grammar does not allow");
    // Without the map: the plain claims. LOCATION is a hint value, never mapped to a defined site.
    const plain = claimsFrom({ at: AT, machineInfo: mi });
    assert(plain.claims.some((c) => c.id === "env:production"));
    assert(plain.claims.some((c) => c.id === "site:main-office"));
    assert(!plain.claims.some((c) => c.id === "site:main"), "no invented mapping");
    assertEquals(slug("Main Office, Berlin!"), "main-office-berlin");
    assertEquals(slug("!!!"), "");
    assertEquals(slug("x".repeat(80)).length, 30);
    // SMBIOS: the maker, the model, the chassis, and a cloud provider's name, as hints of the dimension hardware.
    const dell = claimsFrom({
      at: AT,
      smbios: { vendor: "Dell Inc.", model: "XPS 13 9310", chassis: "10" },
    });
    assertEquals(
      dell.claims.map((c) => c.id),
      ["hardware:dell-inc", "hardware:xps-13-9310", "kind:laptop"],
    );
    for (const c of dell.claims) assertEquals(c.source, "smbios");
    const aws = claimsFrom({
      at: AT,
      smbios: { vendor: "Amazon EC2", model: "t3.micro", chassis: "1" },
    });
    assert(aws.claims.some((c) => c.id === "hardware:amazon-ec2"));
    assert(aws.claims.some((c) => c.id === "hardware:cloud-aws"));
    assert(
      !aws.claims.some((c) => c.id.startsWith("kind:")),
      "chassis type 1 (other) makes no claim",
    );
    assertEquals(cloudOf({ vendor: "Google", model: "Google Compute Engine" }), "gcp");
    assertEquals(cloudOf({ vendor: "Dell Inc." }), undefined);
    assertEquals(kindOfChassisType("17"), "server");
    assertEquals(kindOfChassisType("31"), "convertible");
    assertEquals(kindOfChassisType("2"), undefined);
    assertEquals(kindOfChassisType("x"), undefined);
    // The tags table: local and fleet rows, with who and when; an unknown source is dropped.
    const table = claimsFrom({
      at: AT,
      tags: [
        { dimension: "env", value: "prod", source: "local", set_by: "root", set_at: AT },
        { dimension: "", value: "pilot", source: "fleet" },
        { dimension: "env", value: "lab", source: "other" },
      ],
    });
    assertEquals(
      table.claims.map((c) => `${c.id}@${c.source}`),
      ["env:prod@archon-local", "pilot@archon-fleet"],
    );
    assertEquals(table.claims[0]?.setBy, "root");
    assertEquals(table.dropped, 1);
    // Announced is another channel: the same reading, another origin.
    assertEquals(
      claimsFrom({ at: AT, machineInfo: { CHASSIS: "vm" } }, undefined, "announced").claims[0]
        ?.origin,
      "announced",
    );
    // The probe's reported section is read the same way (bounded).
    const probe = parseProbe(
      "@reported\nmachine_info_deployment=production\nmachine_info_tags=role:web\nsmbios_vendor=Dell Inc.\nsmbios_chassis_type=3\n",
    );
    const report = reportFromProbe(probe["reported"], AT);
    assertEquals(report?.machineInfo, { DEPLOYMENT: "production", TAGS: "role:web" });
    assertEquals(report?.smbios?.chassis, "3");
    assertEquals(reportFromProbe(undefined), undefined);
  },
);

// ------------------------------------------------------------------------------ FR-002, FR-003, FR-011: resolution

proves(
  [
    "112-machine-reported-tags FR-002",
    "112-machine-reported-tags FR-003",
    "112-machine-reported-tags FR-011",
    "112-machine-reported-tags FR-013",
  ],
  "112: claims resolve below the fleet's own tags; hints are shown and never used; the fleet wins and says so",
  () => {
    // No fleet value: an accepted claim is held and used; a hint is held and shown, and never used.
    let r = resolveTags(kit, facts(), {}, {}, [
      claim("env:prod"),
      claim("role:web"),
      claim("site:main"),
    ]);
    const byId = Object.fromEntries(r.tags.map((t) => [t.id, t]));
    assertEquals(byId["env:prod"]?.origin, "reported");
    assertEquals(byId["env:prod"]?.trust, "accept");
    assertEquals(byId["env:prod"]?.from, "machine-info");
    assertEquals(byId["role:web"]?.trust, "hint");
    assert(isUsed(byId["env:prod"] ?? { origin: "person" }));
    assert(!isUsed(byId["role:web"] ?? { origin: "person" }));
    assertEquals([...idSet(r)].sort(), ["env:prod", "site:main"]);
    assertEquals([...idSet(r, true)].sort(), ["env:prod", "role:web", "site:main"]);
    assertEquals(
      r.claims.map((c) => c.status),
      ["held", "held", "held"],
    );
    // A person, a rule or a group beats it: the claim is dropped and is a disagreement (one-of), never an override.
    r = resolveTags(kit, facts(), { tags: ["env:lab"] }, {}, [claim("env:prod")]);
    assertEquals(
      r.tags.map((t) => `${t.id}:${t.origin}`),
      ["env:lab:person"],
    );
    assertEquals(r.claims[0]?.status, "disagrees");
    assertEquals(r.claims[0]?.against, "env:lab");
    assertEquals(r.disagreements.length, 1);
    assertEquals(r.disagreements[0]?.text, "alpha reports env:prod; the fleet says env:lab");
    assertEquals(r.disagreements[0]?.dimension, "env");
    r = resolveTags(kit, facts({ address: "10.0.1.5" }), {}, {}, [claim("env:prod")]);
    assertEquals(
      r.tags.map((t) => `${t.id}:${t.origin}`),
      ["env:lab:rule"],
    );
    assertEquals(r.disagreements[0]?.fleet, "env:lab");
    // The same tag from the fleet and the machine: shown once, with the fleet's origin; no finding.
    r = resolveTags(kit, facts(), { tags: ["env:prod"] }, {}, [claim("env:prod", "archon-local")]);
    assertEquals(
      r.tags.map((t) => `${t.id}:${t.origin}`),
      ["env:prod:person"],
    );
    assertEquals(r.claims[0]?.status, "agrees");
    assertEquals(r.disagreements, []);
    // A many-of dimension holds both: no disagreement.
    r = resolveTags(kit, facts({ name: "gamma" }), {}, {}, [claim("role:web")]);
    assertEquals(
      r.tags.map((t) => `${t.id}:${t.origin}`),
      ["role:nas:inherited", "role:web:reported"],
    );
    assertEquals(r.disagreements, []);
    // ignore: dropped and counted, never held; undefined: listed, never held, never a finding.
    r = resolveTags(kit, facts(), { tags: [] }, {}, [
      claim("criticality:high"),
      claim("env:production"),
      claim("zone:a"),
    ]);
    assertEquals(r.tags, []);
    assertEquals(r.ignored, 1);
    assertEquals(r.claims.map((c) => `${c.id}=${c.status}`).sort(), [
      "criticality:high=ignored",
      "env:production=undefined",
      "zone:a=undefined",
    ]);
    assertEquals(r.disagreements, []);
    // Two claims of one one-of dimension: reported before announced, and the other is overridden (no finding).
    r = resolveTags(kit, facts(), {}, {}, [
      claim("env:lab", "machine-info", "announced"),
      claim("env:prod", "archon-local"),
    ]);
    assertEquals(
      r.tags.map((t) => `${t.id}:${t.origin}`),
      ["env:prod:reported"],
    );
    assertEquals(r.claims.find((c) => c.id === "env:lab")?.status, "overridden");
    assertEquals(r.disagreements, []);
    // A free-form word a machine says is a custom hint, apart from the defined ones, never used.
    r = resolveTags(kit, facts(), { customTags: ["pilot"] }, {}, [
      claim("pilot"),
      claim("beta-test"),
    ]);
    const custom = r.tags.filter((t) => t.standing === "custom");
    assertEquals(
      custom.map((t) => `${t.id}:${t.origin}`),
      ["pilot:person", "beta-test:reported"],
    );
    assertEquals([...idSet(r)], ["pilot"]);
    assertEquals(r.claims.find((c) => c.id === "pilot")?.status, "agrees");
    // The words and records say it.
    const web = resolveTags(kit, facts(), {}, {}, [claim("role:web", "smbios")]).tags[0];
    assert(web !== undefined);
    assertEquals(tagWord(web), "role:web (reported hint)");
    assertEquals(originWords(web), "reported by the machine (smbios), a hint");
    assertEquals(tagLine([web]), "role:web (reported hint)");
    assertEquals(tagRecord(web)["source"], "smbios");
    assertEquals(tagRecord(web)["trust"], "hint");
    const prod = resolveTags(kit, facts(), {}, {}, [claim("env:prod")]).tags[0];
    assertEquals(
      originWords(prod ?? web),
      "reported by the machine (machine-info), accepted by the fleet",
    );
    assertEquals(tagWord(prod ?? web), "env:prod (reported)");
    // A machine's JSON carries its claims, what became of them, and the disagreements.
    const dis = resolveTags(kit, facts(), { tags: ["env:lab"] }, {}, [
      claim("env:prod"),
      claim("role:web"),
    ]);
    const rec = machineRecord({
      name: "alpha",
      kind: "server",
      resolved: dis,
      claimsDropped: 2,
      gaps: ["x"],
    });
    assertEquals((rec["claims"] as unknown[]).length, 2);
    assertEquals((rec["disagreements"] as unknown[]).length, 1);
    assertEquals(rec["claimsDropped"], 2);
    assertEquals(claimRecord(dis.claims[0] ?? ({} as never))["status"], "disagrees");
  },
);

// ------------------------------------------------------------------------------ FR-011: choosing machines

proves(
  ["112-machine-reported-tags FR-011"],
  "112: selection, facets and group-by use the fleet's tags and the accepted claims; --reported adds the hints",
  () => {
    const mk = (name: string, claims: ReportedClaim[], tags: string[] = []) => ({
      name,
      resolved: resolveTags(kit, facts({ name }), { tags }, {}, claims),
    });
    const machines = [
      mk("a", [claim("env:prod"), claim("role:web")]),
      mk("b", [claim("role:web")], ["env:lab"]),
      mk("c", []),
    ];
    const sel = (s: string) => ({ op: "tag" as const, id: s });
    assertEquals(
      chosen(machines, sel("env:prod")).map((m) => m.name),
      ["a"],
      "an accepted claim is used",
    );
    assertEquals(
      chosen(machines, sel("role:web")).map((m) => m.name),
      [],
      "a hint is never used",
    );
    assertEquals(
      chosen(machines, sel("role:web"), true).map((m) => m.name),
      ["a", "b"],
      "--reported adds it",
    );
    assertEquals(
      chosen(machines, { op: "not", of: sel("env:prod") }).map((m) => m.name),
      ["b", "c"],
    );
    // Facets count what is used; the hint does not count.
    const view = taggingView(
      kit,
      undefined,
      machines.map((m) => ({ tags: m.resolved.tags })),
    );
    const count = (id: string) =>
      view.dimensions.flatMap((d) => d.tags).find((t) => t.id === id)?.count;
    assertEquals(count("env:prod"), 1);
    assertEquals(count("role:web"), 0);
    // The console's row filter lists only the tags that are used.
    assertEquals(tagIds(machines[0]?.resolved.tags), " env:prod ");
    // The commands take --reported (fleet query and tag list), and compliance does not.
    for (const name of ["tag list", "fleet query"]) {
      assert(
        COMMANDS.find((c) => c.name === name)?.args.some((a) => a.name === "reported"),
        name,
      );
    }
    assert(!COMMANDS.find((c) => c.name === "compliance")?.args.some((a) => a.name === "reported"));
  },
);

// ------------------------------------------------------------------------------ FR-007, FR-008, FR-009: the tags table

proves(
  [
    "112-machine-reported-tags FR-007",
    "112-machine-reported-tags FR-008",
    "112-machine-reported-tags FR-009",
  ],
  "112: the machine's tags table: local and fleet rows, the fleet's replaced at each apply, osquery's archon_tags over it",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-tags112-" });
    try {
      await putLocalTags("alpha", [{ dimension: "env", value: "prod", set_by: "alice" }], dir);
      await putLocalTags("alpha", [{ dimension: "", value: "pilot", set_by: "alice" }], dir);
      assert(
        await replaceFleetTags(
          "alpha",
          [
            { dimension: "env", value: "lab", set_by: "person" },
            { dimension: "os", value: "linux", set_by: "rule linux" },
          ],
          dir,
        ),
      );
      assertEquals(
        (await listTagRows("alpha", dir)).map((r) => `${r.dimension}:${r.value}@${r.source}`),
        ["env:lab@fleet", "env:prod@local", "os:linux@fleet", ":pilot@local"],
      );
      // Nothing changed: nothing written. A new set replaces the fleet's rows and leaves the local ones.
      assertEquals(
        await replaceFleetTags(
          "alpha",
          [
            { dimension: "env", value: "lab", set_by: "person" },
            { dimension: "os", value: "linux", set_by: "rule linux" },
          ],
          dir,
        ),
        false,
      );
      assert(
        await replaceFleetTags(
          "alpha",
          [{ dimension: "os", value: "linux", set_by: "rule linux" }],
          dir,
        ),
      );
      const rows = await listTagRows("alpha", dir);
      assertEquals(rows.filter((r) => r.source === "local").length, 2);
      assertEquals(
        rows.filter((r) => r.source === "fleet").map((r) => r.value),
        ["linux"],
      );
      assertEquals(
        await replaceFleetTags("alpha", [], dir),
        true,
        "an empty set clears the fleet's rows",
      );
      assertEquals((await listTagRows("alpha", dir)).length, 2);
      // Only a local row is removed here; the ones that were not there are returned.
      await replaceFleetTags(
        "alpha",
        [{ dimension: "os", value: "linux", set_by: "rule linux" }],
        dir,
      );
      assertEquals(await removeLocalTags("alpha", ["env:prod", "os:linux", "nope"], dir), [
        "os:linux",
        "nope",
      ]);
      assertEquals(
        (await listTagRows("alpha", dir)).map((r) => r.value),
        ["linux", "pilot"],
      );
      // It is in archon.sql, readable, with the view; other hosts' rows are not touched.
      await putLocalTags("beta", [{ dimension: "env", value: "lab", set_by: "bob" }], dir);
      const sql = await fs.readTextFile(path.join(dir, STATE_SQL));
      assertStringIncludes(sql, "CREATE VIEW IF NOT EXISTS archon_tags");
      assertStringIncludes(sql, "'tag', 'local:env:lab'");
      assertEquals((await listTagRows("alpha", dir)).length, 2);
      // The osquery table: the view's columns, none of them `path` (ATC reserves it), in the configuration osqueryd reads.
      assertEquals(VIEWS["archon_tags"], [
        "host",
        "dimension",
        "value",
        "source",
        "set_by",
        "set_at",
      ]);
      for (const [name, cols] of Object.entries(VIEWS)) {
        assert(!cols.some((c) => c.toLowerCase() === "path"), `${name} has a column named path`);
      }
      assertStringIncludes(SCHEMA, "CREATE VIEW IF NOT EXISTS archon_tags");
      const tables = archonTables(dir);
      assertEquals(tables["archon_tags"]?.columns, VIEWS["archon_tags"]);
      assertEquals(
        tables["archon_tags"]?.query,
        "SELECT host, dimension, value, source, set_by, set_at FROM archon_tags",
      );
      const rendered = JSON.parse(osqueryConf()) as {
        auto_table_construction: Record<string, unknown>;
      };
      assert("archon_tags" in rendered.auto_table_construction);
      // It is a table `archon query` and "Ask every machine" may read.
      assert(QUERY_TABLES.has("archon_tags"));
      assertEquals(
        queryRefusal("select dimension, value from archon_tags where source = 'local'"),
        undefined,
      );
      // The real osqueryi reads it through ATC: the rows are the table's.
      const osqueryi = proc.which("osqueryi");
      if (osqueryi === undefined) {
        assert(
          proc.env.get("STOLOS_REQUIRE_OSQUERY") === undefined,
          "STOLOS_REQUIRE_OSQUERY is set (CI) but osqueryi is not installed",
        );
        return;
      }
      const conf = path.join(dir, "osquery.conf");
      await fs.writeTextFile(
        conf,
        JSON.stringify({ auto_table_construction: { archon_tags: tables["archon_tags"] } }),
      );
      const r = await proc.run(
        [
          "osqueryi",
          "--config_path",
          conf,
          "--database_path",
          path.join(dir, "osquery.db"),
          "--disable_extensions",
          "--json",
          "select host, dimension, value, source, set_by from archon_tags where host = 'alpha' order by value",
        ],
        { env: { ...proc.env.toObject() }, signal: AbortSignal.timeout(60_000) },
      );
      assert(r.success, r.stderr);
      const got = JSON.parse(r.stdout) as Array<Record<string, string>>;
      assertEquals(
        got.map((x) => `${x["dimension"]}|${x["value"]}|${x["source"]}|${x["set_by"]}`),
        ["os|linux|fleet|rule linux", "|pilot|local|alice"],
      );
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  {
    skip: proc.build.os === "windows" && "the machine's side runs on the Linux hosts",
    timeout: 180_000,
  },
);

// ------------------------------------------------------------------------------ the PC's observation cache

proves(
  ["112-machine-reported-tags FR-010", "112-machine-reported-tags FR-004"],
  "112: what a machine reported is kept in the PC's cache, bounded, and read again; machine-info is read as data",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-tags112-" });
    try {
      assertEquals(await lastReport("alpha", dir), undefined);
      assertEquals(await keepReport("alpha", "garbage", dir), false);
      assert(
        await keepReport(
          "alpha",
          {
            at: AT,
            machineInfo: { DEPLOYMENT: "production", EVIL: "x" },
            tags: [{ dimension: "env", value: "lab", source: "local" }],
          },
          dir,
        ),
      );
      await keepReport("beta", { at: AT, smbios: { vendor: "Dell Inc." } }, dir);
      assertEquals((await lastReport("alpha", dir))?.machineInfo, { DEPLOYMENT: "production" });
      assertEquals(Object.keys(await lastReports(dir)).sort(), ["alpha", "beta"]);
      // A newer report replaces the last; the cache is the PC's own file, never the fleet repository.
      await keepReport(
        "alpha",
        { at: "2026-11-18T10:00:00Z", machineInfo: { LOCATION: "Main office" } },
        dir,
      );
      assertEquals((await lastReport("alpha", dir))?.at, "2026-11-18T10:00:00Z");
      assertEquals((await lastReport("alpha", dir))?.machineInfo, { LOCATION: "Main office" });
      assert((await fs.readTextFile(path.join(dir, STATE_SQL))).includes("'reported'"));
      // A hand-edited cache is bounded again on the way out.
      const file = path.join(dir, STATE_SQL);
      await fs.writeTextFile(
        file,
        (await fs.readTextFile(file)).replace("Main office", `${"Z".repeat(500)}\\u0000`),
      );
      assertEquals(
        (await lastReport("alpha", dir))?.machineInfo?.["LOCATION"]?.length,
        REPORT_LIMITS.rawChars,
      );
      // /etc/machine-info: a file with code in it is data; one that is not there is none.
      const mi = path.join(dir, "machine-info");
      assertEquals(await readMachineInfo(mi), undefined);
      await fs.writeTextFile(
        mi,
        'DEPLOYMENT=$(touch "' + path.join(dir, "pwned") + '")\nLOCATION="a b"\n',
      );
      assertEquals((await readMachineInfo(mi))?.["LOCATION"], "a b");
      assert(!(await fs.exists(path.join(dir, "pwned"))), "nothing in machine-info is run");
      await fs.writeTextFile(mi, "# only a comment\nPRETTY_HOSTNAME=alpha\n");
      assertEquals(await readMachineInfo(mi), undefined);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

// ------------------------------------------------------------------------------ the probe, run for real

/** The probe, with its two sources pointed at a folder a test controls, run under sh. */
async function probeFacts(root: string): Promise<string> {
  const script = path.join(root, "probe.sh");
  await fs.writeTextFile(
    script,
    PROBE_SCRIPT.replaceAll("/etc/machine-info", path.join(root, "machine-info")).replaceAll(
      "/sys/class/dmi/id",
      path.join(root, "dmi"),
    ),
  );
  const r = await proc.run(["sh", script], {
    env: { PATH: proc.env.get("PATH") ?? "", SSH_ORIGINAL_COMMAND: "facts", HOME: root },
    signal: AbortSignal.timeout(60_000),
  });
  assertEquals(r.code, 0, r.stderr);
  return r.stdout;
}

proves(
  [
    "112-machine-reported-tags FR-005",
    "112-machine-reported-tags FR-006",
    "112-machine-reported-tags FR-016",
  ],
  "112: the probe's reported section is read as data from machine-info and the firmware's files, and nothing in them is run",
  async () => {
    assertEquals(PROBE_VERSION, "3");
    const root = await fs.makeTempDir({ prefix: "archon-probe112-" });
    try {
      await fs.ensureDir(path.join(root, "dmi"));
      for (const [k, v] of Object.entries({
        sys_vendor: "Dell Inc.",
        product_name: "XPS 13 9310",
        chassis_type: "10",
        bios_vendor: "Dell Inc.",
      })) {
        await fs.writeTextFile(path.join(root, "dmi", k), `${v}\n`);
      }
      const marker = path.join(root, "pwned");
      await fs.writeTextFile(
        path.join(root, "machine-info"),
        `# systemd machine-info\nDEPLOYMENT="production"\nLOCATION=Main office\nCHASSIS=laptop\nTAGS="role:web $(touch ${marker}) pilot"\n`,
      );
      const out = await probeFacts(root);
      assert(!(await fs.exists(marker)), "the file is read as data: nothing in it is run");
      const section = parseProbe(out)["reported"];
      assertEquals(section?.["machine_info_deployment"], "production");
      assertEquals(section?.["machine_info_location"], "Main office");
      assertEquals(section?.["machine_info_chassis"], "laptop");
      assertStringIncludes(section?.["machine_info_tags"] ?? "", "role:web");
      assertEquals(section?.["smbios_vendor"], "Dell Inc.");
      assertEquals(section?.["smbios_chassis_type"], "10");
      // The PC reads it as claims: the hostile word is dropped and counted, the rest are claims.
      const read = claimsFrom(reportFromProbe(section, AT), kit.machineInfoMap);
      assert(read.claims.some((c) => c.id === "env:prod"));
      assert(read.claims.some((c) => c.id === "role:web"));
      assert(read.claims.some((c) => c.id === "hardware:dell-inc"));
      assert(read.claims.some((c) => c.id === "kind:laptop"));
      assert(read.dropped >= 2, `dropped ${read.dropped}`);
      // No file, no claim, no failure.
      await fs.remove(path.join(root, "machine-info"));
      await fs.remove(path.join(root, "dmi"), { recursive: true });
      const bare = parseProbe(await probeFacts(root))["reported"];
      assertEquals(bare?.["machine_info_deployment"], "");
      assertEquals(claimsFrom(reportFromProbe(bare, AT)).claims, []);
      // The PowerShell probe says the same sections (a Windows machine has firmware facts and no machine-info).
      const ps = await fs.readTextFile(path.join(ENGINE_ROOT, "bin/stolos-probe.ps1"));
      assertStringIncludes(ps, "@reported");
      assertStringIncludes(ps, "smbios_chassis_type");
      assertStringIncludes(ps, `$version = '${PROBE_VERSION}'`);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
  {
    skip: proc.build.os === "windows" && "the POSIX probe is Linux's and macOS's",
    timeout: 180_000,
  },
);

// ------------------------------------------------------------------------------ the whole way, for real

/** The example lab as a fleet repository in a sandbox, with a stand-in ssh that answers what a server's `archon state` printed. */
async function lab() {
  const f = await sandboxFleet();
  const { sb } = f;
  const servers = path.join(sb.home, "servers");
  const bin = path.join(sb.home, "bin");
  await fs.mkdir(servers, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  const realSsh = proc.which("ssh") ?? "ssh";
  // An adopted machine's probe is the real script, with its two sources pointed at a folder the test controls.
  const probeRoot = path.join(sb.home, "probe-root");
  await fs.ensureDir(path.join(probeRoot, "dmi"));
  const probeScript = path.join(sb.home, "probe.sh");
  await fs.writeTextFile(
    probeScript,
    PROBE_SCRIPT.replaceAll("/etc/machine-info", path.join(probeRoot, "machine-info")).replaceAll(
      "/sys/class/dmi/id",
      path.join(probeRoot, "dmi"),
    ),
  );
  await fs.writeTextFile(
    path.join(bin, "ssh"),
    `#!/bin/sh
D='${servers}'
for a; do last="$a"; done
case "$last" in facts|version) SSH_ORIGINAL_COMMAND="$last" exec sh '${probeScript}';; esac
case "$last" in ops@*) ;; *) exec '${realSsh}' "$@";; esac
h=\${last#*@}; h=\${h%%.*}
[ -f "$D/answer.$h" ] || { echo "ssh: connect to host $h port 22: No route to host" >&2; exit 255; }
while read -r l; do case "$l" in *'"id":2'*) cat "$D/answer.$h"; exit 0;; esac; done
`,
  );
  await fs.chmod(path.join(bin, "ssh"), 0o755);
  // The machine's logger records what it was told (the journal).
  await fs.writeTextFile(
    path.join(bin, "logger"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(sb.home, "journal.log")}'\n`,
  );
  await fs.chmod(path.join(bin, "logger"), 0o755);
  const answer = async (h: string, text: string): Promise<void> => {
    await fs.writeTextFile(
      path.join(servers, `answer.${h}`),
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } })}\n`,
    );
  };
  const env = { PATH: `${bin}:${proc.env.get("PATH")}` };
  // Root's side of alpha: a host root, with the machine's own files in it.
  const root = path.join(sb.home, "alpha-root");
  await fs.ensureDir(path.join(root, "etc", "archon"));
  await fs.ensureDir(path.join(root, "var", "lib", "archon"));
  await fs.writeTextFile(path.join(root, "etc", "archon", "host"), "alpha\n");
  await fs.writeTextFile(path.join(root, "etc", "archon", "fleet"), "lab\n");
  const archon = (...args: string[]) =>
    sb.run("src/archon/main.ts", args, "", {
      ...f.env,
      ...env,
      ARCHON_REPO: f.repo,
      ARCHON_FLEET: "lab",
      ARCHON_ROOT: root,
    });
  const stolos = (args: string[], extra: Record<string, string> = {}) =>
    f.stolos(args, { ...env, ...extra });
  return { ...f, stolos, servers, bin, answer, env, root, archon, probeRoot };
}

proves(
  [
    "112-machine-reported-tags FR-001",
    "112-machine-reported-tags FR-005",
    "112-machine-reported-tags FR-007",
    "112-machine-reported-tags FR-008",
    "112-machine-reported-tags FR-010",
    "112-machine-reported-tags FR-011",
    "112-machine-reported-tags FR-012",
    "112-machine-reported-tags FR-013",
  ],
  "112: archon tag on a machine, fleet status reads it, the fleet wins and shows the disagreement, and stolos tag accept makes a claim a signed person tag",
  async () => {
    const l = await lab();
    try {
      const { archon, stolos, sh, repo, origin, root } = l;
      const subject = async () => await sh(origin, "git", "log", "-1", "--format=%s", "main");
      // The machine's own side: archon tag add (mutate tier, in a host root), with its run log and its journal.
      await fs.writeTextFile(
        path.join(root, "etc", "machine-info"),
        'DEPLOYMENT="production"\nCHASSIS=server\nTAGS="role:web criticality:high zz!bad"\n',
      );
      let r = await archon(
        "tag",
        "add",
        "env:staging",
        "pilot",
        "zone:north",
        "role:nas",
        "--verbose",
      );
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "alpha says: env:staging, pilot, zone:north, role:nas");
      assertStringIncludes(r.out, "zone:north is not defined in the fleet's tags.ts");
      assertStringIncludes(
        await fs.readTextFile(path.join(l.sb.home, "journal.log")),
        "archon-tag",
      );
      // A one-of value replaces the machine's own old one, and says so; a forgotten dimension and a bad word are refused.
      r = await archon("tag", "add", "env:prod", "--verbose");
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "env:staging replaced");
      for (const [args, said] of [
        [["tag", "add", "prod"], "a value of the dimension env"],
        [["tag", "add", "bad word"], "is not a tag"],
        [["tag", "add", `env:${"x".repeat(70)}`], "is not a tag"],
        [["tag", "add"], "missing required argument"],
      ] as const) {
        r = await archon(...args);
        assertEquals(r.code === 0, false, args.join(" "));
        assertStringIncludes(r.out, said);
      }
      r = await archon("tag", "list");
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "env:prod");
      assertStringIncludes(r.out, "local");
      assert(!r.out.includes("env:staging"), "replaced");
      // remove: only what was said here.
      r = await archon("tag", "remove", "role:nas", "nope");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "does not say nope");
      assertStringIncludes((await archon("tag", "list", "--json")).out, '"dimension": "env"');
      // The fleet's rows are written at an apply: what the machine's own checkout says of it (person, rule, group).
      const { refreshFleetTags } = await import("../src/archon/fleet/machine-tags.ts");
      assertEquals(typeof refreshFleetTags, "function");
      // archon state carries the machine's words for the PC (machine-info as data, the tags table).
      r = await archon("--host", "alpha", "--json", "state");
      assertEquals(r.code, 0, r.out);
      const state = JSON.parse(jsonIn(r.out)) as {
        reported: { machineInfo?: Record<string, string>; tags: Array<{ value: string }> };
      };
      assertEquals(state.reported.machineInfo?.["DEPLOYMENT"], "production");
      assertEquals(
        state.reported.tags.map((t) => t.value).sort(),
        ["pilot", "prod", "north"].sort(),
      );
      // The PC: fleet status asks the server over SSH, keeps what it said in its cache, and shows the disagreement.
      await l.answer("alpha", JSON.stringify(state));
      r = await stolos(["fleet", "status"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "alpha reports env:prod; the fleet says env:lab");
      assertStringIncludes(r.out, "stolos tag accept alpha env:prod");
      assertEquals(
        (await sh(repo, "git", "status", "--porcelain")).includes("reported"),
        false,
        "no run commits",
      );
      // A word that is not a tag is a gap, said with --verbose, never an error; the claims it did make stand.
      r = await stolos(["fleet", "status", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "gap: 1 thing(s) it said were not tags and were dropped");
      assertStringIncludes(r.out, "1 claim(s) ignored by the fleet's dimensions");
      // A machine that cannot be reached keeps what it said last, and the status says so.
      await fs.remove(path.join(l.servers, "answer.alpha"));
      r = await stolos(["fleet", "status"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "unreachable now");
      assertStringIncludes(r.out, "alpha reports env:prod; the fleet says env:lab");
      // tag list: what the machine says, the status of each claim, the disagreement; JSON the same.
      r = await stolos(["tag", "list", "alpha"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "says env:prod");
      assertStringIncludes(r.out, "disagrees: the fleet says env:lab");
      assertStringIncludes(r.out, "alpha reports env:prod; the fleet says env:lab");
      assertStringIncludes(r.out, "says role:web");
      assertStringIncludes(r.out, "held as a hint");
      assertStringIncludes(r.out, "gap: 1 thing(s) the machine said were not tags");
      assertStringIncludes(r.out, "says zone:north");
      assertStringIncludes(r.out, "not defined in tags.ts (cannot be accepted)");
      assertStringIncludes(r.out, "env:lab");
      r = await stolos(["tag", "list", "alpha", "--json"]);
      const rec = JSON.parse(jsonIn(r.out)) as {
        tags: Array<{ id: string; origin: string; trust?: string }>;
        disagreements: Array<{ text: string }>;
        claims: Array<{ id: string; status: string }>;
        ignored: number;
      };
      assertEquals(rec.disagreements[0]?.text, "alpha reports env:prod; the fleet says env:lab");
      assertEquals(rec.tags.find((t) => t.id === "env:lab")?.origin, "person");
      assertEquals(rec.tags.find((t) => t.id === "role:web")?.trust, "hint");
      assertEquals(rec.claims.find((c) => c.id === "criticality:high")?.status, "ignored");
      assertEquals(rec.ignored, 1);
      // A hint does not choose machines unless --reported says so.
      r = await stolos(["tag", "list", "--tag", "role:web", "--json"]);
      assertEquals(
        (JSON.parse(jsonIn(r.out)) as { machines: unknown[] }).machines.length,
        1,
        "beta holds role:web from a person",
      );
      r = await stolos(["tag", "list", "--tag", "role:web", "--tag", "env:lab", "--json"]);
      assertEquals(
        (JSON.parse(jsonIn(r.out)) as { machines: unknown[] }).machines,
        [],
        "alpha's role:web is only a hint",
      );
      r = await stolos([
        "tag",
        "list",
        "--tag",
        "role:web",
        "--tag",
        "env:lab",
        "--reported",
        "--json",
      ]);
      assertEquals(r.code, 0, r.out);
      assertEquals(
        (JSON.parse(jsonIn(r.out)) as { machines: Array<{ machine: string }> }).machines.map(
          (m) => m.machine,
        ),
        ["alpha"],
      );
      // accept: refusals first (a tag it does not claim, one the fleet does not define), nothing written.
      const before = await sh(repo, "git", "status", "--porcelain");
      r = await stolos(["tag", "accept", "alpha", "env:staging"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "alpha does not claim env:staging");
      r = await stolos(["tag", "accept", "alpha", "zone:north"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(
        r.out,
        "zone:north is not defined in this fleet's tags.ts, so it cannot be accepted",
      );
      r = await stolos(["tag", "accept", "nope", "env:prod"]);
      assertEquals(r.code, 1, r.out);
      assertEquals(await sh(repo, "git", "status", "--porcelain"), before);
      // accept: one signed commit through stolos apply, by the code of tag add; the person's tag now wins over the rule.
      r = await stolos(["tag", "accept", "alpha", "env:prod", "role:web", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertEquals(await subject(), "112-machine-reported-tags: accept alpha env:prod role:web");
      const dec = await sh(origin, "git", "show", "main:fleets/lab/hosts/alpha/decisions.ts");
      assertStringIncludes(dec, '"env:prod"');
      assertStringIncludes(dec, '"role:web"');
      assert(!dec.includes('"env:lab"'), "env:prod replaces env:lab");
      r = await stolos(["tag", "list", "alpha", "--json"]);
      const after = JSON.parse(jsonIn(r.out)) as {
        tags: Array<{ id: string; origin: string }>;
        disagreements?: unknown[];
      };
      assertEquals(after.tags.find((t) => t.id === "env:prod")?.origin, "person");
      assertEquals(after.tags.find((t) => t.id === "role:web")?.origin, "person");
      assertEquals(after.disagreements, undefined, "now they agree");
      // Nothing of the machine's words was written to the repository before the accept.
      assert(!(await sh(repo, "git", "log", "--format=%s")).includes("reports"));
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script", timeout: 180_000 },
);

proves(
  [
    "112-machine-reported-tags FR-005",
    "112-machine-reported-tags FR-006",
    "112-machine-reported-tags FR-010",
    "112-machine-reported-tags FR-011",
    "112-machine-reported-tags FR-012",
  ],
  "112: host observe reads an adopted machine's probe, keeps what it says in the PC's cache (no commit), and tag accept writes machine.ts",
  async () => {
    const l = await lab();
    try {
      const { stolos, sh, repo, origin, probeRoot, sb } = l;
      // An adopted machine of the lab, as `host adopt` leaves it: its machine.ts, and its probe key in the vault.
      const dir = path.join(repo, "fleets", "lab", "adopted", "laptop");
      await fs.ensureDir(dir);
      await fs.writeTextFile(
        path.join(dir, "machine.ts"),
        machineSource({
          name: "laptop",
          owner: "alice",
          ssh: { user: "alice", address: "10.0.1.9" },
          hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexample"],
          adopted: AT,
          joined: "integrated",
        }),
      );
      const key = path.join(sb.home, "config", "stolos", "secrets", "lab", "adopted", "laptop");
      await fs.ensureDir(key);
      await fs.writeTextFile(
        path.join(key, "probe_key"),
        "not a key: the stand-in ssh ignores it\n",
      );
      await fs.writeTextFile(
        path.join(probeRoot, "machine-info"),
        'DEPLOYMENT=development\nLOCATION="Main office"\nCHASSIS=laptop\nTAGS="role:nas pilot"\n',
      );
      await fs.writeTextFile(path.join(probeRoot, "dmi", "sys_vendor"), "Dell Inc.\n");
      await fs.writeTextFile(path.join(probeRoot, "dmi", "chassis_type"), "10\n");
      let r = await stolos(["host", "observe", "laptop"]);
      assertEquals(r.code, 0, r.out);
      // What it said is in this PC's cache (not in the repository: only observed.ts changed), and is read as claims.
      const changed = (
        await sh(repo, "git", "status", "--porcelain", "--untracked-files=all")
      ).split("\n");
      assert(
        changed.every((x) => x.includes("adopted/laptop/")),
        changed.join("\n"),
      );
      r = await stolos(["tag", "list", "laptop", "--json"]);
      assertEquals(r.code, 0, r.out);
      const rec = JSON.parse(jsonIn(r.out)) as {
        tags: Array<{ id: string; origin: string; trust?: string; source?: string }>;
        claims: Array<{ id: string; source: string; status: string }>;
      };
      const by = (id: string) => rec.tags.find((t) => t.id === id);
      assertEquals(
        [by("env:lab")?.origin, by("env:lab")?.trust],
        ["reported", "accept"],
        "development is env:lab, and env accepts it",
      );
      assertEquals(by("site:main")?.trust, "accept", "Main office is site:main by the fleet's map");
      assertEquals([by("role:nas")?.origin, by("role:nas")?.trust], ["reported", "hint"]);
      assert(rec.claims.some((c) => c.id === "kind:laptop" && c.status === "undefined"));
      assert(rec.claims.some((c) => c.id === "hardware:dell-inc" && c.source === "smbios"));
      // An accepted claim is used to choose machines; a hint is not, unless --reported says so.
      r = await stolos(["tag", "list", "--tag", "env:lab", "--json"]);
      const names = (out: string) =>
        (JSON.parse(jsonIn(out)) as { machines: Array<{ machine: string }> }).machines.map(
          (m) => m.machine,
        );
      assert(names(r.out).includes("laptop"));
      r = await stolos(["tag", "list", "--tag", "role:nas", "--json"]);
      assert(!names(r.out).includes("laptop"));
      r = await stolos(["tag", "list", "--tag", "role:nas", "--reported", "--json"]);
      assert(names(r.out).includes("laptop"));
      // Keep the observation, then accept: the adopted machine's own file, one signed commit.
      r = await stolos(["apply", "-m", "067-adopt: observe laptop"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["tag", "accept", "laptop", "role:nas", "pilot", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertEquals(
        await sh(origin, "git", "log", "-1", "--format=%s", "main"),
        "112-machine-reported-tags: accept laptop role:nas pilot",
      );
      const machine = await sh(origin, "git", "show", "main:fleets/lab/adopted/laptop/machine.ts");
      assertStringIncludes(machine, '"role:nas"');
      assertStringIncludes(machine, '"pilot"');
      assert(!machine.includes("development"), "only what was accepted is written");
      r = await stolos(["tag", "list", "laptop", "--json"]);
      const after = JSON.parse(jsonIn(r.out)) as {
        tags: Array<{ id: string; origin: string }>;
      };
      assertEquals(after.tags.find((t) => t.id === "role:nas")?.origin, "person");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script", timeout: 180_000 },
);

// ------------------------------------------------------------------------------ FR-008: apply writes what the fleet knows

proves(
  ["112-machine-reported-tags FR-008", "112-machine-reported-tags FR-007"],
  "112: each archon apply writes the tags the fleet knows for the machine (source fleet), replacing the last and leaving the machine's own; a check writes nothing",
  async () => {
    const h = await hostRoot();
    try {
      const { apply } = await import("../src/archon/apply/apply.ts");
      const dir = h.at("/var/lib/archon");
      const alpha = (tags: string[]) => fixtureHost({ tags });
      const name = alpha([]).name;
      await putLocalTags(name, [{ dimension: "", value: "pilot", set_by: "alice" }], dir);
      // A check is read-only: nothing is written.
      await apply(alpha(["env:lab"]), { check: true });
      assertEquals(
        (await listTagRows(name, dir)).map((r) => r.source),
        ["local"],
      );
      // A real apply: a person's tag, a rule's (the example lab's os rule), as the fleet says them, beside the machine's own.
      await apply(alpha(["env:lab"]), { check: false });
      let rows = await listTagRows(name, dir);
      assertEquals(
        rows.map(
          (r) => `${r.dimension ? `${r.dimension}:` : ""}${r.value}@${r.source}:${r.set_by}`,
        ),
        ["env:lab@fleet:person", "os:linux@fleet:rule linux", "pilot@local:alice"],
      );
      // The next apply replaces the fleet's rows with what the checkout says now; the machine's own stay.
      await apply(alpha(["env:staging", "role:web"]), { check: false });
      rows = await listTagRows(name, dir);
      assertEquals(
        rows
          .filter((r) => r.source === "fleet")
          .map((r) => `${r.dimension}:${r.value}`)
          .sort(),
        ["env:staging", "os:linux", "role:web"],
      );
      assertEquals(rows.filter((r) => r.source === "local").length, 1);
      // The rows are what osquery's archon_tags and `archon state` carry.
      const { hostState } = await import("../src/archon/state/state-command.ts");
      const st = await hostState(name, dir);
      assertEquals(st.reported?.tags.length, 4);
    } finally {
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 180_000 },
);

// ------------------------------------------------------------------------------ the registry

proves(
  ["112-machine-reported-tags FR-007", "112-machine-reported-tags FR-012"],
  "112: archon tag add, remove and list are commands of the machine (mutate, mutate, read); tag accept is the PC's; the agent reaches the machine's",
  () => {
    const here = (name: string, place: string) =>
      COMMANDS.find((c) => c.name === name && c.place === place);
    assertEquals(here("tag add", "machine")?.tier, "mutate");
    assertEquals(here("tag remove", "machine")?.tier, "mutate");
    assertEquals(here("tag list", "machine")?.tier, "read");
    assertEquals(here("tag accept", "pc")?.tier, "repo");
    assert(here("tag add", "pc") !== undefined, "the PC's tag add stays");
    // Over MCP: the machine's archon_tag_add, never the PC's.
    const mcp = COMMANDS.filter((c) => listed(c, "mutate") && mcpToolName(c) === "archon_tag_add");
    assertEquals(mcp.length, 1);
    assertEquals(mcp[0]?.place, "machine");
    assert(
      !COMMANDS.some((c) => c.place === "pc" && listed(c, "mutate") && c.name.startsWith("tag ")),
    );
    // The last positional repeats on both.
    assertEquals(
      parseArgs(here("tag add", "machine") as never, ["env:prod", "pilot"])["tags"],
      "env:prod\npilot",
    );
    assertEquals(
      parseArgs(here("tag accept", "pc") as never, ["alpha", "env:prod", "role:web"])["tags"],
      "env:prod\nrole:web",
    );
  },
);

// ------------------------------------------------------------------------------ FR-013: the evidence

proves(
  ["112-machine-reported-tags FR-013"],
  "112: a disagreement is a failing finding of inventory accuracy (SCF AST-04); agreement passes; a machine that never reported gives none",
  async () => {
    const mk = (name: string, over: Record<string, unknown>) =>
      ({ ...FACTS.machines[0], name, kind: "server", ...over }) as (typeof FACTS.machines)[number];
    const f = {
      ...FACTS,
      machines: [
        mk("alpha", {
          reportedAt: AT,
          disagreements: ["alpha reports env:prod; the fleet says env:lab"],
        }),
        mk("beta", { reportedAt: AT }),
        mk("gamma", {}),
        mk("delta", { kind: "adopted", reportedAt: AT }),
      ],
      adopted: [],
    };
    const ev = fleetEvidence(f).filter((e) => e.check === "Reported tags agree with the fleet's");
    assertEquals(
      ev.map((e) => `${e.subject}:${e.status}`),
      ["alpha:fail", "beta:pass", "delta:pass"],
    );
    assertEquals(ev[0]?.scf, ["AST-04"]);
    assertStringIncludes(ev[0]?.detail ?? "", "alpha reports env:prod; the fleet says env:lab");
    assertStringIncludes(ev[0]?.fix ?? "", "stolos tag list alpha");
    assertEquals(ev[2]?.source, "adopted");
    // The SCF control is SCF's, with SCF's name (the pinned workbook, when this machine has it cached; CI requires it).
    const spec = await fs.readTextFile(
      path.join(ENGINE_ROOT, "specs/112-machine-reported-tags/spec.md"),
    );
    for (const word of [
      "AST-04",
      "Standards considered",
      "RFC 2119",
      "CM-8",
      "SP 800-128",
      "machine-info",
      "DSP0134",
      "Automatic Table Construction",
      "SKOS",
    ]) {
      assertStringIncludes(spec, word);
    }
    const plan = await fs.readTextFile(
      path.join(ENGINE_ROOT, "specs/112-machine-reported-tags/plan.md"),
    );
    assertStringIncludes(plan, "## Standards considered");
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
    assertEquals(catalog.controls["AST-04"]?.name, "Asset Inventories");
  },
);

// ------------------------------------------------------------------------------ FR-014, FR-015: the console

proves(
  ["112-machine-reported-tags FR-014", "112-machine-reported-tags FR-015"],
  "112: the console's chips say reported and announced in their own style; Machines say lists each claim with Accept and Ignore, escaped",
  () => {
    const held = resolveTags(kit, facts(), {}, {}, [
      claim("env:prod"),
      claim("role:web", "smbios"),
      claim("beta-test"),
      claim("role:nas", "machine-info", "announced"),
    ]).tags;
    const chip = (id: string) => tagChip(held.find((t) => t.id === id) as never).toString();
    assertStringIncludes(chip("env:prod"), 'class="tag c-red reported used"');
    assertStringIncludes(chip("env:prod"), '<span class="kind reported">reported</span>');
    assertStringIncludes(chip("role:web"), "reported hint");
    assertStringIncludes(chip("role:nas"), "tag c-violet announced hint");
    assertStringIncludes(chip("role:nas"), '<span class="kind announced">announced</span>');
    assertStringIncludes(chip("beta-test"), "custom reported hint");
    assertStringIncludes(chip("env:prod"), "the fleet accepts it");
    assertStringIncludes(chip("role:web"), "a hint, never used to choose machines");
    // A person's chip has no origin badge; a rule's says rule: the new ones do not look like those.
    const person = resolveTags(kit, facts(), { tags: ["env:lab"] }).tags[0];
    assert(person !== undefined && !tagChip(person).toString().includes("reported"));
    assertStringIncludes(tagChips(held).toString(), 'class="tags"');
    // The style: outlined in its colour (dotted for a hint), not filled; announced dotted grey; distinct from custom.
    assertStringIncludes(CONSOLE_CSS, ".tag.reported, .tag.announced { background: transparent;");
    assertStringIncludes(CONSOLE_CSS, ".tag.reported.hint { border-style: dotted; }");
    assertStringIncludes(CONSOLE_CSS, ".tag .kind.reported");
    assertStringIncludes(CONSOLE_CSS, ".tag .kind.announced");
    // The panel: a row per claim, Accept where it can be, Ignore always (a signal of the page, no state), the disagreement first.
    const says = resolveTags(kit, facts(), { tags: ["env:lab"] }, {}, [
      claim("env:prod"),
      claim("role:web"),
      claim("env:production"),
      claim("criticality:high"),
      claim("pilot"),
    ]);
    const panel = claimsPanel(
      "alpha",
      says.claims,
      says.disagreements.map((d) => d.text),
      {
        canAccept: true,
        gaps: 2,
      },
    ).toString();
    assertStringIncludes(panel, "<h2>Machines say</h2>");
    assertStringIncludes(panel, "alpha reports env:prod; the fleet says env:lab");
    assertStringIncludes(panel, "disagrees: the fleet says env:lab, and the fleet wins");
    assertStringIncludes(panel, "held as a hint");
    assertStringIncludes(panel, "not defined in this fleet&#39;s tags.ts");
    assertStringIncludes(panel, "1 claim(s) ignored by the fleet's dimensions");
    assertStringIncludes(panel, "Gap: 2 thing(s)");
    // Accept is a form that runs the registry command `tag accept`; not offered for an undefined or an ignored claim.
    assertEquals((panel.match(/name="command" value="tag accept"/g) ?? []).length, 3);
    assertStringIncludes(panel, '<input type="hidden" name="tags" value="env:prod"');
    assertStringIncludes(panel, "@post('/actions/run', {contentType: 'form'})");
    assert(
      !panel.includes('name="tags" value="env:production"'),
      "an undefined claim cannot be accepted",
    );
    assert(
      !panel.includes('name="tags" value="criticality:high"'),
      "an ignored one is not even listed",
    );
    // Ignore hides for the session: a signal and data-show, nothing posted, nothing kept.
    assertStringIncludes(panel, `data-signals="{hide: ''}"`);
    assertStringIncludes(panel, `data-on:click="$hide = $hide + ' env:prod '"`);
    assertStringIncludes(panel, `data-show="!$hide.includes(' env:prod ')"`);
    assert(!/Ignore[\s\S]{0,40}@post/.test(panel));
    // Without the right to change, there is no Accept; a claim with an unsafe id is not given a script.
    const view = claimsPanel("alpha", says.claims, [], { canAccept: false }).toString();
    assert(!view.includes('value="tag accept"'));
    const hostile = claimsPanel(
      "alpha",
      [
        {
          id: "x');alert(1);('",
          origin: "reported",
          source: "smbios",
          status: "held",
          trust: "hint",
        },
      ],
      [],
      { canAccept: true },
    ).toString();
    assert(!hostile.includes("$hide + "), hostile);
    assert(
      !hostile.includes("data-show"),
      "no expression is written for an id that is not the grammar",
    );
    assert(!hostile.includes("x');alert"), "the id is escaped wherever it is drawn");
    assertStringIncludes(hostile, "&#39;");
    // The table row's filter excludes hints.
    assertEquals(tagIds(held), " env:prod ");
    // The machine's page carries the panel (for a machine that reported), the machines table the chips, and the CSV says where each came from.
    const base = FACTS.machines.find((m) => m.kind === "server");
    assert(base !== undefined);
    const resolved = resolveTags(kit, facts({ name: base.name }), { tags: ["env:lab"] }, {}, [
      claim("env:prod"),
      claim("role:web", "smbios"),
    ]);
    const f = {
      ...FACTS,
      machines: FACTS.machines.map((m) =>
        m.name === base.name
          ? {
              ...m,
              tags: resolved.tags,
              says: resolved.claims,
              disagreements: resolved.disagreements.map((d) => d.text),
              reportedAt: AT,
            }
          : m,
      ),
    };
    const page = machinePage(f, base.name)?.toString() ?? "";
    assertStringIncludes(page, "<h2>Machines say</h2>");
    assertStringIncludes(page, `${base.name} reports env:prod; the fleet says env:lab`);
    assertStringIncludes(page, 'name="command" value="tag accept"');
    assertStringIncludes(page, `name="machine" value="${base.name}"`);
    const none = machinePage(FACTS, base.name)?.toString() ?? "";
    assert(!none.includes("Machines say"), "a machine that never reported has no panel");
    assertStringIncludes(machinesPage(f).toString(), "reported");
    assertStringIncludes(machinesCsv(f), "reported by the machine (smbios), a hint");
  },
);

// ------------------------------------------------------------------------------ FR-017, FR-018: the constitution and the guides

proves(
  ["112-machine-reported-tags FR-017", "112-machine-reported-tags FR-018"],
  "112: the constitution is 6.3.0 and says a machine may record claims about itself; the guide says what is true",
  async () => {
    const c = await fs.readTextFile(path.join(ENGINE_ROOT, ".specify/memory/constitution.md"));
    assertStringIncludes(c, "**Version**: 6.3.0");
    assertStringIncludes(
      c,
      "A machine MAY record facts and claims about itself\nwith `archon`, in its own state database, and none of it changes configuration.",
    );
    assertStringIncludes(c, "| 6.3.0 | 2026-11-17 |");
    const article25 = c.slice(c.indexOf("## Article 25"), c.indexOf("## Article 26"));
    assertStringIncludes(article25, "A machine MAY record facts and claims about itself");
    const guide = await fs.readTextFile(path.join(ENGINE_ROOT, "src/archon/fleet/mod.ts"));
    for (const word of [
      "machine-info",
      "fromMachine",
      "tag accept",
      "archon_tags",
      "Machines say",
    ]) {
      assertStringIncludes(guide, word);
    }
    assertStringIncludes(guide, "```mermaid");
  },
);
