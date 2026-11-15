# 083: Auditor portal

Issue intellectual-frontiers/stolos#25: a read-only, time-boxed view for an external auditor: the
controls in scope; populations and samples drawn by the tool; each sample's evidence, verifiable in
place (spec 072); requests and responses kept as the audit trail.

## Why

An external auditor tests a control by taking its population (every leaver of the period, every
change, every active account), drawing a sample, and examining each sample's evidence. Today the
company answers with screenshots and spreadsheets the auditor cannot check, and the auditor cannot
tell whether the population was complete or the sample was chosen. Stolos already gathers a period's
evidence into a signed, hash-chained bundle (spec 072). The portal takes the populations from that
bundle, lets the auditor's own seed choose the sample by a published method they can redo, shows
each sample's evidence with its hash and its place in the signed manifest, and keeps every request
and response as a signed commit. The auditor verifies each sample without asking the company for a
screenshot.

## Requirements

- **FR-001** An engagement is `fleets/<fleet>/audits/<id>/engagement.ts`
  (`src/archon/audit/engagement.ts`), a typed TypeScript literal (`Engagement`, exported from
  `@intellectual-frontiers/stolos/archon/audit/mod`) that Stolos reads without running it: the audit
  firm and its people, the period, the frameworks, the controls in scope (each with the id the
  auditor uses, a title, optional SCF ids, and the population it is tested on), the pinned evidence
  bundle (file name, SHA-256, manifest head), the last day of access (`access.expires`, UTC, the day
  included), when and by which signer it was opened, and when it was closed.
- **FR-002** `stolos audit open`, `audit bundle`, `audit access`, `audit close` write it;
  `audit
request`, `audit respond`, `audit sample` add to its trail. Each makes one commit of
  those files only, signed with Git's signing key (`git commit -S`; ssh-keygen asks the passphrase
  in the terminal), whose message carries a trailer
  `Audit-Entry: <path> sha256:<SHA-256 of the file>` for each file: the signature covers the exact
  text. Nothing is pushed. A hand edit that is not committed is refused, and a closed engagement
  takes no more entries. `audit bundle` accepts only a bundle signed by a fleet signer whose period
  covers the engagement's, and copies it into this PC's evidence directory.
- **FR-003** Populations (`src/archon/audit/populations.ts`): each is a typed query over one
  bundle's items (`BundleView`), never over this PC's live state. `change` (each commit item),
  `leavers` (each person an HR observation shows terminated with an end date in the period; the
  evidence is the first observation that shows it, and the period's last observation of each system
  that listed an account with their email), `mfa` (each active non-service account in each system's
  last observation), `devices` (devices in the last observations, and adopted machines' last
  observations), `repositories`, `access-reviews` (each `people` item and its approving commit),
  `verify` (each verify item). A unit has a unique id, facts, and its evidence items by SHA-256. A
  population's hash is
  `sha256("stolos-audit-population/1\n<id>\n<manifest head>\n" +
"<unit id>\t<sha256,...>\n" per unit sorted by id)`.
  Each query is documented in the guide and on the portal.
- **FR-004** Samples (`src/archon/audit/sample.ts`): the auditor gives the seed (any one line of
  text: a number, or a value from a public randomness source they chose; Stolos only accepts it) and
  the sample size (theirs to choose; Stolos reproduces no sample size table). The method,
  `stolos-srswor-sha256/1`, is simple random sampling without replacement by random sort keys: each
  unit's key is `sha256(seed + LF + unit id)` in lowercase hex, the units are ordered by key (then
  id), and the sample is the first n. The sample, seed, method, size, population size, and
  population hash are recorded in the trail. The guide and the package's README show the shell that
  redraws it.
- **FR-005** The trail (`src/archon/audit/trail.ts`): `audits/<id>/trail/<NNNN>-<kind>.md`, numbered
  in order, kinds `request`, `response`, `sample`, `note`; front matter with one line of JSON per
  key (seq, kind, at, by, control, re, sample), then the text. A request's `by` is one of the
  engagement's auditors; a response's `re` names an earlier entry.
- **FR-006** Checking (`src/archon/audit/case.ts`): an engagement is read as committed (HEAD) and
  checked: engagement.ts and each entry are the text their last commit's trailer vouches for, and
  that commit's SSH signature verifies against the fleet's signers; the pinned bundle is found, has
  the pinned SHA-256 and head, and `verifyBundle` runs on it; each control's population is computed;
  each sample is redrawn from its seed against the population's hash. The same code checks an export
  package.
