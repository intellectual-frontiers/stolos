# Implementation Plan: Machine-reported tags: what a machine says about itself, and what the fleet does with it

**Branch**: `112-machine-reported-tags` (committed directly to main) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/112-machine-reported-tags/spec.md`

## Summary

A machine says things about itself: its `/etc/machine-info`, its firmware's facts, and a table of tags of its own (`archon tag`) in its state
database, which osquery reads. The PC reads them over the channels it already trusts (SSH to a pinned host key), keeps them in its observation
cache, reads each one as untrusted input (grammar, caps, counted), and resolves them below the fleet's own tags according to what each
dimension of `tags.ts` says (`fromMachine`: accept, hint, ignore). Where a machine disagrees with the fleet, the fleet wins and the
disagreement is a finding. `stolos tag accept` turns a claim into a signed person tag, and the console's machine page lists what the machine
says, with Accept and Ignore.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime (`@intellectual-frontiers/commons`), `node:sqlite` (already used by the state
store); nothing new

**Storage**: the machine's own `archon.sql` (the `tag` records and the view `archon_tags`); the PC's own `archon.sql` (the `reported` records,
its observation cache); the fleet repository only through `stolos tag accept` (`decisions.ts`, `machine.ts`, one signed commit)

**Testing**: `tests/tags112.test.ts` (the real `osqueryi` where installed, `STOLOS_REQUIRE_OSQUERY` as spec 093; the real probe script run by
`sh`; the real `archon tag` commands in a host root; `stolos tag accept` through a real signed `stolos apply`), plus the tests of specs 108,
048, 067 and 069 that carry a changed contract; the project's runner on Bun and Node 26

**Target Platform**: every machine that runs `archon` (Linux, root for changes); the controller PC (Linux, macOS, Windows); adopted POSIX and
Windows machines through their probe

**Project Type**: command line (headless first), then the Stolos Console

## Constitution Check

- Article 0 (the ladder): the terms are in the ontology (rung 0) and cited in `spec.md` (rung 1); the claim grammar, `machineInfoMap`,
  resolution and the tags table (`src/archon/model/{tags,reported}.ts`, `src/archon/state/{store,tags,reported}.ts`) are data operations
  (rung 3); the commands, the collection and the finding (`src/archon/fleet/`, `src/archon/observe/`, `src/archon/adopt/`,
  `src/archon/compliance/`) are business rules (rung 5); the commands are in the one registry and the console draws what the rules give
  (rung 6); the guide is rung 7. The command and its test are written before the console that draws them.
- Article 2 and 3 (Ubuntu decides; reuse): `/etc/machine-info` is systemd's own file; the tags table is osquery's own mechanism (ATC); nothing
  is installed.
- Article 4 (code over config): `fromMachine` and `machineInfoMap` are TypeScript in `tags.ts`, typed by the fleet's own tag ids.
- Article 9 and 25: a claim never becomes a fleet tag except by a signed commit (`stolos tag accept`); the machine keeps what it says about
  itself on itself (amended: a machine MAY record facts and claims about itself, none of which changes configuration).
- Article 13: nothing secret is a claim; a serial number is not read.
- Article 17: the read is the MCP server's `archon_state` over SSH as `ops`, and the probe key's forced command; nothing new is served.
- Article 19 (calm output): `tag add|remove|accept` are actions (calm); `tag list` is a report.
- Article 6 (one registry): `tag accept` and `--reported` are registry commands and arguments; `archon tag add|remove|list` are registry
  commands placed on the machine; the console calls the same command through its form.

## Project Structure

### Documentation (this feature)

```text
specs/112-machine-reported-tags/
  spec.md          the requirements, the ontology terms they use, the standards considered, the decisions
  plan.md          this file
  tasks.md         the tasks, each with its files and requirements, and the later items
  reviewed.tsv     the requirements proven by review
```

### Source Code (by rung of the ladder)

```text
rung 0: ontology/stolos/{vocabulary,codes,mod,audit}.ts (TagClaim, TagTrust, TagSource, TagOrigin's reported and announced)
rung 3: src/archon/model/{tags,reported}.ts, src/archon/state/{store,tags,reported,state-command,inventory}.ts
rung 4: src/archon/identity/fleet-init.ts (the starter tags.ts says fromMachine and machineInfoMap)
rung 5: src/archon/fleet/{tags,tag-commands,machine-tags}.ts, src/archon/observe/{fleet-status,reported}.ts,
        src/archon/adopt/{adopt,commands,controller,probe,query}.ts, src/archon/apply/apply.ts, src/archon/compliance/report.ts
rung 6: bin/stolos-probe.{sh,ps1}, src/archon/commands/registry.ts, src/archon/mcp/server.ts,
        src/archon/console/{tags,assets,pc,stolos-pages}.ts
rung 7: examples/fleets/lab/tags.ts, tests/tags112.test.ts, src/archon/fleet/mod.ts
```

**Structure Decision**: the engine's existing folders. `model/reported.ts` is pure (it reads text it is given and makes claims);
`state/reported.ts` and `state/tags.ts` are the only places that touch the machine's database for it; `fleet/machine-tags.ts` is the
machine's side (what `archon tag` does and what apply computes) and `fleet/tags.ts` stays the one place where the PC resolves tags.

## Design notes

- **One resolution.** `resolveTags(set, facts, assigned, networks, claims)` stays the one function: after a person's tags, the rules and the
  groups, it reads the claims in the order reported, announced, applies `fromMachine`, and returns the held tags (each with its origin,
  source and trust), every claim with its status, the disagreements and the count of those ignored. `idSet(resolved)` leaves out the hints, so
  every place that chooses machines (selection, facets, group-by, compliance scope) is correct without knowing about them; `--reported` asks
  for them.
- **A report is raw and small.** What is kept in the PC's cache is a bounded copy of what the machine said (`sanitizeReport`): at most 64
  rows, strings cut to 200 characters, control characters removed. It is parsed again each time it is read, with the fleet's current
  `tags.ts`, so a change of `fromMachine` or `machineInfoMap` takes effect with no new observation.
- **The probe reads `/etc/machine-info` as data.** `sed` and `head`, never `.` or `source`; the output goes through the probe's `kv`, which
  puts a value on one line; the PC reads it again with the caps.
- **Automatic tables.** `archon_tags` is a view of the state database, so `archonTables()` renders it into `osquery.conf` with the others;
  `atcColumns` has a guard that no column is `path`.
- **Where a machine says a tag the fleet does not define**, the claim is listed and cannot be accepted: defining it is a change of `tags.ts`
  in the spec loop (as spec 108 decided), never a side effect of a machine's words.

## Standards considered

The same ones as the specification (`spec.md`, Standards considered): RFC 2119 and RFC 8174 for the requirement words, NIST SP 800-53 Rev 5
CM-8 and its enhancements, with SP 800-128, for the accuracy of the inventory (the fleet, not the component, decides the baseline); the
systemd `machine-info(5)` manual (version 259) for the file the first source reads and its keys; DMTF DSP0134 SMBIOS for the firmware facts
and their chassis types; osquery's Automatic Table Construction for `archon_tags` (and `path` as a reserved column); and W3C SKOS for the
code lists (concept schemes) with RDF 1.1's `rdf:Statement` for a claim, as `ontology/stolos/audit.ts` maps them. A fleet-wide policy over
claims has no standard to adopt: the three trusts are the fleet's own decision per dimension.
