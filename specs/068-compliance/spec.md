# 068: Compliance, by Secure Controls Framework control

## Why

Auditors ask in a framework's words (HIPAA, PCI DSS, CMMC, SOC 2). Stolos already collects evidence:
each managed server's verify, each adopted machine's policies, each cloud's posture, and the
repository's signatures. The Secure Controls Framework (SCF) is the common language between that
evidence and the frameworks. Basic first; deeper later.

## Requirements

- **FR-001** A catalog of the SCF controls Stolos gives evidence for
  (`src/archon/compliance/scf.ts`), each with what Stolos looks at and its requirements in HIPAA,
  PCI DSS v4.0, CMMC 2.0 Level 2, and SOC 2. Marked everywhere as a starter mapping, to check
  against the SCF's STRM.
- **FR-002** A control's status is what its evidence says (any fail fails, all pass passes, else
  partial; none is "no evidence"). A requirement's status is what its controls say, and is met only
  as far as all of them have evidence.
- **FR-003** A Compliance tab in both consoles: framework tabs, the requirements table, and each
  control with its evidence and fixes. The Archon Console shows its own server's evidence (verify,
  the applied commit's signature, HTTPS, the model); the Stolos Console the fleet's, with a JSON
  download.
- **FR-004** `stolos compliance [--framework hipaa|pci|cmmc|soc2] [--json]`.
- **FR-005** Every SCF id a check cites is in the catalog (a test keeps it so).

## Later

Organizational controls with recorded evidence (policies, training, vendor reviews), SOC 2 Type 2
period reports from `git log`, and a checked mapping per framework version.
