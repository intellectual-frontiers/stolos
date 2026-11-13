# Implementation Plan: Platform

**Spec**: [spec.md](spec.md)

## Approach

- `src/archon/capabilities/platform.ts`: verification-only units and packages for each default in
  the spec table, plus `/etc/archon/host` and the tmpfiles.d entry for `/var/lib/archon`.
- Every host includes the capability through `foundation()` in `src/archon/capabilities/mod.ts`.
- The defaults table was checked against `ubuntu-26.04.1-live-server-amd64.manifest` from
  releases.ubuntu.com; the e2e install test (spec 004) re-checks it on a real install.
