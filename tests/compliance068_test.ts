// Spec 068: SCF controls from evidence, and frameworks from controls.
import { assert, assertEquals } from "./assert.ts";
import { FRAMEWORKS, SCF } from "../src/archon/compliance/scf.ts";
import {
  combine,
  complianceView,
  type Evidence,
  fleetEvidence,
  serverEvidence,
} from "../src/archon/compliance/report.ts";
import { policies } from "../src/archon/adopt/policy.ts";
import { toObserved } from "../src/archon/adopt/adopt.ts";
import { CLOUDS } from "../src/archon/cloud/commands.ts";
import { FACTS } from "./console/serve-stolos.ts";

Deno.test("068: every SCF id a check cites is in the catalog, and each maps somewhere", () => {
  const ids = new Set(SCF.map((c) => c.id));
  const cited = new Set<string>();
  const o = toObserved({
    os: { family: "macos", version: "15" },
    probe: { at: new Date().toISOString() },
  });
  for (
    const r of policies({
      name: "m",
      ssh: { user: "u", address: "a" },
      hostKeys: [],
      adopted: "2026-01-01",
      until: "2099-01-01",
    }, o)
  ) {
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
  for (const c of CLOUDS) {
    for (const r of c.policies({ ...empty, provider: c.id }, Date.now())) {
      r.scf.forEach((x) => cited.add(x));
    }
  }
  for (const e of [...fleetEvidence(FACTS), ...serverEvidence({ host: "h", https: true })]) {
    e.scf.forEach((x) => cited.add(x));
  }
  for (const x of cited) assert(ids.has(x), `${x} is cited but not in the catalog`);
  for (const c of SCF) {
    assert(/^[A-Z]{3}-\d{2}$/.test(c.id), c.id);
    assert(FRAMEWORKS.some((f) => c.maps[f.id].length), `${c.id} maps to no framework`);
  }
  assertEquals(ids.size, SCF.length, "no duplicate ids");
});

Deno.test("068: statuses combine: any fail fails; all pass passes; no evidence is said", () => {
  assertEquals(combine([]), "no evidence");
  assertEquals(combine(["pass", "pass"]), "pass");
  assertEquals(combine(["pass", "warn"]), "partial");
  assertEquals(combine(["pass", "fail", "warn"]), "fail");
  assertEquals(combine(["unknown"]), "partial");
});

Deno.test("068: a requirement is met only as far as all its controls have evidence", () => {
  const ev: Evidence[] = [{
    scf: ["IAC-10"],
    subject: "r",
    source: "repository",
    check: "c",
    status: "pass",
    detail: "",
  }];
  const v = complianceView(ev);
  const hipaa = v.frameworks.find((f) => f.id === "hipaa")!;
  // 164.312(d) maps to IAC-06 (no evidence) and IAC-10 (pass).
  assertEquals(hipaa.requirements.find((r) => r.id === "164.312(d)")!.status, "partial");
  assertEquals(hipaa.requirements.find((r) => r.id === "164.312(a)(2)(iv)")!.status, "no evidence");
});

Deno.test("068: the fleet's evidence: unapproved commits fail CHG-02; adopted and cloud results carry their SCF", () => {
  const v = complianceView(fleetEvidence(FACTS));
  const by = (id: string) => v.controls.find((c) => c.control.id === id)!;
  assertEquals(by("CHG-02").status, "fail");
  assertEquals(by("CRY-05").status, "fail"); // bob-desk's disk
  assert(by("CRY-03").evidence.some((e) => e.source === "cloud"));
  assertEquals(by("CFG-02").status, "fail"); // alpha: apt:ipv4-only
  const soc2 = v.frameworks.find((f) => f.id === "soc2")!;
  assert(soc2.requirements.some((r) => r.id === "CC8.1" && r.status === "fail"));
});

Deno.test("068: a server's own evidence", () => {
  const v = complianceView(serverEvidence({
    host: "alpha",
    verify: { passed: 142, total: 142, failed: [], at: new Date().toISOString() },
    signer: "alice-daily",
    commit: "a7c1e94",
    https: true,
  }));
  for (const id of ["CFG-02", "MON-01", "CHG-02", "CRY-03", "AST-02"]) {
    assertEquals(v.controls.find((c) => c.control.id === id)!.status, "pass", id);
  }
  const unsigned = complianceView(serverEvidence({ host: "alpha", https: true }));
  assertEquals(unsigned.controls.find((c) => c.control.id === "CHG-02")!.status, "fail");
});
