/**
 * Spec 080: the fleet's register and vendors, read from the fleet
 * repository (risks.ts, vendors.ts, controls/accepted.ts, adopted machines)
 * and the estate graph, and run as the risk-register pack. `stolos risks`,
 * `stolos vendors`, `stolos compliance`, and the consoles all read it here.
 *
 * ```mermaid
 * flowchart LR
 *   files["risks.ts, vendors.ts, controls/accepted.ts"] --> inputs["fleetRiskInputs"]
 *   estate[("estate graph")] --> discover["discoverVendors"] --> inputs
 *   inputs --> run["runRiskPack"] --> results["PackRun: risk-register/*"]
 * ```
 *
 * @module
 */

import { path, toError } from "@intellectual-frontiers/ifc-ts/runtime";
import type { AdoptedDef } from "../adopt/adopt.ts";
import type { Estate } from "../estate/graph.ts";
import type { PackRun } from "../controls/run.ts";
import { loadRisks, type Risk } from "./register.ts";
import {
  type BilledVendor,
  BILLING_SOURCES,
  discoverVendors,
  loadVendors,
  type Vendor,
  type VendorDef,
} from "./vendors.ts";
import { allAcceptances, runRiskPack } from "./controls.ts";

/** The fleet's register, triage file, accepted risks, and vendors, with what did not load. */
export interface FleetRisk {
  /** The register (undefined: no risks.ts). */
  risks?: Risk[];
  /** The triage file. */
  triage: VendorDef[];
  /** The vendors, discovered and triaged. */
  vendors: Vendor[];
  /** The results of the risk-register pack. */
  run: PackRun;
  /** Why a file did not load. */
  problems: string[];
}

const first = (e: unknown): string => toError(e).message.split("\n")[0] ?? "";

/** Read the fleet's files, discover the vendors in `estate`, and run the pack (the estate is augmented). */
export async function fleetRisk(
  estate: Estate,
  o: { adopted?: ReadonlyArray<{ machine: AdoptedDef }>; now?: Date; dir?: string } = {},
): Promise<FleetRisk> {
  const { P } = await import("../core/paths.ts");
  const { loadAccepted } = await import("../controls/run.ts");
  const dir = o.dir ?? P.fleetDir;
  const problems: string[] = [];
  const risks = await loadRisks(path.join(dir, "risks.ts")).catch((e) => {
    problems.push(`risks.ts: ${first(e)}`);
    return undefined;
  });
  const triage = await loadVendors(path.join(dir, "vendors.ts")).catch((e) => {
    problems.push(`vendors.ts: ${first(e)}`);
    return [] as VendorDef[];
  });
  const accepted = await loadAccepted(path.join(dir, "controls")).catch((e) => {
    problems.push(`controls/accepted.ts: ${first(e)}`);
    return [];
  });
  const now = o.now ?? new Date();
  const billed: Array<BilledVendor & { source: string }> = [];
  for (const b of BILLING_SOURCES) {
    try {
      billed.push(...(await b.vendors(now)).map((x) => ({ ...x, source: b.id })));
    } catch (e) {
      problems.push(`billing ${b.id}: ${first(e)}`);
    }
  }
  const vendors = discoverVendors(estate, { triage, billed });
  const adopted = o.adopted ?? [];
  const run = await runRiskPack({
    estate,
    ...(risks ? { risks } : {}),
    vendors,
    accepted,
    adopted,
    acceptances: allAcceptances(accepted, adopted),
    problems,
    now,
  });
  return { ...(risks ? { risks } : {}), triage, vendors, run, problems };
}
