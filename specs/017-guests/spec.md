# Feature Specification: Guests (LXD)

**Feature Branch**: `017-guests` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Containers and VMs with Ubuntu's native manager, LXD (a snap; `lxd-installer`
is preinstalled).

## Requirements _(mandatory)_

- **FR-001**: A host lists `guests` (name, container or vm, image such as `ubuntu:26.04`, optional
  CPU and memory limits).
- **FR-002**: With guests, `archon apply` installs the `lxd` snap, initializes it once from a
  rendered preseed (bridge `lxdbr0`, directory pool `default`), and runs `archon guest sync`.
- **FR-003**: `archon guest sync` creates missing instances and starts stopped ones; it never
  deletes (Article 11). `archon verify` checks each guest exists.
- **FR-004**: Operators are in the `lxd` group (spec 006).
- **FR-005**: Guests created or deleted by `archon guest sync` are emailed (spec 025).

### Overrides of Ubuntu defaults

None: LXD's own defaults (lxdbr0 with NAT); the storage pool is `dir` so it works on any disk
layout.
