/**
 * Spec 071: the official catalogs (SCF, NIST), and the fleet in OSCAL.
 *
 * @module
 */
import { zipDeflated } from "@intellectual-frontiers/formats";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { fs, proc, toError } from "@intellectual-frontiers/system";
import { Ajv, type AnySchema } from "ajv";
import {
  catalogCache,
  loadNist,
  loadScf,
  NIST_SOURCES,
  parseOscalCatalog,
  parseScf,
  SCF_SOURCE,
  type ScfEntry,
  tidyRequirement,
} from "../src/archon/compliance/catalog.ts";
import { complianceView, type Evidence, fleetEvidence } from "../src/archon/compliance/report.ts";
import { SCF } from "../src/archon/compliance/scf.ts";
import { nistControls, oscal80053, oscalExports, uuidFor } from "../src/archon/compliance/oscal.ts";
import { FACTS } from "./console/serve-stolos.ts";

/** A ZIP of these files (deflated), as the engine writes its bundles. */
const zipped = (files: Record<string, Uint8Array>): Promise<Uint8Array> =>
  zipDeflated(new Map(Object.entries(files)));

const enc = new TextEncoder();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A small workbook shaped like SCF's: shared strings, an inline string, CRLF in headers. */
function workbook(rows: string[][]): Promise<Uint8Array> {
  const shared: string[] = [];
  const cols = (i: number) => String.fromCharCode(65 + (i % 26)).padStart(i >= 26 ? 2 : 1, "A");
  const sheet = rows
    .map(
      (r, y) =>
        `<row r="${y + 1}">${r
          .map((v, x) => {
            if (v === "") return "";
            if (y === 1 && x === 1) {
              return `<c r="${cols(x)}${y + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
            }
            shared.push(v);
            return `<c r="${cols(x)}${y + 1}" t="s"><v>${shared.length - 1}</v></c>`;
          })
          .join("")}</row>`,
    )
    .join("");
  return zipped({
    "xl/workbook.xml": enc.encode(
      `<workbook><sheets><sheet name="Authoritative Sources" sheetId="1" r:id="rId1"/><sheet name="SCF ${SCF_SOURCE.version}" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": enc.encode(
      `<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": enc.encode(
      `<sst>${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`,
    ),
    "xl/worksheets/sheet1.xml": enc.encode(`<worksheet><sheetData/></worksheet>`),
    "xl/worksheets/sheet2.xml": enc.encode(
      `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
    ),
  });
}

const HEADER = [
  "SCF Domain",
  "SCF Control",
  "SCF #",
  "Secure Controls Framework (SCF)\r\nControl Description",
  "AICPA\r\nTSC 2017:2022 (used for SOC 2)",
  "USA\r\nFederal\r\nHIPAA Security Rule\r\nNIST SP 800-66 R2",
  "USA\r\nFederal\r\nHIPAA Administrative Simplification 2013",
  "PCI DSS\r\n4.0.1",
  "USA\r\nFederal\r\nCMMC 2.0\r\nLevel 2",
  "NIST\r\n800-53\r\nR5.2",
  "NIST\r\n800-171\r\nR3",
  "USA\r\nFederal\r\nFedRAMP R5\r\n(moderate)",
];
const ROWS = [
  HEADER,
  [
    "Cryptographic Protections",
    "Encrypting Data At Rest",
    "CRY-07",
    "Mechanisms exist to prevent unauthorized disclosure of data at rest.",
    "CC6.1\r\nCC6.1-POF10",
    "",
    "§ 164.312(a)(2)(iv)",
    "3.5.1",
    "SCL2.-3.13.16",
    "SC-28\r\nSC-28(01)",
    "03.13.08",
    "SC-28\r\nSC-28(01)",
  ],
  [
    "Change Management",
    "Configuration Change Control",
    "CHG-03",
    "Mechanisms exist to govern the technical configuration change control processes.",
    "CC8.1",
    "§ 164.308(a)(1)(ii)(B)",
    "§ 164.308(a)(1)(ii)(B)",
    "6.5.1",
    "CML2.-3.4.3",
    "CM-03",
    "03.04.03",
    "CM-03",
  ],
  ["Notes", "a row without an id", "", "", "", "", "", "", "", "", "", ""],
];

