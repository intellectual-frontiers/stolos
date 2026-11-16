/**
 * Spec 076: FedRAMP 20x Key Security Indicators mapped to Stolos evidence, and the Class A and
 * Class B validation package (the Security Decision Record) in FedRAMP's own JSON format.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { FACTS } from "./console/serve-stolos.ts";
import type { PcFacts } from "../src/archon/console/pc.ts";
import { loadScf } from "../src/archon/compliance/catalog.ts";
import { SCF } from "../src/archon/compliance/scf.ts";
import {
  CLASS_A_KSIS,
  CLASS_RULES,
  FEDRAMP_RULES,
  KSIS,
} from "../src/archon/fedramp/rules.auto.ts";
import {
  covered,
  KSI_MAP,
  ksiEvidence,
  ksiMappings,
  strmLinks,
} from "../src/archon/fedramp/mapping.ts";
import {
  cadenceMs,
  classKsis,
  evidenceObservedAt,
  fedrampPackage,
  placeholderOverview,
} from "../src/archon/fedramp/package.ts";
import { COMMANDS, findCommand } from "../src/archon/commands/registry.ts";
import { STOLOS_GROUPS } from "../src/archon/console/stolos-pages.ts";

const DIR = new URL(`../vendor/fedramp/${FEDRAMP_RULES.version}/`, import.meta.url);
const read = (f: string): Uint8Array => fs.readFileSync(new URL(f, DIR));
const json = (f: string): AnySchema & { $id?: string } =>
  JSON.parse(new TextDecoder().decode(read(f))) as AnySchema & { $id?: string };
const sha = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

/** FedRAMP's dataset, read here on its own (not through the generated module). */
const RULES = json("fedramp-consolidated-rules.json") as {
  info: { version: string };
  KSI: Record<string, { indicators: Record<string, { statement?: string }> }>;
  FRR: { FRC: { data: { all: { CLA: Record<string, { following_information: string[] }> } } } };
};
const OFFICIAL = Object.values(RULES.KSI).flatMap((t) => Object.keys(t.indicators));

const SDR = "fedramp-security-decision-record-schema-2026-06-24.json";
const COMMON = "fedramp-common-definitions-schema-2026-06-24.json";

/** Ajv for draft 2020-12, with the formats the FedRAMP schemas use checked (no new dependency). */
function ajv(): Ajv2020 {
  const a = new Ajv2020({ strict: false, logger: false, allErrors: true });
  a.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
  a.addFormat(
    "date-time",
    (s: string) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) &&
      !isNaN(Date.parse(s)),
  );
  a.addFormat("email", /^[^@\s]+@[^@\s]+$/);
  a.addFormat("uri", (s: string) => {
    try {
      return /^[a-z][a-z0-9+.-]*:/i.test(s) && !!new URL(s);
    } catch {
      return false;
    }
  });
  return a;
}
function sdrValidator() {
  const a = ajv();
  a.addSchema(json(COMMON));
  return a.compile(json(SDR));
}

proves(
  ["076-fedramp-20x FR-001"],
  "076: the vendored FedRAMP files are the pinned ones (SHA-256)",
  async () => {
    const readme = new TextDecoder().decode(read("README.md"));
    for (const f of [
      "fedramp-consolidated-rules.json",
      "fedramp-consolidated-rules.schema.json",
      SDR,
      COMMON,
    ]) {
      const h = await sha(read(f));
      assert(readme.includes(`\`${h}\``), `${f}: ${h} is in the README`);
    }
    assertEquals(await sha(read("fedramp-consolidated-rules.json")), FEDRAMP_RULES.sha256);
    assertEquals(RULES.info.version, FEDRAMP_RULES.version);
    assertEquals(json(SDR).$id, FEDRAMP_RULES.sdrSchema);
  },
);

test("076: FedRAMP's dataset is valid against FedRAMP's own schema", () => {
  const v = ajv().compile(json("fedramp-consolidated-rules.schema.json"));
  assert(v(RULES), JSON.stringify(v.errors?.slice(0, 5)));
});

proves(
  ["076-fedramp-20x FR-001"],
  "076: the generated module is what the generator writes from the vendored rules",
  async () => {
    const r = await proc.output(
      [
        proc.execPath(),
        path.fromFileUrl(new URL("../tools/fedramp-gen.ts", import.meta.url)),
        "--check",
      ],
      { stdin: "null" },
    );
    assert(r.code === 0, new TextDecoder().decode(r.stderr));
  },
);

