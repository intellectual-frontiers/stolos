# Feature Specification: Out-of-band management

**Feature Branch**: `018-out-of-band` (committed directly to main) **Created**: 2026-11-10
**Status**: Implemented **Input**: Console access when the network or the OS is down: Intel AMT on
the Minisforum MS-01 (the i226-LM port).

## Requirements _(mandatory)_

- **FR-001**: A host may record its AMT address and notes (`outOfBand.amt`); `archon export`
  publishes them.

### Overrides of Ubuntu defaults

None (AMT is firmware, not part of Ubuntu).

## Context

Manual procedures (done by a person at the AMT console, not by Archon):

- AMT is used for the console (KVM), power control, and virtual media (an ISO for the manual install
  path in the README); setup is done once in the MEBx (Ctrl+P at power-on).
- Network installs set the HTTP Boot URL in the BIOS through the AMT KVM when no one is at the
  machine.