const CATALOG = await parseScf(await workbook(ROWS));
const entry = (id: string): ScfEntry => got(CATALOG.controls[id], id);

proves(
  ["071-catalogs-oscal FR-002"],
  "071: the SCF workbook is read by its headers; ids are the frameworks' own",
  () => {
    assertEquals(Object.keys(CATALOG.controls), ["CRY-07", "CHG-03"]);
    const c = entry("CRY-07");
    assertEquals(c.name, "Encrypting Data At Rest");
    assertEquals(c.domain, "Cryptographic Protections");
    assertStringIncludes(c.description, "data at rest");
    assertEquals(c.maps.soc2, ["CC6.1", "CC6.1-POF10"]);
    assertEquals(c.maps.hipaa, ["164.312(a)(2)(iv)"]); // the "§" dropped
    assertEquals(c.maps.cmmc, ["SC.L2-3.13.16"]); // CMMC's own form
    assertEquals(c.maps.nist80053, ["SC-28", "SC-28(01)"]);
    // HIPAA is the union of both columns, without duplicates.
    assertEquals(entry("CHG-03").maps.hipaa, ["164.308(a)(1)(ii)(B)"]);
    assertEquals(tidyRequirement(" § 164.312(d)"), "164.312(d)");
    assertEquals(tidyRequirement("IAL2.-3.5.3"), "IA.L2-3.5.3");
    assertEquals(tidyRequirement("8.4.2"), "8.4.2");
  },
);

proves(
  ["071-catalogs-oscal FR-002"],
  "071: a workbook without the SCF sheet or columns is refused",
  async () => {
    let err = "";
    try {
      await parseScf(await workbook(ROWS), "1999.1");
    } catch (e) {
      err = toError(e).message;
    }
    assertStringIncludes(err, 'no sheet "SCF 1999.1"');
    err = "";
    try {
      await parseScf(
        await workbook([
          ["SCF #", "SCF Control"],
          ["CRY-07", "x"],
        ]),
      );
    } catch (e) {
      err = toError(e).message;
    }
    assertStringIncludes(err, "none of the framework columns");
  },
);

proves(
  ["071-catalogs-oscal FR-003"],
  "071: catalogs download once, only with the pinned SHA-256, then come from the cache",
  async () => {
    const dir = await fs.makeTempDir();
    const nist = enc.encode(
      JSON.stringify({
        catalog: {
          groups: [{ controls: [{ id: "sc-28", title: "Protection of Information at Rest" }] }],
        },
      }),
    );
    let gets = 0;
    const wrong = () => {
      gets++;
      return workbook(ROWS);
    };
    const refused = await loadScf({ cacheDir: dir, download: true, get: wrong }).then(
      () => "",
      (e: Error) => e.message,
    );
    assertStringIncludes(refused, `expected ${SCF_SOURCE.sha256}: not used`);
    assertEquals(await loadScf({ cacheDir: dir }), undefined, "nothing cached after a refusal");
    // The pinned hashes are real: a test cannot forge them, so check the cache path instead.
    await fs.writeTextFile(`${dir}/scf-${SCF_SOURCE.version}.json`, JSON.stringify(CATALOG));
    assertEquals(
      got((await loadScf({ cacheDir: dir, get: wrong }))?.controls["CRY-07"]).name,
      entry("CRY-07").name,
    );
    await fs.writeTextFile(
      `${dir}/scf-${SCF_SOURCE.version}.json`,
      JSON.stringify({ ...CATALOG, format: 0 }),
    );
    assertEquals(await loadScf({ cacheDir: dir }), undefined, "an old cache format is read again");
    assertEquals(gets, 1);
    const parsed = parseOscalCatalog(JSON.parse(new TextDecoder().decode(nist)), "nist80053");
    assertEquals(parsed.titles, { "sc-28": "Protection of Information at Rest" });
    assertEquals(parsed.url, NIST_SOURCES.nist80053.url);
    await fs.writeTextFile(`${dir}/nist80053.json`, JSON.stringify(parsed));
    assertEquals(
      got(await loadNist("nist80053", { cacheDir: dir })).titles["sc-28"],
      parsed.titles["sc-28"],
    );
    assert(catalogCache().endsWith("catalogs"));
    await fs.remove(dir, { recursive: true });
  },
);

