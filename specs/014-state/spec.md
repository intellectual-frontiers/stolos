# Feature Specification: State, provenance, and push

**Feature Branch**: `014-state` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Every host records what it is and what was done to it, in the repository,
exportable as RDF (Articles 15, 16).

## Requirements _(mandatory)_

- **FR-001**: `archon capture` writes `state/hosts/<host>/snapshot/{snapshot,drift}.json`: manual
  packages, snaps, enabled units, listening ports, accounts, tool versions, and drift from the plan
  (missing packages, units not in their desired state, unmodeled listening ports; DHCP client ports
  excepted).
- **FR-002**: Every apply that changed something writes a provenance activity
  (`state/hosts/<host>/prov/<time>.json`; timer runs write to `/var/lib/archon/prov`).
- **FR-003**: `archon push [--check]` says whether recorded state or local commits wait for GitHub
  and why, commits `state/` only (as `014-state: record <host> ...`), rebases onto the fleet's
  branch, and pushes as `ops` with the host's deploy key.
- **FR-004**: `archon export` writes `out/rdf/fleet.ttl` (W3C PROV, Dublin Core, FOAF, archon:).
- **FR-005**: Every archon run writes one status line for the prompt (spec 011).

### Overrides of Ubuntu defaults

None.
