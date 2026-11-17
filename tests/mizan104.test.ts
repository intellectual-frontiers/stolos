/**
 * Spec 104: Stolos' ladder as instances of commons' `mz:Rung`, the audit of the basis of every term of its vocabulary, and commons' Mizan rules held against a baseline that
 * only shrinks. The check runs as the program it is, on the runtime this test runs on.
 *
 * @module
 */
import { Rung } from "@intellectual-frontiers/commons/ontology/mizan";
import { path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { rungs } from "../ontology/stolos/architecture.ts";
import { terms } from "../ontology/stolos/audit.ts";
import { stolos } from "../ontology/stolos/vocabulary.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

const TOOL = path.join(ENGINE_ROOT, "tools", "mizan.ts");

proves(
  ["104-mizan FR-002"],
  "104: the eight rungs are individuals of commons' mz:Rung, required, each relying only on lower rungs",
  () => {
    assertEquals(rungs.length, 8);
    assertEquals(
      rungs.map((r) => r.values.rungNumber),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    assert(rungs.every((r) => r.values.kind.iri.endsWith("#Required")));
    assert(
      rungs.every((r) => r.class.iri === Rung.class.iri),
      "every rung is an individual of mz:Rung",
    );
    const number = new Map(rungs.map((r) => [r.iri, r.values.rungNumber]));
    for (const r of rungs)
      for (const lower of r.values.mayRelyOn ?? [])
        assert((number.get(lower.iri) ?? 99) < r.values.rungNumber);
    assert(!("Rung" in stolos), "stolos:Rung is not defined: the class is commons'");
  },
);

proves(
  ["104-mizan FR-003"],
  "104: every class and property of the vocabulary has a record of its basis, and an unaligned one names its candidates and the audit day",
  () => {
    assertEquals(
      terms.map((t) => t.values.termIri).sort(),
      Object.values(stolos)
        .map((t) => t.iri)
        .sort(),
    );
    for (const t of terms) {
      if (t.values.justification !== undefined) {
        assertStringIncludes(t.values.justification, "Candidates to examine");
        assertEquals(t.values.addedOn, "2026-11-17");
      } else assert((t.values.standardTerm ?? "") !== "");
    }
  },
);

async function check(...args: string[]): Promise<{ code: number; stderr: string }> {
  // on Node the commons' loader hook is registered first, as `ifc` does: Node refuses to strip types of a file under node_modules without it
  const runtime = proc.execPath();
  const hook = /(^|[\\/])node(\.exe)?$/.test(runtime)
    ? [
        "--import",
        `${ENGINE_ROOT}/node_modules/@intellectual-frontiers/commons/commons/ts/node/register.mjs`,
      ]
    : [];
  const o = await proc.run([runtime, ...hook, TOOL, ...args], { cwd: ENGINE_ROOT });
  return { code: o.code, stderr: o.stderr };
}

proves(
  ["104-mizan FR-004", "104-mizan FR-005"],
  "104: check:mizan passes with its baseline, holds no missing decision (every unaligned term is decided, spec 116)",
  async () => {
    const now = await check("--today", "2026-11-18");
    assertEquals(now.code, 0, now.stderr);
    assertStringIncludes(now.stderr, "passed");
    const within = await check("--today", "2027-02-15");
    assertEquals(within.code, 0, within.stderr);
    // Spec 116: every unaligned term now carries a decision, so no day makes one overdue.
    const late = await check("--today", "2027-02-16");
    assertEquals(late.code, 0, late.stderr);
  },
);
