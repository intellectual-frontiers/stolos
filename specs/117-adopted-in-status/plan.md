# Implementation Plan: Every machine the fleet knows is in `fleet status`, and "no evidence" is not a failure

**Branch**: `117-adopted-in-status` (committed directly to main) | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

## Summary

A new module `src/archon/observe/fleet-machines.ts` (rung 5) reads what the fleet knows beyond its managed hosts (`loadAdopted`, `loadDevices`, the network assets and the
router's observation) and turns each machine into one line and its detail lines; `fleet-status.ts` prints them after the managed servers. A small pure module
`src/archon/compliance/not-observed.ts` decides when a control change is "no evidence" and says its fix; `compliance/impact.ts` (`printImpact`, the PR comment) and
`compliance/drift.ts` (the command, the mailed text) use it, and `adopt/commands.ts` `report` (host check, device check, adopt, observe) prints a machine never observed, or a
policy that could not tell, as one waiting item. `core/explain.ts` gains `P117-NO-EVIDENCE`.

## Technical Context

**Language/Version**: TypeScript 7 on Bun, Node 26 as the backup. **Dependencies**: none new. **Testing**: `tests/status117.test.ts` through `bun run test`, with a sandbox
fleet (`tests/lab-fleet.ts`, `tests/sandbox.ts`) for the real `stolos fleet status`.

## Constitution Check

- Article 0: rung 1 (this spec), rung 4 (`core/explain.ts`), rung 5 (`observe/`, `compliance/`, `adopt/`), rung 7 (the test). No ontology term is new, so rung 0 is unchanged.
- Article 4: TypeScript only. Headless first: the lines are a function over data, the command prints them; no console change.
- The model types (`model/types.ts`, `model/site.ts`) and the query views are not touched, so no seam of spec 115-compatibility changes.

## Project Structure

```text
specs/117-adopted-in-status/  spec.md plan.md tasks.md reviewed.tsv
rung 4: src/archon/core/explain.ts (P117-NO-EVIDENCE)
rung 5: src/archon/observe/fleet-machines.ts (new), src/archon/observe/fleet-status.ts
        src/archon/compliance/not-observed.ts (new), impact.ts, drift.ts
        src/archon/adopt/policy.ts (the never-observed result named), src/archon/adopt/commands.ts (report), src/archon/device/commands.ts
rung 6: src/archon/commands/registry.ts (the command's help), src/archon/console/pc.ts (what a machine fails)
rung 7: tests/status117.test.ts, tests/status117-facts.ts (a child that prints what the console gathers)
```

## Design notes

- A policy result is read in four ways: pass, fail, not observed (the `observed` result of an unobserved machine, or `unknown`), and the rest (warn, accepted). The same
  function counts them for the line and decides the detail lines, so `host check` and `fleet status` agree.
- A control change is "no evidence" when it went from no evidence to fail and no changed evidence of it is a current failure: a change whose evidence is stale, or is the
  never-observed result, or is empty, is waiting; one with a fresh failing check is a failure. The fix names the command of each source of the changed evidence.
- Nothing here writes: the evidence, the views, OSCAL and the bundles read the same data.

## Standards considered

The same ones as the specification: RFC 2119 and RFC 8174, NIST SP 800-53 Rev 5 CM-8 (the inventory lists every component) and CA-7 (not yet monitored is not failed), and the
SCF controls AST-04 and MON-02. No term is defined, so no mapping is added to the audit.
