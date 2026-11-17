# 116: Terms kept unaligned carry a typed decision

Issue intellectual-frontiers/stolos#37. A small change to the audit of spec 104-mizan (FR-003), which is not edited.

## Why

`ontology/stolos/audit.ts` records, for every class and property of the vocabulary, the standard it rests on or that none is adopted. For 52 terms the record is `unaligned`
with "Decision pending" (commons 0018-standards-first FR-005), and `bun run check:mizan` holds 52 `mizan/decision-missing` findings in `tools/mizan.baseline.txt`; each becomes
a failure 90 days after the audit (2027-02-15). The owner has decided, through the Mizan session and in issue #37 (2026-11-17), to keep those terms unaligned, as commons did for
its own twelve (`keptUnalignedDecision` of commons' `mz:` ontology). This spec records that decision as data, one typed individual per term, and nothing else changes: no
term is added, defined again or mapped.

## Ontology

No term of `stolos:` is new. The decision is commons' `mz:Decision` (with `mz:decisionOf`, `mz:decidedOn`, `mz:record`), pointed to by the audit record's `mz:decision`; Stolos' own
`stolos:Decision` (what a person decided about a fleet) is a different term and is not used.

## Requirements

Requirement words follow RFC 2119 as RFC 8174 clarifies it: they are requirements only where written in capitals.

**Standards considered.** Commons 0018-standards-first (a term with no standard adopted MUST carry a decision, FR-005, and the audit examined each candidate); W3C PROV-O (who
decided what and when: an activity, its agent and its time, which commons' `mz:Decision` with `decidedOn` and `record` states for a term); RFC 2119 and RFC 8174 (requirement
words); commons' `keptUnalignedDecision` (the shape followed here, since it accepts only commons' own ontologies). On the candidates of the 52 pending terms examined again (law,
NIST, ISO, schema.org, OCSF, D3FEND, IANA, SKOS, PROV-O), none was found to fit one standard term with a relation that can be defended, so none is mapped.

- **FR-001** Every term of Stolos' vocabulary whose audit record is `unaligned` MUST have a typed `mz:Decision` individual and a mapping MUST NOT also be recorded for it; a term
  that is mapped MUST NOT have a decision.
- **FR-002** The decision of a term MUST be the individual `mzid:decision-stolos-<local>` of class `mz:Decision`, with `mz:decisionOf` the term's record `mzid:term-stolos-<local>`,
  `mz:decidedOn` "2026-11-17" and `mz:record` exactly "owner decision of 2026-11-17 in stolos issue #37: keep the term unaligned; reviewed again by 2027-02-15"; the audit record
  MUST point to it with `mz:decision`.
- **FR-003** The justification of such a record MUST say "Kept unaligned by the owner's decision of 2026-11-17" and MUST NOT say "Decision pending".
- **FR-004** The decisions and the audit records MUST be individuals of the ontology's files, so that they reach `ontology/stolos.auto.ttl`, and `bun run check:ontology` MUST pass.
- **FR-005** `tools/mizan.baseline.txt` MUST NOT grow: it MUST lose the `mizan/decision-missing` line of every term decided and gain no line, and `bun run check:mizan` MUST find
  no `mizan/decision-missing` for a term of the audit.

## Success criteria

- The baseline has 52 lines fewer and none more; `bun run ci` passes.
- The terms are looked at again by 2027-02-15; after that day a new decision or a mapping replaces each (a later spec).
