# Implementation Plan: Mizan, the IF Spec Profile

**Branch**: `104-mizan` (on branch `mizan-v0.1.0`) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

## Summary

Pin commons at a commit with Mizan; state the ladder with commons' `mz:Rung`; record the basis of every term; run commons'
`holdHarness` as `bun run check:mizan` with a baseline that only shrinks.

## Standards considered

- The ladder: no standard names it (commons `0016-ladder` justifies it as `unaligned`), so Stolos takes commons' class.
- The basis of a term: commons' `mz:OntologyTerm`, which maps to W3C SKOS and SSSOM mapping relations (`maps`, `specializes`).
- Candidate standards for Stolos' own terms are named in `ontology/stolos/audit.ts`: OCSF, NIST SP 800-53 (CM-8), W3C PROV-O,
  OpenTelemetry severity, IANA service names, FIPS 199.

## Technical context

TypeScript 7 on Bun, Node 26 as the backup; commons by Git at a pinned commit; no new dependency.

## Constitution check

Article 0 (the ladder) is kept: its table is still generated from the rungs. Article 26 (generated files are `.auto.`) is kept.