- **FR-007** The portal (`src/archon/audit/portal.ts`), in the Stolos Console on 127.0.0.1:
  - `stolos audit portal <id>` starts the console and prints only an audit link
    (`/audit/launch?t=...`): it works once, for two minutes, and becomes a session (the console's
    cookie) in the group `audit:<id>` that may read only `/audit/<id>/` and `/v1/audit/<id>/`, with
    GET and HEAD, for at most four hours. Every other route answers 403; anything but GET and HEAD
    answers 405. A fleet operator's own session sees the portal too.
  - Every request is refused (410) once the engagement is past `access.expires` or closed.
  - Pages: the engagement (firm, period, controls with population sizes and hashes, the bundle's
    verification); each control's population (every unit, its facts, its evidence) with a draw
    preview from a seed (not recorded); each recorded sample (each unit's items: SHA-256, kind,
    name, manifest index and chain link, the bundle's verification and the redraw); each item (its
    text and manifest entry, and a download); the trail in order with each entry's commit and
    signer; downloads of the bundle and the export package.
  - The same as JSON under `/v1/audit/<id>/` (`/`, `controls/<control>`, `samples/<seq>`,
    `items/<sha256>`, `items/<sha256>/raw`, `trail`, `verify`, `bundle.zip`, `export.zip`), listed
    in the console's OpenAPI document (`src/archon/audit/openapi.ts`, merged into spec 094's).
- **FR-008** Sharing with a remote auditor: the console answers only on this PC, so the company
  sends the export package (`stolos audit export <id>`, `src/archon/audit/package.ts`): the bundle,
  engagement.ts and every trail entry each with the raw commit that recorded it, the fleet's
  signers, `populations.json`, the portal as one static page, `index.json` (every file's SHA-256),
  and a README for checking by hand. `stolos audit verify <package> [--signers]` checks it offline
  with the same code (FR-006) and names each problem. Nothing new is signed; the package is not
  time-boxed (sending it is the company's decision). An auditor on site uses the portal link on the
  company's PC.
- **FR-009** Commands in the registry, on the PC: the writing ones (`audit open`, `bundle`,
  `access`, `request`, `respond`, `sample`, `close`) and `audit portal` and `audit export` are
  terminal only (`noMcp`); `audit list`, `audit show`, `audit verify` are read-only and in the
  console group "Audits".
- **FR-010** The guide `audit` (`src/archon/audit/mod.ts`), registered in
  `src/archon/core/guides.ts`.

## Success criteria

- **SC-001** `tests/audit083.test.ts`, with real SSH keys and signed commits:
  - engagement.ts round-trips, and malformed ones are named;
  - open and close are signed commits whose trailer vouches for engagement.ts; a second open, a
    second close, an entry after closing, and a change over an uncommitted hand edit are refused;
  - the populations of a fixture bundle: the leaver with their HR and directory evidence, the active
    accounts (no service account), every commit of the period and none after; hashes are stable;
    every unit's items are in the bundle with their SHA-256;
  - the same seed draws the same sample, another seed another, the population's order does not
    matter, and the key is what `sha256sum` computes;
  - a recorded sample redraws from its seed; each unit's items, through the portal's JSON, match
    their hashes and their manifest entries, and the bundle verifies; a changed sample entry is
    named;
  - an audit-scoped session reads its engagement only (403 elsewhere, 405 for writes), its link
    works once, and its JSON is valid against the OpenAPI document;
  - an expired or closed engagement is refused, in HTML and JSON;
  - the export package verifies offline; a changed request, a changed bundle item, and someone
    else's signers are named.
- **SC-002** Existing tests pass; the OpenAPI document stays valid OpenAPI 3.1.

## What CPA-firm acceptance still needs

Building this does not make the evidence format accepted. The issue asks for it to be done with two
or three CPA firms; that is work for people, and it remains:

1. Walk two or three firms (SOC 2 practitioners, ideally one that also does ISO 27001) through a
   real engagement on a pilot fleet: the portal on site, and the export package remotely.
2. Ask each firm's methodology owner to accept, in writing, (a) `stolos-srswor-sha256/1` as a random
   selection method for attribute sampling, with the auditor choosing the seed and the size under
   their own sampling guidance, and (b) the population definitions of FR-003 as complete for the
   controls they map to (the leavers population depends on the HR system's records; firms may ask
   for a reconciliation to payroll).
3. Ask whether they accept the bundle's signature (the company's signer) and the commit trailers as
   evidence of integrity, or want a third-party timestamp (RFC 3161) on the manifest; record the
   answer and add the timestamp if asked.
4. Ask how they want requests recorded: the company records the auditor's request verbatim (FR-005);
   a firm may prefer to sign its own requests (an auditor key in engagement.ts, verified like a
   signer's), which is a small change here.
5. Capture what each firm still asked for as a screenshot, and turn each into a population or an
   item kind, until none is asked for.
6. Publish the accepted format (the package layout, the method, the population definitions) as a
   versioned document the firms can cite in their workpapers.

## Decisions to review

- One bundle per engagement (re-pinning replaces it; samples drawn from the old bundle then name a
  different population hash, and the check says so).
- The company records the auditor's requests; the auditor does not sign them (see above).
- The portal refuses everyone, operators included, once the engagement has expired or closed;
  operators use `stolos audit show`.
- An audit session lasts at most four hours, besides the engagement's last day.
- The export package is not time-boxed.
- The SCF ids each population usually tests are those Stolos already declares (CHG-03, HRS-12,
  IAC-04, IAC-37, AST-04, CRY-07, IAC-12, MON-02); the auditor's own criteria ids are free text.

## Out of scope

- Serving the portal beyond this PC (a public host, a tunnel): the export package is the remote
  path.
- Sample size tables and statistical evaluation of exceptions: the auditor's methodology.
- Populations defined by a fleet's own control packs (a later spec may let a pack declare one).
