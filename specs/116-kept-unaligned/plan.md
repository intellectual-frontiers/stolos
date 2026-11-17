# Implementation Plan: Terms kept unaligned carry a typed decision

**Branch**: `116-kept-unaligned` (committed directly to main) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

## Summary

`ontology/stolos/audit.ts` gains a small helper with the shape of commons' `keptUnalignedDecision` (`keptUnalignedDecision`, `keptUnalignedDecisionId`, the sentence and the two
days), writes one `mz:Decision` for each unaligned term, and points the record's `decision` at it. The audit's file joins the ontology's files so that the decisions reach the
generated Turtle. The baseline is rewritten and only loses lines.

## Technical Context

**Language/Version**: TypeScript 7 on Bun, Node 26 as the backup. **Dependencies**: commons' `mz:Decision` schema only. **Testing**: `tests/decisions116.test.ts` through `bun run test`.

## Constitution Check

- Article 0: rung 0 (the ontology, `ontology/stolos/{audit,mod}.ts`), rung 1 (this spec), rung 6 (`tools/mizan.baseline.txt`), rung 7 (the test). No new term.
- Article 4: the decisions are TypeScript values, never hand-written Turtle.

## Project Structure

```text
specs/116-kept-unaligned/  spec.md plan.md tasks.md reviewed.tsv
rung 0: ontology/stolos/audit.ts (helper, decisions), ontology/stolos/mod.ts (the audit file joins the files), ontology/stolos.auto.ttl (generated)
rung 6: tools/mizan.baseline.txt (52 lines fewer)
rung 7: tests/decisions116.test.ts, tests/mizan104.test.ts (the overdue case now uses a term with no decision)
```

## Design notes

- Commons' helper takes `"mz" | "ifccm" | "ifqs" | "ifws"` only, so Stolos writes the same shape with its own id prefix `decision-stolos-`.
- The id is derived from the term, so a later mapping removes the decision by one filter (`MAPPED`).

## Standards considered

The same ones as the specification: commons 0018-standards-first, W3C PROV-O for who decided what and when, RFC 2119 and RFC 8174. No term is defined, so no mapping is added.
