# Feature Specification: Fleet identity and secrets

**Feature Branch**: `003-identity` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: The primary user's name, ID, keys, and commit address come from GitHub
through `gh`; secrets stay on the boot machine (Articles 13, 17).

## User Scenarios & Testing _(mandatory)_

### User Story 1: Identity from GitHub (Priority: P1)

As the owner, I want `archon fleet init` to read who I am from my GitHub account so I never type or
maintain it.

**Acceptance Scenarios**:

1. **Given** `gh` is signed in on the boot machine, **When** `deno task archon fleet init` runs,
   **Then** `fleets/<fleet>/fleet.ts` holds my login, numeric ID, name, noreply commit address
   (`<id>+<login>@users.noreply.github.com`), and public SSH keys from `github.com/<login>.keys`,
   plus the Unix account name I chose (UID 1000), time zone, locale, and keyboard.
2. **Given** I typed an admin password twice, **Then** only its SHA-512 crypt hash is stored, in the
   boot machine's secret store, and nothing secret is in the repository.
3. **Given** `gh` is not signed in, **Then** it stops with
   `gh auth login --web --git-protocol https`.

## Requirements _(mandatory)_

- **FR-001**: Identity fields come from `gh api user` (REST) and `https://github.com/<login>.keys`.
- **FR-002**: The secret store is `%APPDATA%\archon\secrets` on Windows and
  `~/.config/archon/secrets` elsewhere (mode 0700/0600); it holds `admin-password.hash`,
  `hosts/<host>/deploy_key`, and `install-tokens.json`.
- **FR-003**: The password hash is SHA-512 crypt (`$6$`), computed in TypeScript (no external
  tools), checked against glibc's reference vector.
- **FR-004**: The validator (spec 002) refuses secret-looking text anywhere in the model or rendered
  files.
- **FR-005**: Works the same on Windows and Linux boot machines (Deno only).

### Overrides of Ubuntu defaults

None.

## Success Criteria _(mandatory)_

- **SC-001**: A fresh checkout plus `gh auth login` plus `fleet init` produces a valid fleet with no
  secret in git.
