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

import {
  array,
  type Decoder,
  exportedLiteral,
  formatDecodeError,
  literal,
  mapDecoder,
  object,
  record,
  string,
  tsLiteral,
} from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { P } from "../core/paths.ts";
import type { ProposalDecision, ProposalDecisions } from "./types.ts";

/** One decision as proposals.ts holds it. */
const proposalDecision: Decoder<ProposalDecision> = mapDecoder(
  object(
    { decision: literal("accepted", "rejected"), by: string, at: string },
    {
      reason: string,
      spec: string,
      adopted: array(string),
      local: array(object({ key: string, until: string })),
      skipped: array(string),
    },
  ),
  (d): ProposalDecision => ({
    decision: d.decision,
    by: d.by,
    at: d.at,
    ...(d.reason === undefined ? {} : { reason: d.reason }),
    ...(d.spec === undefined ? {} : { spec: d.spec }),
    ...(d.adopted === undefined ? {} : { adopted: [...d.adopted] }),
    ...(d.local === undefined ? {} : { local: d.local.map((l) => ({ ...l })) }),
    ...(d.skipped === undefined ? {} : { skipped: [...d.skipped] }),
  }),
);

/** proposals.ts's `proposals`. */
export const proposalDecisions: Decoder<ProposalDecisions> = mapDecoder(
  record(proposalDecision),
  (r) => ({ ...r }),
);

/** fleets/<fleet>/hosts/<host>/proposals.ts. */
export function proposalsFile(host: string): string {
  return path.join(P.hosts, host, "proposals.ts");
}

/** The fixed form of proposals.ts: sorted by id, written by {@link tsLiteral}. */
export function decisionsSource(d: ProposalDecisions): string {
  const sorted = Object.fromEntries(Object.entries(d).sort(([a], [b]) => a.localeCompare(b)));
  return `// Written by stolos proposal accept and reject (spec 095): what operators decided about
// this host's proposals. Change it with those commands, in a signed commit.
import type { ProposalDecisions } from "@intellectual-frontiers/stolos/archon/proposal/types";

export const proposals: ProposalDecisions = ${tsLiteral(sorted)};
`;
}

/** A host's decisions (none: empty). */
export async function loadProposalDecisions(
  host: string,
  file: string = proposalsFile(host),
): Promise<ProposalDecisions> {
  const text = await fs.readTextOr(file);
  if (text === undefined) return {};
  const v = exportedLiteral(text, "proposals");
  if (v.kind === "err") {
    throw new Error(`${file}: not a literal at ${v.error.at}: expected ${v.error.expected}`);
  }
  const d = proposalDecisions(v.value, "proposals");
  if (d.kind === "err") throw new Error(`${file}: ${formatDecodeError(d.error)}`);
  return d.value;
}