proves(
  ["076-fedramp-20x FR-002"],
  "076: every official KSI appears exactly once, covered or not observable with a reason",
  () => {
    assertEquals(OFFICIAL.length, 46);
    assertEquals(
      KSIS.map((k) => k.id),
      OFFICIAL,
    );
    assertEquals(Object.keys(KSI_MAP).sort(), [...OFFICIAL].sort());
    assertEquals(ksiMappings().length, OFFICIAL.length);
    const scfIds = new Set(SCF.map((c) => c.id));
    for (const { ksi, mapping } of ksiMappings()) {
      assert(mapping.reason.trim().length > 20, `${ksi.id} has a reason`);
      assert(!/[—–]/.test(mapping.reason), `${ksi.id}: no dashes`);
      if (covered(mapping)) {
        assert(mapping.scf.length, `${ksi.id} names checks`);
        for (const s of mapping.scf)
          assert(scfIds.has(s), `${ksi.id}: ${s} is a Stolos SCF control`);
      } else {
        assert(
          ["process", "document", "contract", "not read"].includes(mapping.notObservable),
          ksi.id,
        );
      }
    }
    const n = ksiMappings().filter((m) => covered(m.mapping)).length;
    assertEquals(n + ksiMappings().filter((m) => !covered(m.mapping)).length, 46);
  },
);

proves(
  ["076-fedramp-20x FR-001", "076-fedramp-20x FR-003"],
  "076: Class A is FRC-CLA-MFR's KSIs; Class B is every KSI, with FedRAMP's optional ones",
  () => {
    const mfr = got(RULES.FRR.FRC.data.all.CLA["FRC-CLA-MFR"])
      .following_information.map(
        (l) => l.match(/^Key Security Indicators: (KSI-[A-Z]{3}-[A-Z]{3})/)?.[1],
      )
      .filter(Boolean);
    assertEquals([...CLASS_A_KSIS], mfr);
    assertEquals(
      classKsis("A").map((k) => k.ksi.id),
      OFFICIAL.filter((id) => mfr.includes(id)),
    );
    assert(classKsis("A").every((k) => k.applies === "required"));
    const b = classKsis("B");
    assertEquals(
      b.map((k) => k.ksi.id),
      OFFICIAL,
    );
    assertEquals(
      b.filter((k) => k.applies === "optional").map((k) => k.ksi.id),
      ["KSI-CNA-EIS", "KSI-MLA-ALA", "KSI-SVC-PRR", "KSI-SVC-RUD", "KSI-SVC-VCM"],
    );
    // The cadences and expectations are the rules' own, per class.
    assertEquals(CLASS_RULES.A.automation.force, "MAY");
    assertEquals(CLASS_RULES.A.automation.minMethods, 0);
    assertEquals(CLASS_RULES.B.automation.force, "SHOULD");
    assertEquals(CLASS_RULES.B.automation.minMethods, 1);
    assertEquals(CLASS_RULES.A.machineValidation.every, { unit: "months", count: 1 });
    assertEquals(CLASS_RULES.A.machineValidation.force, "SHOULD");
    assertEquals(CLASS_RULES.B.machineValidation.every, { unit: "days", count: 7 });
    assertEquals(CLASS_RULES.B.machineValidation.force, "MUST");
    assertEquals(CLASS_RULES.A.packageMaintenance.every, { unit: "months", count: 3 });
    assertEquals(CLASS_RULES.B.packageMaintenance.every, { unit: "months", count: 1 });
    assertEquals(CLASS_RULES.B.packageMaintenance.force, "MUST");
    assertEquals(cadenceMs(CLASS_RULES.B.machineValidation), 7 * 86_400_000);
  },
);

const NOW = new Date("2026-11-15T12:00:00Z");
/** The fixture fleet, every observation ten days old: within Class A's month, past Class B's week. */
function tenDaysOld(): PcFacts {
  const old = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
  const f = structuredClone(FACTS);
  for (const m of f.machines) {
    m.seen = old;
    delete m.sync;
    delete m.applied;
  }
  for (const a of f.adopted) if (a.observed) a.observed.at = old;
  for (const d of f.devices) if (d.observed) d.observed.at = old;
  for (const c of f.clouds) if (c.observed) c.observed.at = old;
  for (const l of f.git.log) l.at = old;
  return f;
}

