/**
 * Spec 068: SCF controls from evidence, and frameworks from controls.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertExists,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { SCF } from "../src/archon/compliance/scf.ts";
import type { ScfCatalog } from "../src/archon/compliance/catalog.ts";
import {
  combine,
  complianceView,
  type Evidence,
  fleetEvidence,
  serverEvidence,
} from "../src/archon/compliance/report.ts";
import { policies } from "../src/archon/adopt/policy.ts";
import { toObserved } from "../src/archon/adopt/adopt.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";
import { FACTS } from "./console/serve-stolos.ts";

/** A two-control catalog shaped like SCF's (the real one comes from the SCF Council, spec 071). */
const none = { soc2: [], hipaa: [], pci: [], cmmc: [], nist80053: [], nist800171: [], fedramp: [] };
const CATALOG: ScfCatalog = {
  format: 1,
  version: "test",
  controls: {
    "IAC-14": {
      domain: "",
      name: "Authenticator Management",
      description: "",
      maps: { ...none, hipaa: ["164.312(d)"] },
    },
    "IAC-37": {
      domain: "",
      name: "MFA",
      description: "",
      maps: { ...none, hipaa: ["164.312(d)"] },
    },
    "CRY-07": {
      domain: "",
      name: "Encrypting Data At Rest",
      description: "",
      maps: { ...none, hipaa: ["164.312(a)(2)(iv)"] },
    },
    "CHG-03": {
      domain: "",
      name: "Configuration Change Control",
      description: "",
      maps: { ...none, soc2: ["CC8.1"] },
    },
  },
};

proves(
  ["068-compliance FR-001", "068-compliance FR-005"],
  "068: every SCF id a check cites is in Stolos's list of controls",
  () => {
    const ids = new Set(SCF.map((c) => c.id));
    const cited = new Set<string>();
    const o = toObserved({
      os: { family: "macos", version: "15" },
      probe: { at: new Date().toISOString() },
    });
    for (const r of policies(
      {
        name: "m",
        ssh: { user: "u", address: "a" },
        hostKeys: [],
        adopted: "2026-01-01",
        until: "2099-01-01",
      },
      o,
    )) {
      r.scf.forEach((x) => cited.add(x));
    }
    const empty = {
      at: new Date().toISOString(),
      provider: "",
      account: "",
      assets: [],
      posture: {},
      gaps: [],
    };
    for (const c of CONNECTORS) {
      for (const r of c.policies({ ...empty, provider: c.id }, Date.now())) {
        r.scf.forEach((x) => cited.add(x));
      }
    }
    for (const e of [...fleetEvidence(FACTS), ...serverEvidence({ host: "h", https: true })]) {
      e.scf.forEach((x) => cited.add(x));
    }
    for (const x of cited) assert(ids.has(x), `${x} is cited but not in the catalog`);
    for (const c of SCF) assert(/^[A-Z]{3}-\d{2}(\.\d+)?$/.test(c.id), c.id);
    assertEquals(ids.size, SCF.length, "no duplicate ids");
  },
);

proves(
  ["068-compliance FR-002"],
  "068: statuses combine: any fail fails; all pass passes; no evidence is said",
  () => {
    assertEquals(combine([]), "no evidence");
    assertEquals(combine(["pass", "pass"]), "pass");
    assertEquals(combine(["pass", "warn"]), "partial");
    assertEquals(combine(["pass", "fail", "warn"]), "fail");
    assertEquals(combine(["unknown"]), "partial");
  },
);

proves(
  ["068-compliance FR-002"],
  "068: a requirement is met only as far as all its controls have evidence",
  () => {
    const ev: Evidence[] = [
      {
        scf: ["IAC-14"],
        subject: "r",
        source: "repository",
        check: "c",
        status: "pass",
        detail: "",
      },
    ];
    const v = complianceView(ev, CATALOG);
    const hipaa = got(v.frameworks.find((f) => f.id === "hipaa"));
    // 164.312(d) maps to IAC-37 (no evidence) and IAC-14 (pass).
    assertEquals(got(hipaa.requirements.find((r) => r.id === "164.312(d)")).status, "partial");
    assertEquals(
      got(hipaa.requirements.find((r) => r.id === "164.312(a)(2)(iv)")).status,
      "no evidence",
    );
  },
);

proves(
  ["068-compliance FR-002"],
  "068: the fleet's evidence: unapproved commits fail CHG-03; adopted and cloud results carry their SCF",
  () => {
    const v = complianceView(fleetEvidence(FACTS), CATALOG);
    const by = (id: string) => got(v.controls.find((c) => c.control.id === id));
    assertEquals(by("CHG-03").status, "fail");
    assertEquals(by("CRY-07").status, "fail"); // bob-desk's disk
    assert(by("CRY-05").evidence.some((e) => e.source === "cloud"));
    assertEquals(by("CFG-04").status, "fail"); // alpha: apt:ipv4-only
    const soc2 = got(v.frameworks.find((f) => f.id === "soc2"));
    assert(soc2.requirements.some((r) => r.id === "CC8.1" && r.status === "fail"));
  },
);

proves(["068-compliance FR-003"], "068: a server's own evidence", () => {
  const v = complianceView(
    serverEvidence({
      host: "alpha",
      verify: { passed: 142, total: 142, failed: [], at: new Date().toISOString() },
      signer: "alice-daily",
      commit: "a7c1e94",
      https: true,
    }),
  );
  for (const id of ["CFG-04", "MON-02", "CHG-03", "CRY-05", "AST-04"]) {
    assertEquals(got(v.controls.find((c) => c.control.id === id)).status, "pass", id);
  }
  const unsigned = complianceView(serverEvidence({ host: "alpha", https: true }));
  assertEquals(got(unsigned.controls.find((c) => c.control.id === "CHG-03")).status, "fail");
});

/** The value the test expects to be there. */
function got<T>(value: T | undefined | null, what = "a value"): T {
  assertExists(value, `${what} is missing`);
  return value;
}