proves(
  ["071-catalogs-oscal FR-004"],
  "071: without the catalog there are no mappings; with it, they are SCF's (SOC 2 by criterion)",
  () => {
    const ev = fleetEvidence(FACTS);
    const none = complianceView(ev);
    assertEquals(none.catalog, undefined);
    assert(none.frameworks.every((f) => f.requirements.length === 0));
    const v = complianceView(ev, CATALOG);
    assertEquals(got(v.catalog).version, SCF_SOURCE.version);
    const soc2 = got(v.frameworks.find((f) => f.id === "soc2"));
    assertEquals(
      soc2.requirements.map((r) => r.id),
      ["CC6.1", "CC8.1"],
    );
    assertEquals(got(soc2.requirements.find((r) => r.id === "CC8.1")).status, "fail"); // unapproved commits
    const cry = got(v.controls.find((c) => c.control.id === "CRY-07"));
    assertStringIncludes(got(cry.control.description), "data at rest");
    assertEquals(got(v.frameworks.find((f) => f.id === "fedramp")).requirements.length, 3);
  },
);

/** An optional check against the real workbook, when this PC has it cached. */
const real = await loadScf().catch(() => undefined);
if (!real && proc.env.get("STOLOS_REQUIRE_SCF")) {
  throw new Error("071: STOLOS_REQUIRE_SCF is set (CI) but the SCF catalog is not cached");
}
proves(
  ["071-catalogs-oscal FR-001"],
  "071: every SCF id Stolos cites is in the SCF release, with SCF's name",
  () => {
    for (const c of SCF) {
      assertEquals(got(real).controls[c.id]?.name, c.name, c.id);
    }
  },
  { skip: !real && "the SCF catalog is not cached on this PC" },
);

proves(
  ["071-catalogs-oscal FR-006"],
  "071: SP 800-53 ids in OSCAL's form; UUIDs are v5 and stable",
  async () => {
    assertEquals(oscal80053("SC-28(01)"), "sc-28.1");
    assertEquals(oscal80053("IA-02"), "ia-2");
    assertEquals(oscal80053("AC-17(10)"), "ac-17.10");
    assertEquals(oscal80053("see note"), undefined);
    const a = await uuidFor("fleet", "x");
    assertEquals(a, await uuidFor("fleet", "x"));
    assert(a !== (await uuidFor("fleet", "y")));
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), a);
    const n = nistControls(complianceView(fleetEvidence(FACTS), CATALOG), { "sc-28": "t" });
    assertEquals(
      n.map((x) => x.id),
      ["sc-28"],
      "only controls in NIST's catalog, when it is known",
    );
  },
);

const schema = JSON.parse(
  await fs.readTextFile(
    new URL("../vendor/oscal/oscal_complete_schema-1.2.3.json", import.meta.url),
  ),
) as AnySchema;
const validate = new Ajv({ strict: false, logger: false, allErrors: true }).compile(schema);

