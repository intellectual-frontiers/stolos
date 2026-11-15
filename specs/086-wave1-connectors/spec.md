# 086: Wave 1 connectors: identity, code, and HR

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#14.

## Requirements

- **FR-001** Read-only connectors, each with a recipe for its credential, labeled with NIST service
  models and analyst market categories (spec 084), writing entities for the estate graph (085):
  - Google Workspace (Access Management): the Admin SDK Directory API, as a service account with
    domain-wide delegation for one read-only scope; the JWT is signed in TypeScript (RS256).
  - Okta (Access Management): users, administrator role assignees, second factors.
  - GitHub (DevOps Platforms): members, owners, members without 2FA, repositories, branch protection
    or rulesets, required reviews, secret scanning.
  - BambooHR and Rippling (Cloud HCM Suites): the roster only (name, work email, status, start and
    end dates, manager, type), never pay or personal fields; people are not listed as assets.
- **FR-002** Accounts known by login only are linked to people in `fleets/<fleet>/estate/links.ts`.
- **FR-003** Later in this issue: Gusto, Deel, Justworks, JumpCloud, GitLab, Bitbucket.

## Success criteria

- **SC-001** `tests/connect086_test.ts`: each connector against recorded responses (paging by Link
  headers, rulesets beside branch protection, a verified JWT signature), only GET requests (but
  token requests), no pay fields kept, and a leaver failing once joined.
