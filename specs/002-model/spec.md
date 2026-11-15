# Feature Specification: Model, validation, rendering, export

**Feature Branch**: `002-model` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: The fleet and its hosts are TypeScript; TypeScript validates them; Archon
renders every native format from them; RDF is an export (Articles 4, 7, 10).

## User Scenarios & Testing _(mandatory)_

### User Story 1: One model, validated first (Priority: P1)

As the owner, I want one TypeScript model of the fleet that is validated before anything renders or
changes, so that mistakes are caught with a clear fix instead of on a host.

**Acceptance Scenarios**:

1. **Given** a valid fleet and hosts, **When** `archon build` runs, **Then** each host's files are
   rendered under `out/hosts/<host>/` and nothing else changes.
2. **Given** a host with a malformed MAC, a duplicate name, an unknown spec, or anything that looks
   like a secret, **When** `archon validate` runs, **Then** it lists each problem with where, what,
   and a fix, exits non-zero, and renders nothing.
3. **Given** no fleet yet, **When** any model command runs, **Then** it says to run
   `archon fleet init` first.

### User Story 2: RDF on request (Priority: P3)

As someone who wants the graph, I want `archon export` to write the fleet, hosts, and specs as RDF
(Turtle) without RDF being part of validation.

## Requirements _(mandatory)_

- **FR-001**: `fleets/<fleet>/fleet.ts` holds the fleet (identity, Ubuntu release, time zone,
  locale, repository); `fleets/<fleet>/hosts/<name>/host.ts` holds one host each; hosts are
  discovered from the directory.
- **FR-002**: Every host has the fleet admin and `ops` accounts (spec 006) plus optional extra
  accounts.
- **FR-003**: Capabilities contribute packages, files, units, ports, and tools; conflicting
  definitions are errors; identical ones merge.
- **FR-004**: Validation rules (each with a message and a fix): account names and UIDs, the noreply
  commit address, SSH keys present and well formed, UTF-8 locale, IANA time zone, repository slug,
  host names, MAC format and uniqueness, spec IDs exist under `specs/`, absolute file paths and
  octal modes, port ranges, unit suffixes and verify commands, tool sources, and no secret-looking
  text anywhere in the model or rendered files (private keys, GitHub tokens, API keys, password
  hashes).
- **FR-005**: `archon build` validates, then renders; `archon validate` only validates.
- **FR-006**: `archon export` writes Turtle (W3C PROV, SKOS where they fit) under `out/<fleet>/rdf/`.

## Success Criteria _(mandatory)_

- **SC-001**: Every validation rule has a unit test with a failing and a passing example.
- **SC-002**: `archon build` is deterministic: building twice changes no file.
