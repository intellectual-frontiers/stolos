# 104: Mizan, the IF Spec Profile

**Feature Branch**: `104-mizan` (on branch `mizan-v0.1.0`) **Created**: 2026-11-17

**Status**: Draft

**Input**: Move Stolos onto commons' shared version of what it already does: the ladder as instances of
commons' `mz:Rung`, an audit of the basis of every term of its ontology, and commons' Mizan rules run on its
own specifications with a baseline that only shrinks. The plan, its tasks and what Stolos teaches commons are in
https://github.com/intellectual-frontiers/.github/issues/10 and the ticket of this repository,
https://github.com/intellectual-frontiers/stolos/issues/37.

## Why

Stolos kept its own copy of the ladder's class and properties, and nothing said which standard each of its terms
rests on. Commons now states the ladder once (`0016-ladder`) and records the basis of a term (`0018-standards-first`).
Stolos is the first harness to adopt both, so that what it learns changes commons before `erga` follows.

## Ontology

The terms this spec uses, each defined before it is used here: commons' `mz:Rung`, `mz:OntologyTerm` and `mz:Basis`
(commons `ontology/mizan/`), and `stolos:rung-0` to `stolos:rung-7`, the individuals that state the ladder.

## Requirements

- **FR-001** The `@intellectual-frontiers/commons` pin MUST be a commit of commons' `main` that holds Mizan, and
  `bun run check`, `bun run check:ontology`, `bun run check:trace` and `bun run check:layers` MUST pass on it.
- **FR-002** The eight rungs MUST be individuals of commons' `mz:Rung` (`ontology/stolos/architecture.ts`), stated with
  commons' `Rung` schema (a number, a purpose, `required`, homes, the rungs each may rely on, what proves it and the
  specification it comes from), and Stolos MUST NOT define a Rung class or the rung properties of its own: the constitution's table and
  `AGENTS.md`'s layout stay generated from the rungs.
- **FR-003** Every class and property of Stolos' vocabulary MUST have an `mz:OntologyTerm` record of its basis
  (`ontology/stolos/audit.ts`): `adopts`, `specializes`, `maps` (with the standard's term and the relation) or
  `unaligned` (with the candidates examined and the day of the audit, from which its decision is due in 90 days).
- **FR-004** `bun run check:mizan` MUST run commons' Mizan rules (`holdHarness`) on `specs/` and the audit, and hold
  the findings against `tools/mizan.baseline.txt`, which only shrinks: a new finding fails, and so does a baseline
  line that no longer occurs.
- **FR-005** A class or a property with no record in the audit, and an `unaligned` term whose decision is more than 90 days
  past the audit, MUST fail `bun run check:mizan` whatever the baseline holds.
- **FR-006** `bun run ci` MUST run `bun run check:mizan`.

## Out of scope

- Moving the status words to commons' (Draft, Active, Deferred, Superseded) and `reviewed.tsv` to commons' one proof
  register: the checks that would use them are not run on Stolos yet.
- Rewriting the 741 requirements that have no RFC 2119 keyword and the 159 scenarios that cite no requirement: they are held by
  the baseline and shrink as specifications are touched.
- Expressing the FedRAMP and OCSF generators as commons integration manifests: they generate typed data from pinned JSON, which
  commons' importers do not yet do.

## Edge cases

- A class added to the vocabulary with no record in the audit: `bun run check:mizan` fails, per FR-005.
- An `unaligned` term 91 days after the audit with no decision: fails whatever the baseline holds, per FR-005.
- A requirement fixed so that it has a keyword: its baseline line is stale and the check fails until the line is deleted, per FR-004.

## Assumptions

- Commons' check is the arbiter of the rules; Stolos holds findings and does not change the rules.

## Open questions

- **OQ-1**: Whether commons' scenario rule should require a cited requirement (Spec Kit's own scenarios do not), or only a story-level one.

## Key entities

- **Audit** - one `mz:OntologyTerm` for each class and property of the vocabulary.
- **Baseline** - `tools/mizan.baseline.txt`, the findings held, which only shrinks.

## Success criteria

- **SC-001**: `bun run check:mizan` passes with the baseline, and a term with no record fails it.
