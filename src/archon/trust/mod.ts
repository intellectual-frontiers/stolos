/**
 * # Trust Center
 *
 * Your customers ask how you are doing on SOC 2, HIPAA, or the controls they care about. A Trust
 * Center answers with a page built from signed evidence (spec 081): each framework's requirements,
 * each control's status, how old its evidence is, and, for every claim, the item that backs it by
 * its SHA-256 and how to check it yourself. Nothing on it is typed by hand, and nothing failing or
 * stale is hidden.
 *
 * ```bash
 * deno task stolos evidence export --from 2026-07-01 --to 2026-09-30
 * deno task stolos trust build --bundle lab-evidence-2026-07-01-to-2026-09-30.zip --out trust
 * ```
 *
 * ```mermaid
 * flowchart LR
 *   bundle["evidence bundle (spec 072)"] --> verify{"verified?"}
 *   verify -- "no" --> refuse["refused, with the reason"]
 *   verify -- "yes" --> page["index.html: frameworks, controls, ages"]
 *   page --> pub["public: redacted, a signed summary bundle"]
 *   page --> gated["gated: everything, the full bundle, behind your own access"]
 * ```
 *
 * ## What it is built from
 *
 * Only the bundle. `trust build` verifies it first (every item unchanged, the chain whole, the
 * manifest signed by a fleet signer, every commit signed) and refuses it, naming each problem, when
 * anything is wrong. It then reads the bundle's OSCAL assessment results (every check and the SCF
 * controls it is evidence for) and its other items (when each verify, observation, and commit was
 * recorded). Each requirement's status comes from its SCF controls, through the SCF Council's own
 * mappings of the release the bundle names (see [Compliance](../compliance/mod.ts)); without that
 * catalog on this PC, only NIST SP 800-53 is shown, from the bundle's own findings, and the page
 * says why the others are not. `--frameworks soc2,hipaa` shows only those.
 *
 * ## Fresh, stale, and failing
 *
 * Every control shows the age of its newest and oldest evidence when the bundle was signed. A
 * source observed longer ago than its service level then (spec 073: 30 minutes for managed
 * servers, two days for adopted machines, devices, and accounts) was stale, and a stale check
 * fails: the control says "Failing" and how many checks were stale. A bundle signed more than 7
 * days before the page was built (FedRAMP 20x's longest validation interval) makes every status
 * stale, and the page says so at the top; its small script shows the same banner once a page that
 * was fresh when built has aged past it in a reader's browser. Build the page from a new bundle at
 * least weekly.
 *
 * ## Public or gated
 *
 * | On the page                                                          | `--public` (default) | `--gated` |
 * | -------------------------------------------------------------------- | -------------------- | --------- |
 * | the company, the period, the signer, when it was signed              | yes                  | yes       |
 * | each requirement's and control's status, its counts, its ages        | yes                  | yes       |
 * | the SHA-256 of each item behind a control                            | yes                  | yes       |
 * | subjects (hostnames, accounts, the repository), what each check found | no                   | yes       |
 * | item names (paths, commits), people's names and emails               | no                   | yes       |
 * | the evidence beside the page, in `evidence/`                         | a summary bundle     | the bundle |
 *
 * A public build derives a summary bundle: one JSON item per control (its status, counts, ages,
 * and the SHA-256, kind, and time of each full-bundle item behind it) and an index, in the same
 * signed, hash-chained format as an evidence bundle, signed by the same fleet signer (`--key`, else
 * Git's signing key; ssh-keygen asks the passphrase). It refuses a key that is not the full
 * bundle's signer. Each control links to its summary item, which anyone can check with
 * `deno task stolos evidence verify` or `sha256sum` and `ssh-keygen`. `--on-request` publishes no
 * bundle; the page then says the evidence is available on request (`--contact`, an `https:` or
 * `mailto:` link, says where to ask).
 *
 * ## Hosting
 *
 * The folder is static: `index.html` and `evidence/`. The page makes no requests (its
 * Content-Security-Policy forbids them), so any static host serves it, and a reader can save it and
 * read it offline.
 *
 * A gated page holds hostnames and people's details: host it only behind your own access, never
 * on a public address. Stolos builds no sign-in into the page. With Cloudflare, which the fleet
 * already uses for DNS and TLS: put the folder on Cloudflare Pages (or any origin behind the
 * zone), and add a Cloudflare Access application for its hostname (Zero Trust, Access,
 * Applications, Self-hosted) with a policy that lets in only the people you name (their emails, or
 * your identity provider's group for customers under NDA). Access then signs each reader in before
 * Cloudflare serves a byte. Any other access proxy in front of a static folder does the same.
 *
 * ## Rebuilding
 *
 * `--out` defaults to this PC's state directory (`trust/public` or `trust/gated`). A rebuild
 * replaces a folder a Trust Center was built in (it holds `.stolos-trust`), and refuses any other
 * folder that is not empty.
 *
 * @module
 */

export {};
