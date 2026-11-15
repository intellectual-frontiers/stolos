# 091: Connectors declared with the SDK, and the SaaS wave finished

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#28.

## Requirements

- **FR-001** Every connector is declared with `defineConnector` (spec 089), with the same behavior
  as before. That covers the ids, fields, posture facts, policies, gaps, and assets.
  - Ported: Cloudflare, Hetzner, AWS, Microsoft, Google, GitHub, Okta, BambooHR, Rippling.
  - Each record a connector reads carries a label from `src/archon/connect/labels.ts`; every label
    is a MITRE D3FEND artifact, an OCSF object, or a UDM term.
  - `user_account`, `code_repository`, `person`, and `hardware_device` records become the estate's
    accounts, repositories, people, and devices (`toEntities`). The others stay records: nodes of
    the estate graph (spec 090).
- **FR-002** The SDK gains what the ports needed:
  - `ctx.orGap`, for a part read and the rest kept;
  - `required` resources and `mustRead`, where a denied read must fail the observation as before;
  - `account(cred, records)`, so the account name can come from what was read;
  - `posture(records, cred, { gaps, now })`;
  - `ctx.fact`, for organization-level facts read beside a resource;
  - `asset()`, for `estate assets` kinds and facts.
- **FR-003** Six new connectors, read-only, each with recorded-response tests:
  - **HR rosters only:** Gusto, Deel, and Justworks (shared `roster.ts`). They read the name, work
    email, status, dates, manager, and role, and never pay or personal fields.
  - **JumpCloud:** users, administrators, second factors, devices, and disk encryption.
  - **Code hosts:** GitLab and Bitbucket (shared `codehost.ts`). They read members, 2FA where the
    API says, owners, protected and reviewed default branches, and secret scanning where available.

  `PERSON_SOURCES` gains the new HR systems after Rippling, and JumpCloud after Okta.

- **FR-004** Vendor limits are stated in each connector's connect steps:
  - Gusto and Justworks offer no self-serve read-only token (OAuth apps, partner access).
  - Bitbucket's API does not expose 2FA.
  - GitLab shows per-member 2FA only to Owners, and approval rules need a paid tier.

## Success criteria

- **SC-001** The recorded-response tests for every connector pass unchanged (spec 084, 086). The old
  and new connectors were also compared on fake APIs, about 35 scenarios in all, with the same
  output apart from order.
- **SC-002** `tests/connect091.test.ts` covers each new connector:
  - the entities it produces;
  - posture;
  - a 403 as a gap;
  - a failing policy with its fix;
  - no pay or personal data;
  - GET only (plus a declared token endpoint).

## Later

Field names that came from third-party mirrors need checking against live sandboxes before relying
on them: JumpCloud's MFA and disk-encryption fields, and Justworks' work-email type. The SNMP
devices and the adopted machines' probe already enter the estate as fixed assets (spec 090); their
OCSF device-inventory output comes with spec 092's exporters.
