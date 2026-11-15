/**
 * Spec 095-proposals (Article 25): what operators decided about a host's
 * proposals lives in Git, in `fleets/<fleet>/hosts/<host>/proposals.ts`,
 * written by `stolos proposal accept` and `reject` and approved by a signed
 * push. The host reads it after it pulls: a decided proposal ends its holds,
 * a rejected one leaves its unmanaged items flagged, and accepted local drift
 * stays quiet until its date. It is read as a literal, never run.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { readTextOr } from "../core/fsx.ts";
import { exportedLiteral, tsLiteral } from "../core/ts-literal.ts";
import type { ProposalDecisions } from "./types.ts";

/** fleets/<fleet>/hosts/<host>/proposals.ts. */
export function proposalsFile(host: string): string {
  return join(P.hosts, host, "proposals.ts");
}

/** The fixed form of proposals.ts: sorted by id, written by {@link tsLiteral}. */
export function decisionsSource(d: ProposalDecisions): string {
  const sorted = Object.fromEntries(Object.entries(d).sort(([a], [b]) => a.localeCompare(b)));
  return `// Written by stolos proposal accept and reject (spec 095): what operators decided about
// this host's proposals. Change it with those commands, in a signed commit.
import type { ProposalDecisions } from "@stolos/archon/proposal/types.ts";

export const proposals: ProposalDecisions = ${tsLiteral(sorted)};
`;
}

/** A host's decisions (none: empty). */
export async function loadProposalDecisions(
  host: string,
  file: string = proposalsFile(host),
): Promise<ProposalDecisions> {
  const text = await readTextOr(file);
  if (text === undefined) return {};
  return exportedLiteral(text, "proposals") as ProposalDecisions;
}
