# Feature Specification: State, provenance, and push

**Feature Branch**: `014-state` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Every host records what it is and what was done to it, in the repository,
exportable as RDF (Articles 15, 16).

Since spec 048 a host keeps what it records in its own state store and never pushes to the
repository; spec 048 governs where state is kept and how it is read.

## Requirements _(mandatory)_

- **FR-001**: `archon capture` reads manual packages, snaps, enabled units, listening ports,
  accounts, and tool versions, and prints the drift from the plan (missing packages, units not in
  their desired state, unmodeled listening ports; DHCP client ports excepted). It writes nothing
  (spec 048).
- **FR-002**: Every apply that changed something records a provenance activity in this machine's
  state store (`archon.sql`, kind `prov`, spec 048).
- **FR-004**: `archon export` writes `out/<fleet>/rdf/fleet.ttl` (W3C PROV, Dublin Core, FOAF, archon:).
- **FR-005**: Every archon run writes one status line for the prompt (spec 011).

### Overrides of Ubuntu defaults

None.