proves(
  ["076-fedramp-20x FR-003"],
  "076: the Class A and Class B packages validate against FedRAMP's SDR schema",
  () => {
    const valid = sdrValidator();
    for (const cls of ["A", "B"] as const) {
      for (const facts of [FACTS, tenDaysOld()]) {
        const p = fedrampPackage(facts, cls, { now: NOW, stolosVersion: "0.0.0" });
        assert(valid(p.sdr), `${cls}: ${JSON.stringify(valid.errors?.slice(0, 5))}`);
        assertEquals(p.sdr.keySecurityIndicators.length, cls === "A" ? 7 : 46);
        assertEquals(p.counts.covered + p.counts.notObservable, p.counts.ksis);
      }
    }
    // A real overview URI is used as given; a wrong shape is refused by the schema.
    const p = fedrampPackage(FACTS, "A", { now: NOW, overviewUri: "https://example.com/cpo.json" });
    assertEquals(p.sdr.certificationPackageOverviewUri, "https://example.com/cpo.json");
    assert(valid(p.sdr));
    assert(!valid({ ...p.sdr, certificationPackageOverviewUri: "not a uri" }));
    assert(!valid({ ...p.sdr, keySecurityIndicators: [{ ksiId: "KSI-CED-RAT" }] }));
    assertEquals(placeholderOverview("lab"), "urn:stolos:fleet:lab:certification-package-overview");
  },
);

proves(
  ["076-fedramp-20x FR-003"],
  "076: each KSI's record: measures, cycle, tests, evidence with times; or why not observable",
  () => {
    const p = fedrampPackage(FACTS, "B", { now: NOW });
    for (const r of p.ksis) {
      const s = got(p.sdr.keySecurityIndicators.find((x) => x.ksiId === r.ksi.id));
      if (!covered(r.mapping)) {
        assertEquals(r.status, "not observable");
        assertEquals(s.ksiImplementationStatus, undefined, "the provider states it");
        assertEquals(s.ksiTests, []);
        assert(s.ksiImplementation.some((l) => l.includes(r.mapping.reason)));
        continue;
      }
      assertEquals(r.evidence, ksiEvidence(r.mapping, r.evidence));
      assert(
        s.ksiImplementation.some((l) => l.startsWith("Cycle:")),
        r.ksi.id,
      );
      assertEquals(s.ksiTests, r.tests);
      assertEquals(s.ksiEvidence.length, r.evidence.length);
      if (r.status === "pass") assertEquals(s.ksiImplementationStatus, "Implemented");
      if (r.status === "no evidence") assertEquals(s.ksiImplementationStatus, undefined);
    }
    const opt = got(p.sdr.keySecurityIndicators.find((x) => x.ksiId === "KSI-SVC-RUD"));
    assert(opt.ksiImplementation[0]?.includes("optional for Class B"));
    // The cloud-only KSI counts only cloud evidence.
    const ibp = got(p.ksis.find((r) => r.ksi.id === "KSI-CNA-IBP"));
    assert(ibp.evidence.every((e) => e.source === "cloud"));
    // A failing check is named, and the KSI is not reported as implemented.
    const lmc = got(p.ksis.find((r) => r.ksi.id === "KSI-CMT-LMC"));
    assertEquals(lmc.status, "fail");
    assert(
      got(p.sdr.keySecurityIndicators.find((x) => x.ksiId === "KSI-CMT-LMC"))
        .ksiImplementationStatus !== "Implemented",
    );
  },
);

