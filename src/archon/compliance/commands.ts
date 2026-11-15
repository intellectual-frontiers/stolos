/**
 * Spec 068: `stolos compliance [--framework hipaa|pci|cmmc|soc2] [--json]`:
 * the fleet's evidence by SCF control and by framework, from what this PC
 * already knows (nothing is asked of a server).
 *
 * @module
 */

import { ui } from "../core/ui.ts";
import { complianceView, fleetEvidence } from "./report.ts";
import { FRAMEWORKS } from "./scf.ts";

/** Print the fleet's compliance view; exit 1 when a control fails. */
export async function complianceCommand(fw?: string, json = false): Promise<number> {
  if (fw && !FRAMEWORKS.some((f) => f.id === fw)) {
    ui.phase("Compliance").fail(
      `no framework ${fw}`,
      `one of: ${FRAMEWORKS.map((f) => f.id).join(", ")}`,
    );
    return 1;
  }
  const { pcFacts } = await import("../console/pc.ts");
  const view = complianceView(fleetEvidence(await pcFacts()));
  const failing = view.controls.some((c) => c.status === "fail");
  if (json) {
    console.log(JSON.stringify(fw ? view.frameworks.find((f) => f.id === fw) : view, null, 2));
    return failing ? 1 : 0;
  }
  const n = (ss: string[], s: string) => ss.filter((x) => x === s).length;
  const line = (ss: string[]) =>
    `${n(ss, "pass")} pass, ${n(ss, "partial")} partial, ${n(ss, "fail")} fail, ${
      n(ss, "no evidence")
    } without evidence`;
  for (const f of view.frameworks.filter((x) => !fw || x.id === fw)) {
    const p = ui.phase(f.short);
    if (fw) {
      const { table } = await import("../state/query.ts");
      console.log(
        table(
          f.requirements.map((r) => ({
            requirement: r.id,
            status: r.status,
            scf: r.controls.join(", "),
          })),
        ) + "\n",
      );
    }
    p.done(`${f.requirements.length} requirement(s): ${line(f.requirements.map((r) => r.status))}`);
  }
  const s = ui.phase("SCF controls");
  for (const c of view.controls.filter((x) => x.status === "fail")) {
    for (const e of c.evidence.filter((x) => x.status === "fail")) {
      s.warn(`${c.control.id} ${e.subject}: ${e.check} (${e.detail})`, e.fix ?? "");
    }
  }
  s.done(line(view.controls.map((c) => c.status)));
  ui.next.push(
    "a starter mapping: check it against the SCF's own mappings (STRM) before an auditor relies on it",
  );
  ui.next.push("the same, with every piece of evidence: deno task stolos console (Compliance)");
  return failing ? 1 : 0;
}
