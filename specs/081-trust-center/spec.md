# 081: Trust Center from signed evidence

Issue intellectual-frontiers/stolos#22.

## Why

A company's customers ask how it is doing on SOC 2, HIPAA, or the controls they care about, and
usually get a page someone typed. A Trust Center built from signed evidence answers instead with
what was checked: each claim backed by a check a reader can verify, with how fresh its evidence is,
and nothing failing or stale hidden.

## Requirements

- **FR-001**
  `stolos trust build --bundle <zip> [--out <dir>] [--frameworks soc2,hipaa,...]
  [--public|--gated] [--on-request] [--key <file>] [--signers <file>] [--contact <link>]`
  verifies the bundle first (spec 072's `verifyBundle`; `--signers` replaces the bundle's own) and
  refuses it, naming each problem, when anything is wrong. Nothing is written for a refused bundle.
- **FR-002** The page is built from the bundle alone (never this PC's live state): the company (the
  fleet's title), the period, the signer, when it was signed, the bundle's SHA-256; the checks and
  their SCF controls from the bundle's OSCAL assessment results (spec 071); each check's observation
  time from the bundle's other items behind it (spec 092's `bundleItemsFor`: verify results,
  observations, commits; never the OSCAL document or `signers.ts`, which are stamped at export). A
  bundle without assessment results is refused.
- **FR-003** Framework requirements come through the SCF Council's mappings (STRM) of the SCF
  release the bundle's OSCAL back-matter names, from that catalog when this PC has it; otherwise
  NIST SP 800-53 only, from the bundle's own findings, and every other framework is listed as not
  shown with the reason. `--frameworks` naming one that cannot be shown is refused.
- **FR-004** Freshness (spec 073): each check is held to its source's default service level as of
  the bundle's signing; a stale check fails, and its control and MON-02 say how many were stale.
  Each control shows the age of its newest and oldest evidence and how many checks have no time. A
  bundle signed more than 7 days before the page is built (FedRAMP 20x's longest validation
  interval) makes every status stale, with a banner; the page's script shows the same banner when a
  reader opens a page that has aged past it. Failing and stale counts are at the top of the page.
- **FR-005** Every claim links to what backs it by SHA-256: gated, each full-bundle item
  (`evidence/objects/<sha256>`); public, the control's item in the summary bundle (and the full
  bundle's item hashes as text). The page says how to check them: `stolos evidence verify`, or
  `sha256sum` and `ssh-keygen` as the bundle's README says.
- **FR-006** Public (the default) shows the company, period, signer, statuses, counts, ages, and
  item hashes, kinds, and times; it leaves out subjects (hostnames, accounts, the repository), check
  titles, what each check found, item names, and people's names and emails. It publishes a summary
  bundle it derives (`stolos-evidence/1`, items of kind `summary`: an index and one document per
  control with exactly `format, id, name, how, status, checks, counts, observed, backedBy`), signed
  through a signing callback (072's `sshSigner`, `--key`) and refused unless its signer is the full
  bundle's; its `allowed_signers` holds only that signer's principal and key (no comment). With
  `--on-request` it publishes no bundle and says the evidence is available on request.
- **FR-007** Gated shows everything in the bundle (subjects, findings, item names) and publishes the
  full bundle, unpacked. Stolos builds no sign-in: the guide documents hosting it behind the
  company's own access (Cloudflare Access in front of Cloudflare Pages, or any access proxy). The
  page asks not to be indexed.
- **FR-008** The page is one static HTML file: its CSS and script inline and pinned by SHA-256 in a
  Content-Security-Policy with `default-src 'none'` (no request leaves it), system fonts, light and
  dark, readable at phone width (tables scroll in their own box), landmarks, a skip link, table
  headers, and statuses in words as well as color. The only outside link is the company's own
  `--contact` (`https:` or `mailto:`).
- **FR-009** `--out` (default: the state directory's `trust/public` or `trust/gated`) is replaced
  only when empty or marked by an earlier build (`.stolos-trust`). The command is terminal only
  (`noMcp`), offered on the PC.

## Success criteria

- **SC-001** `tests/trust081.test.ts`, from a real bundle (signed commits observing two machines, a
  verify, OSCAL, a throwaway ed25519 key): the public page shows failing and stale controls as such,
  links every claim to an item in the published summary bundle whose bytes hash to the link, carries
  no subject, hostname, email, finding, or item name in any published file, is well formed, and
  names no URL but the company's; the gated page links every item behind every control; a tampered
  bundle, a summary signed by another key, and an unreachable framework are refused; a stale bundle
  shows the banner; `--on-request` publishes nothing.

## Later

A CycloneDX attestation (spec 092) carried in the bundle as an item of its own, so its claims are
the page's claims; a fleet's own cadences (`compliance.cadence`) carried in the bundle; RFC 3161
timestamps.
