/**
 * Specs 068 and 071: `stolos compliance [--framework <id>] [--json]`: the
 * fleet's evidence by SCF control and by framework, from what this PC
 * already knows (nothing is asked of a server); `stolos compliance catalog`
 * downloads the SCF Council's and NIST's catalogs (pinned, SHA-256 checked);
 * `stolos compliance export` writes the fleet's OSCAL documents. Spec 073:
 * each control shows its evidence's age, and stale evidence fails (MON-02);
 * `stolos compliance drift` is in `drift.ts`.
 *
 * @module
 */
// Spec: 108-tags FR-016
// Spec: 111-network-posture FR-014

import { errors, fs, path, stdio, toError } from "@intellectual-frontiers/system";
import type { OscalDocuments } from "./oscal.ts";
import { ui } from "../core/ui.ts";
import { catalogCache, loadNist, loadScf, NIST_SOURCES, SCF_SOURCE } from "./catalog.ts";
import { fleetFreshView, formatAge, loadCadences, staleSubjects } from "./freshness.ts";
import { FRAMEWORKS, SCF } from "./scf.ts";

const print = (text: string): void => {
  stdio.stdout.writeSync(`${text}\n`);
};

const CATALOG_HINT = "bun run stolos compliance catalog";

/**
 * Print the fleet's compliance view; exit 1 when a control fails. Spec 108-tags FR-016: with `--tag`, `--any-tag` or `--select`,
 * only the machines those tags choose count (managed, adopted and devices); a cloud account's and the estate's evidence stays.
 */
