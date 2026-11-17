/**
 * Spec 116-kept-unaligned: every Stolos term kept unaligned carries a typed `mz:Decision` (the owner's decision of 2026-11-17), in the audit and in the generated Turtle, and the
 * Mizan baseline holds no missing decision for any of them. The tool runs as the program it is, on the runtime this test runs on.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import {
  decisions,
  keptUnalignedDecision,
  keptUnalignedDecisionId,
  KEPT_UNALIGNED_SENTENCE,
  terms,
} from "../ontology/stolos/audit.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

const RECORD =
  "owner decision of 2026-11-17 in stolos issue #37: keep the term unaligned; reviewed again by 2027-02-15";
const unaligned = terms.filter((t) => t.values.basis.iri.endsWith("Unaligned"));
const local = (t: (typeof terms)[number]) => t.iri.slice(t.iri.lastIndexOf("term-stolos-") + 12);

proves(
  ["116-kept-unaligned FR-001", "116-kept-unaligned FR-002", "116-kept-unaligned FR-003"],
  "116: every unaligned term has a decision of its own, none is both mapped and decided, and the record and id are the owner's",
  () => {
    assert(unaligned.length > 0);
    assertEquals(decisions.length, unaligned.length);
    for (const t of terms) {
      const decided = t.values.decision !== undefined;
      assertEquals(decided, t.values.basis.iri.endsWith("Unaligned"), t.iri);
      if (t.values.standardTerm !== undefined) assert(!decided, `${t.iri} is mapped and decided`);
    }
    const byId = new Map(decisions.map((d) => [d.iri, d]));
    for (const t of unaligned) {
      const name = local(t);
      const id = keptUnalignedDecisionId(name);
      assert(id.iri.endsWith(`decision-stolos-${name}`));
      assertEquals(t.values.decision?.iri, id.iri);
      const d = byId.get(id.iri);
      assert(d !== undefined, `${name} has no decision`);
      assertEquals(d.values.decisionOf.iri, t.iri);
      assertEquals(d.values.decidedOn, "2026-11-17");
      assertEquals(d.values.record, RECORD);
      assertEquals(keptUnalignedDecision(name).values.record, RECORD);
      const j = t.values.justification ?? "";
      assertStringIncludes(j, "Kept unaligned by the owner's decision of 2026-11-17");
      assertStringIncludes(j, KEPT_UNALIGNED_SENTENCE);
      assert(!j.includes("Decision pending"), `${name} still pending`);
    }
  },
);

proves(
  ["116-kept-unaligned FR-004"],
  "116: the decisions and the pointers are in the generated Turtle, which is fresh",
  async () => {
    const ttl = await fs.readTextFile(path.join(ENGINE_ROOT, "ontology", "stolos.auto.ttl"));
    for (const t of unaligned) {
      const name = local(t);
      assertStringIncludes(ttl, `mzid:decision-stolos-${name} a mz:Decision`);
      assertStringIncludes(ttl, `mz:decision mzid:decision-stolos-${name} ;`);
    }
    assertStringIncludes(ttl, `mz:record "${RECORD}"`);
  },
);

proves(
  ["116-kept-unaligned FR-005"],
  "116: the baseline holds no missing decision and the Mizan tool finds none, on the runtime of this test",
  async () => {
    const base = await fs.readTextFile(path.join(ENGINE_ROOT, "tools", "mizan.baseline.txt"));
    assert(!base.includes("mizan/decision-missing"));
    const runtime = proc.execPath();
    const hook = /(^|[\\/])node(\.exe)?$/.test(runtime)
      ? [
          "--import",
          `${ENGINE_ROOT}/node_modules/@intellectual-frontiers/commons/commons/ts/node/register.mjs`,
        ]
      : [];
    const o = await proc.run(
      [runtime, ...hook, path.join(ENGINE_ROOT, "tools", "mizan.ts"), "--today", "2027-02-16"],
      { cwd: ENGINE_ROOT },
    );
    assertEquals(o.code, 0, o.stderr);
    assert(!o.stderr.includes("decision-missing") && !o.stderr.includes("decision-overdue"));
  },
  { timeout: 180_000 },
);
