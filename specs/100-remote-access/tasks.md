# Tasks: Remote access to the Stolos Console

**Input**: `specs/100-remote-access/spec.md`, `plan.md`

**Tests**: every requirement is proved by `tests/access100.test.ts` with `proves([...])`.

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 Define the terms the spec uses in `ontology/stolos/`, each citing `100-remote-access` (see `spec.md`, Ontology)
- [x] T002 Write the requirements in `specs/100-remote-access/spec.md`, using only those terms

## Phase 2: Headless operations, then the consoles (rungs 2 to 6)

- [x] T003 Names under the web domain, typed and validated in the model (FR-001) in `src/archon/access/names.ts`, `src/archon/model/types.ts`, `src/archon/model/validate.ts`, `src/archon/identity/fleet-init.ts`
- [x] T004 DNS records, the heartbeat and the certificate (commons 0013-acme), kept as a secret (FR-002) in `src/archon/access/tls.ts`, `src/archon/web/cloudflare.ts`, `src/archon/core/secrets.ts`, `src/archon/model/secret-inventory.ts`, `src/archon/access/passkeys.ts`
- [x] T005 The HTTPS listener on the LAN or mesh address only (FR-003) in `src/archon/access/https.ts`, `src/archon/access/launch.ts`, `src/archon/console/stolos-launch.ts`, `src/archon/console/stolos-server.ts`
- [x] T006 Registration with a passkey and a code (commons 0014-webauthn) (FR-004) in `src/archon/access/devices.ts`, `src/archon/access/routes.ts`, `src/archon/access/service.ts`, `src/archon/access/pages.ts`
- [x] T007 Approval by a signer: `stolos devices approve`, a signed commit of access.ts (a decision) (FR-005, FR-006) in `src/archon/access/commands.ts`, `src/archon/access/routes.ts`, `src/archon/commands/registry.ts`, `src/archon/fleet/records.ts`
- [x] T008 Sign-in, revoke and list; privileges of a signer whose key is here (FR-007, FR-008, FR-009) in `src/archon/access/service.ts`, `src/archon/access/commands.ts`, `src/archon/console/stolos-server.ts`
- [x] T009 The Remote Access page (FR-010) in `src/archon/access/pages.ts`, `src/archon/console/stolos-pages.ts`
- [x] T010 Audit mail, the doctor, the policy and the compliance labels (FR-011, FR-012, FR-013) in `src/archon/access/service.ts`, `src/archon/access/doctor.ts`, `src/archon-boot/doctor.ts`, `src/archon/adopt/policy.ts`

## Phase 3: Proof and documentation (rung 7)

- [x] T011 Prove every requirement in `tests/access100.test.ts`
- [x] T012 Name the requirements on a `// Spec:` line in every source file above (spec 101-ladder FR-010)
- [x] T013 Update the guide that explains it (its `mod.ts`) in the same commit