proves(
  ["076-fedramp-20x FR-003"],
  "076: evidence ages against each class's cadence (VDR-TFR-MVX)",
  () => {
    const f = tenDaysOld();
    const a = fedrampPackage(f, "A", { now: NOW });
    const b = fedrampPackage(f, "B", { now: NOW });
    const mvx = (p: typeof a) =>
      got(p.sdr.fedRampRequirements.find((r) => r.frrID === "VDR-TFR-MVX")).frrImplementationStatus;
    assertEquals(mvx(a), "Implemented", "ten days is within Class A's month");
    assertEquals(mvx(b), "Partially Implemented", "ten days is past Class B's 7 days");
    const timed = (p: typeof a) => p.ksis.filter((r) => r.observed);
    assert(timed(a).length && timed(a).every((r) => r.fresh === true));
    assert(timed(b).length && timed(b).every((r) => r.fresh === false));
    // Class B asks for at least one automated method per KSI; Class A may have none.
    const vvk = (p: typeof a) =>
      got(p.sdr.fedRampRequirements.find((r) => r.frrID === "FRC-CSX-VVK"));
    assert(vvk(b).frrImplementation[0]?.includes("SHOULD"));
    assert(vvk(a).frrImplementation[0]?.includes("MAY"));
    // The record's own times are the run's.
    assertEquals(b.sdr.metadata.lastUpdated, NOW.toISOString());
    assert(b.sdr.metadata.version.startsWith("class-b+"));
  },
);

proves(
  ["076-fedramp-20x FR-004"],
  "076: an observation time on the evidence itself wins (the spec 073 hook)",
  () => {
    const e = {
      scf: ["CFG-04"],
      subject: "alpha",
      source: "managed" as const,
      check: "x",
      status: "pass" as const,
      detail: "",
    };
    assertEquals(
      evidenceObservedAt({ ...e, observedAt: "2026-01-02T03:04:05Z" }, FACTS),
      "2026-01-02T03:04:05Z",
    );
    assert(evidenceObservedAt(e, FACTS), "else the time the PC knows for alpha");
    assertEquals(evidenceObservedAt({ ...e, source: "repository" }, FACTS), FACTS.git.log[0]?.at);
  },
);

/** With the real SCF catalog cached on this PC: the STRM links are SCF's, to the KSI's own controls. */
const real = await loadScf().catch(() => undefined);
proves(
  ["076-fedramp-20x FR-002"],
  "076: SCF STRM links reach only the KSI's own SP 800-53 controls",
  () => {
    let linked = 0;
    for (const { ksi, mapping } of ksiMappings()) {
      const l = strmLinks(ksi, mapping, real);
      for (const [s, cs] of Object.entries(l)) {
        assert(covered(mapping) && mapping.scf.includes(s));
        for (const c of cs) assert(ksi.controls.includes(c), `${ksi.id}: ${c}`);
      }
      if (Object.keys(l).length) linked++;
    }
    assert(linked > 10, `${linked} KSIs reach SP 800-53 through SCF`);
  },
  { skip: !real && "the SCF catalog is not cached on this PC" },
);

proves(
  ["076-fedramp-20x FR-005"],
  "076: stolos compliance fedramp is a read command on the PC, in a console group",
  () => {
    const c = got(findCommand(["compliance", "fedramp"], "pc")).cmd;
    assertEquals(c.name, "compliance fedramp");
    assertEquals(c.tier, "read");
    assert(COMMANDS.includes(c));
    assert(STOLOS_GROUPS.some((g) => g.names.includes("compliance fedramp")));
    assertEquals(
      c.args.map((x) => x.name),
      ["class", "out", "overview"],
    );
  },
);

/** The value the test expects to be there. */
function got<T>(value: T | undefined | null, what = "a value"): T {
  assertExists(value, `${what} is missing`);
  return value;
}

/** A guide's section: from its heading to the next heading of its level or higher (outside code). */
function guideSection(md: string, heading: string): string {
  const lines = md.split("\n");
  const start = lines.indexOf(heading);
  assert(start >= 0, `"${heading}" in the guide`);
  const level = heading.indexOf(" ");
  let fence = false;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (!fence && new RegExp(`^#{1,${level}} `).test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

proves(
  ["076-fedramp-20x FR-006"],
  "076: the compliance guide explains FedRAMP 20x, with a diagram",
  async () => {
    const { engineFile } = await import("../src/archon/core/assets.ts");
    const s = guideSection(engineFile("docs/compliance.md"), "## FedRAMP 20x");
    assertStringIncludes(s, "```mermaid\n");
    for (const w of ["Key Security Indicators", "Class A", "Class B", "Security Decision Record"]) {
      assertStringIncludes(s, w);
    }
    assertStringIncludes(s, "bun run stolos compliance fedramp --class A");
  },
);