proves(
  ["071-catalogs-oscal FR-005", "071-catalogs-oscal FR-006"],
  "071: the four OSCAL documents are valid OSCAL 1.2.3, and the same input exports the same",
  async () => {
    const accepted: Evidence = {
      scf: ["CRY-07"],
      subject: "alice-mbp",
      source: "adopted",
      check: "The disk is encrypted",
      status: "accepted",
      detail: "accepted by Alice until 2026-12-31: no customer data here",
    };
    const input = {
      view: complianceView([...fleetEvidence(FACTS), accepted], CATALOG),
      fleet: FACTS.fleet,
      machines: FACTS.machines,
      version: "0.0.0",
      now: new Date("2026-11-15T12:00:00Z"),
    };
    const docs = await oscalExports(input);
    assertEquals(Object.keys(docs), [
      "component-definition.json",
      "system-security-plan.json",
      "assessment-results.json",
      "poam.json",
    ]);
    for (const [name, doc] of Object.entries(docs)) {
      const ok = validate(doc);
      assert(ok, `${name}: ${JSON.stringify(validate.errors?.slice(0, 3), null, 1)}`);
    }
    assertEquals(JSON.stringify(await oscalExports(input)), JSON.stringify(docs));
    type Doc = Record<string, Record<string, unknown>>;
    const ar = (docs["assessment-results.json"] as Doc)["assessment-results"];
    const findings = got(
      (
        got(ar)["results"] as Array<{
          findings: Array<{ target: { "target-id": string; status: { state: string } } }>;
        }>
      )[0],
    ).findings;
    const cm3 = got(findings.find((f) => f.target["target-id"] === "cm-3_obj"));
    assertEquals(cm3.target.status.state, "not-satisfied"); // unapproved commits fail CHG-03
    const p = (docs["poam.json"] as Doc)["plan-of-action-and-milestones"];
    const risks = got(p)["risks"] as Array<{ title: string; status: string }>;
    assertEquals(
      got(risks.find((r) => r.title === "alice-mbp: The disk is encrypted")).status,
      "deviation-approved",
    );
    assert(risks.some((r) => r.status === "open"));
    const ssp = (docs["system-security-plan.json"] as Doc)["system-security-plan"];
    assertStringIncludes(
      JSON.stringify(got(ssp)["import-profile"]),
      "MODERATE-baseline_profile.json",
    );
    assert(
      !validate({ "plan-of-action-and-milestones": { uuid: "not-a-uuid" } }),
      "the schema bites",
    );
  },
);

/** The value the test expects to be there. */
function got<T>(value: T | undefined | null, what = "a value"): T {
  assertExists(value, `${what} is missing`);
  return value;
}

proves(
  ["071-catalogs-oscal FR-001"],
  "071: Stolos's own list of SCF controls holds only each id, SCF's name, and what Stolos looks at",
  async () => {
    const { SCF_CONTROLS } = await import("../src/archon/compliance/scf.ts");
    assertEquals(SCF.length, SCF_CONTROLS.length);
    for (const c of SCF_CONTROLS) {
      assertEquals(Object.keys(c).sort(), ["how", "id", "name"], c.id);
      assert(/^[A-Z]{3}-\d{2}(\.\d+)?$/.test(c.id), c.id);
      assert(c.name.trim() !== "" && c.how.trim() !== "", c.id);
    }
    // Descriptions and mappings are SCF's, from the catalog (never written here).
    const src = await fs.readTextFile("src/archon/compliance/scf.ts");
    assert(!/\b(description|maps|soc2|hipaa)\s*:/.test(src.slice(src.indexOf("SCF_CONTROLS"))));
    // Against SCF 2026.3 itself, where this PC has it (bun run stolos compliance catalog): every
    // id is SCF's, with SCF's own name.
    const catalog = await loadScf();
    if (catalog !== undefined) {
      assertEquals(catalog.version, "2026.3");
      for (const c of SCF_CONTROLS) {
        assertEquals(catalog.controls[c.id]?.name, c.name, `${c.id} in SCF ${catalog.version}`);
      }
    }
  },
);
