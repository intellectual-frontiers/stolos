/**
 * # Evidence bundles
 *
 * An auditor wants evidence they can check again themselves, not screenshots (spec 072). One
 * command gathers a period's evidence into a ZIP, and your daily key signs it:
 *
 * ```bash
 * deno task stolos evidence export --from 2026-01-01 --to 2026-06-30
 * deno task stolos evidence verify fcr-evidence-2026-01-01-to-2026-06-30.zip
 * ```
 *
 * In it: every commit in the period (raw, with its SSH signature), each observation Stolos recorded
 * (adopted machines, devices, the SaaS and cloud estate), the verify and install results this PC
 * recorded, `signers.ts`, the OSCAL assessment results (see [Compliance](../compliance/mod.ts)), and
 * the access reviews of the period's quarters, each with the signed commit that approved it (see
 * [People controls](../people/mod.ts)).
 *
 * ```mermaid
 * flowchart LR
 *   git["The fleet repository: commits and observations"] --> bundle["bundle: objects by SHA-256, a chained manifest"]
 *   pc["This PC: verify results, OSCAL"] --> bundle
 *   bundle --> sign["signed by a fleet signer (ssh-keygen)"] --> auditor["the auditor: evidence verify, offline"]
 * ```
 *
 * `evidence verify` names each problem: an item changed, missing, or added; the chain broken; the
 * manifest's signature wrong or by someone who is not a signer; a commit without a valid signature.
 * It needs only the bundle and OpenSSH. The bundle's README says how to check it by hand with
 * `sha256sum` and `ssh-keygen`.
 *
 * The signers inside a bundle vouch for themselves. An auditor who has the fleet's signers from
 * elsewhere (its repository, or the fleet's `allowed_signers`) passes them with `--signers`.
 *
 * @module
 */

export {};