export async function complianceCommand(
  fw?: string,
  json = false,
  ocsf = false,
  pick: { tag?: unknown; "any-tag"?: unknown; select?: unknown } = {},
): Promise<number> {
  if (fw && !FRAMEWORKS.some((f) => f.id === fw)) {
    ui.phase("Compliance").fail(
      `no framework ${fw}`,
      `one of: ${FRAMEWORKS.map((f) => f.id).join(", ")}`,
    );
    return 1;
  }
  const { pcFacts } = await import("../console/pc.ts");
  const catalog = await loadScf();
  let facts = await pcFacts();
  // Spec 108-tags FR-016: the evidence of the machines the tags choose.
  const { loadFleetTags, selectionFromArgs, chosen, selectionText, scopeFacts } =
    await import("../fleet/tags.ts");
  const ft = await loadFleetTags();
  const sel = selectionFromArgs(pick, ft.set);
  if (sel.error) {
    ui.phase("Compliance").fail(
      sel.error,
      "for example: --tag env:prod, --select 'env:prod and not role:database' (stolos tag list)",
    );
    return 1;
  }
  if (sel.selection) {
    const keep = new Set(chosen(ft.machines, sel.selection).map((m) => m.name));
    if (!keep.size) {
      ui.phase("Compliance").fail(
        `no machine has ${selectionText(sel.selection)}`,
        "stolos tag list shows which machines hold which tags",
      );
      return 1;
    }
    facts = scopeFacts(facts, keep);
    // Spec 111-network-posture FR-014: the network's policies look at the chosen assets and what is connected through them.
    if (facts.networkPosture) {
      const { rescopePosture } = await import("../connect/network-check.ts");
      facts = { ...facts, networkPosture: rescopePosture(facts.networkPosture, keep) };
    }
    ui.phase("Scope").done(
      `${keep.size} machine(s) chosen by ${selectionText(sel.selection)}; cloud accounts and the estate are not machine-scoped and stay`,
    );
  }
  // Spec 073: each piece of evidence held to its source's cadence; stale evidence fails.
  const view = fleetFreshView(facts, catalog, { cadences: await loadCadences() });
  const failing = view.controls.some((c) => c.status === "fail");
  if (ocsf) {
    // Spec 089: one OCSF Compliance Finding per piece of evidence and SCF control, as JSON Lines.
    const { complianceFindings } = await import("../ocsf/finding.ts");
    const { P } = await import("../core/paths.ts");
    const fleet = P.fleetDir.split(/[\\/]/).pop() ?? "";
    const now = new Date();
    const seen = new Set<unknown>();
    for (const c of view.controls) {
      for (const e of c.evidence) {
        if (seen.has(e)) continue;
        seen.add(e);
        for (const f of complianceFindings(e, { now, fleet, ...(catalog ? { catalog } : {}) })) {
          print(JSON.stringify(f));
        }
      }
    }
    return failing ? 1 : 0;
  }
  if (json) {
    print(JSON.stringify(fw ? view.frameworks.find((f) => f.id === fw) : view, null, 2));
    return failing ? 1 : 0;
  }
  const n = (ss: string[], s: string) => ss.filter((x) => x === s).length;
  const line = (ss: string[]) =>
    `${n(ss, "pass")} pass, ${n(ss, "partial")} partial, ${n(ss, "fail")} fail, ${n(
      ss,
      "no evidence",
    )} without evidence`;
  if (!catalog) {
    ui.phase("Frameworks").warn(
      "the SCF catalog is not on this PC, so there are no framework mappings",
      CATALOG_HINT,
    );
  }
  for (const f of catalog ? view.frameworks.filter((x) => !fw || x.id === fw) : []) {
    const p = ui.phase(f.short);
    if (fw) {
      const { table } = await import("../state/query.ts");
      print(
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
  {
    // Spec 073: each control's evidence age (newest, oldest), and the stale evidence.
    const { table } = await import("../state/query.ts");
    const age = (ms?: number) => (ms === undefined ? "" : formatAge(ms));
    const rows = view.controls
      .filter((c) => c.evidence.length)
      .map((c) => ({
        control: c.control.id,
        status: c.status,
        evidence: c.evidence.length,
        newest: age(c.freshness.newestAgeMs),
        oldest: age(c.freshness.oldestAgeMs),
        stale: c.freshness.stale || "",
      }));
    if (rows.length) print(table(rows) + "\n");
    const fp = ui.phase("Freshness");
    const stale = staleSubjects(view);
    for (const s of stale) {
      fp.warn(
        `${s.subject} (${s.source}): observed ${formatAge(
          s.ageMs,
        )} ago, stale after ${s.staleAfter}; ${s.checks} check(s) fail (MON-02)`,
        s.fix ?? "",
      );
    }
    const c = view.cadences.sources;
    fp.done(
      `${
        stale.length ? `${stale.length} stale source(s)` : "no stale evidence"
      }; cadences: managed ${c.managed.every} (stale after ${c.managed.staleAfter}), adopted ${c.adopted.every} (${c.adopted.staleAfter}), devices ${c.device.every} (${c.device.staleAfter}), accounts ${c.cloud.every} (${c.cloud.staleAfter})`,
    );
  }
  const s = ui.phase("SCF controls");
  for (const c of view.controls.filter((x) => x.status === "fail")) {
    // Stale evidence is listed once per source under Freshness.
    for (const e of c.evidence.filter((x) => x.status === "fail" && !x.stale)) {
      s.warn(`${c.control.id} ${e.subject}: ${e.check} (${e.detail})`, e.fix ?? "");
    }
  }
  s.done(line(view.controls.map((c) => c.status)));
  if (catalog) {
    ui.next.push(
      `names and mappings: ${SCF_SOURCE.title} ${catalog.version} (the SCF Council's STRM)`,
    );
  }
  ui.next.push("OSCAL (SSP, assessment results, POA&M): bun run stolos compliance export");
  ui.next.push("the same, with every piece of evidence: bun run stolos console (Compliance)");
  return failing ? 1 : 0;
}

/** Download, check, read, and cache the catalogs (again with `update`). */
export async function catalogCommand(
  update = false,
  o: { cacheDir?: string; get?: (url: string) => Promise<Uint8Array> } = {},
): Promise<number> {
  const dir = o.cacheDir ?? catalogCache();
  if (update) {
    await fs.remove(dir, { recursive: true }).catch((e: unknown) => {
      if (!(e instanceof errors.NotFound)) throw e;
    });
  }
  const p = ui.phase("Catalogs");
  try {
    const loaded = await loadScf({
      cacheDir: dir,
      download: true,
      ...(o.get ? { get: o.get } : {}),
    });
    const controls = loaded?.controls ?? {};
    const missing = SCF.filter((c) => !controls[c.id]).map((c) => c.id);
    p.ok(`${SCF_SOURCE.title} ${SCF_SOURCE.version}: ${Object.keys(controls).length} controls`);
    if (missing.length) {
      p.warn(
        `not in SCF ${SCF_SOURCE.version}: ${missing.join(", ")}`,
        "report it: a bug in Stolos",
      );
    }
    for (const id of ["nist80053", "nist800171"] as const) {
      const n = await loadNist(id, {
        cacheDir: dir,
        download: true,
        ...(o.get ? { get: o.get } : {}),
      });
      p.ok(`${NIST_SOURCES[id].title}: ${Object.keys(n?.titles ?? {}).length} controls`);
    }
  } catch (e) {
    p.fail(toError(e).message, "check this PC can reach raw.githubusercontent.com, then again");
    return 1;
  }
  p.done(`cached in ${dir}`);
  ui.next.push("bun run stolos compliance");
  return 0;
}

/** The fleet's OSCAL documents by file name, or why they cannot be made (and the fix). */
export type OscalResult =
  | { ok: true; docs: OscalDocuments; fleet: { id: string; title: string }; scf: string }
  | { ok: false; error: string; fix: string };

/**
 * Build the fleet's four OSCAL documents from what this PC knows (spec 071).
 * `stolos compliance export` writes them; spec 092's export jobs deliver them.
 */
export async function oscalDocuments(now: Date = new Date()): Promise<OscalResult> {
  const catalog = await loadScf();
  if (!catalog) {
    return {
      ok: false,
      error: "the SCF catalog is not on this PC (OSCAL reaches NIST through it)",
      fix: CATALOG_HINT,
    };
  }
  const { pcFacts } = await import("../console/pc.ts");
  const { oscalExports } = await import("./oscal.ts");
  const { VERSION } = await import("../version.ts");
  const f = await pcFacts();
  if (!f.fleet.id) {
    return { ok: false, error: "no fleet chosen", fix: "bun run stolos fleet use <id>" };
  }
  const nist = await loadNist("nist80053");
  // Spec 080: the risk register's open risks go in the POA&M (a register that does not load is left out).
  const { loadRisks } = await import("../risk/register.ts");
  const register = await loadRisks().catch(() => undefined);
  // Spec 088: the scanners' open vulnerabilities go in the POA&M too.
  const { loadObservations } = await import("../connect/commands.ts");
  const { openVulnerabilities } = await import("../connect/vulnerability.ts");
  const vulnerabilities = openVulnerabilities(await loadObservations().catch(() => []));
  const docs = await oscalExports({
    ...(register ? { register } : {}),
    ...(vulnerabilities.length ? { vulnerabilities } : {}),
    view: fleetFreshView(f, catalog, { cadences: await loadCadences() }),
    fleet: f.fleet,
    machines: f.machines.filter((m) => m.kind !== "discovered"),
    ...(nist ? { titles: nist.titles } : {}),
    version: VERSION,
    now,
  });
  return { ok: true, docs, fleet: f.fleet, scf: catalog.version };
}

/** Write the fleet's OSCAL documents (component definition, SSP, assessment results, POA&M). */
export async function exportCommand(out?: string): Promise<number> {
  const p = ui.phase("OSCAL");
  const r = await oscalDocuments();
  if (!r.ok) {
    p.fail(r.error, r.fix);
    return 1;
  }
  const { P } = await import("../core/paths.ts");
  const dir = out ?? path.join(P.state, "oscal", r.fleet.id);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, doc] of Object.entries(r.docs)) {
    await fs.writeTextFile(path.join(dir, name), JSON.stringify(doc, null, 2) + "\n");
    p.ok(path.join(dir, name));
  }
  p.done(`OSCAL documents for ${r.fleet.title}, to NIST SP 800-53 Rev 5 through SCF ${r.scf}`);
  ui.next.push(
    "to deliver them on a schedule (the collector, a file, or encrypted email): a job in estate.exports, then stolos export schedule <job>",
  );
  ui.next.push(
    "fill in what Stolos cannot know (the system's categorization, the controls it cannot observe) before you submit the SSP",
  );
  return 0;
}
