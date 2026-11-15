# 085: The estate graph, and SQL across every source

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#13.

## Requirements

- **FR-001** Connectors write normalized entities into their observations: people (from HR systems:
  work email, name, status, dates, manager, type; never compensation or personal fields), accounts
  (system, id, name, email, active, admin, MFA, last sign-in, service), devices, and repositories.
  The fleet's own machines (managed, adopted, SNMP devices) add theirs.
- **FR-002** `stolos estate query "<sql>"` runs one SELECT over them all, in an in-memory SQLite
  database (`node:sqlite`, the same on Bun and Node), from the last observations in Git: nothing is
  installed, nothing reaches the network, nothing can be written.
- **FR-003** Cross-system policies, in `estate check` and Compliance: leavers with active accounts
  (SCF IAC-07), active accounts no person owns (IAC-15), administrators without MFA (IAC-06), active
  people without a known device (AST-02, AST-03), unencrypted devices (CRY-05), unprotected private
  repositories (CHG-02).

## Success criteria

- **SC-001** `tests/estate085.test.ts`: merging by email, each policy on fixtures, the query and its
  refusals, and connectors' NIST and analyst labels.
