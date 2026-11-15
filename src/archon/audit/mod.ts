/**
 * # The auditor portal
 *
 * An external auditor tests a control by sampling its population and examining each sample's
 * evidence. Stolos gives them both from the signed evidence bundle (spec 072), so they verify each
 * sample themselves and never need a screenshot (spec 083).
 *
 * ```mermaid
 * flowchart LR
 *   open["stolos audit open: engagement.ts (signed commit)"] --> pin["stolos audit bundle: the period's evidence bundle"]
 *   pin --> pop["populations: a typed query per control over the bundle's items"]
 *   pop --> sample["stolos audit sample: the auditor's seed, a published method"]
 *   sample --> trail["the trail: requests, responses, samples (signed commits)"]
 *   trail --> portal["the portal: /audit/&lt;id&gt;/ on 127.0.0.1, time-boxed"]
 *   trail --> export["stolos audit export: a package to verify offline"]
 * ```
 *
 * ## 1. Open an engagement
 *
 * ```bash
 * deno task stolos audit open soc2-2026 --firm "Example CPA" --auditor "Dana Example <dana@example.com>" \
 *   --from 2026-01-01 --to 2026-06-30 --framework soc2 --expires 2026-09-30 \
 *   --controls "CC6.2=leavers,CC6.1=mfa,CC8.1=change,CC6.3=access-reviews"
 * deno task stolos evidence export --from 2026-01-01 --to 2026-06-30
 * deno task stolos audit bundle soc2-2026 <the bundle's path>
 * ```
 *
 * The engagement is `fleets/<fleet>/audits/<id>/engagement.ts`: the firm and its people, the
 * period, the frameworks, the controls in scope (each with the population it is tested on), the
 * evidence bundle (pinned by its SHA-256), and the last day of the auditor's access. Each audit
 * command makes one commit of the engagement's files, signed with your daily key; push it as any
 * change (`stolos apply`). `audit access` moves the last day; `audit close` ends the engagement.
 *
 * ## 2. Populations
 *
 * Each control is tested on a population computed from the pinned bundle, never from this PC's
 * live state, so the auditor gets the same units and the same population hash from the bundle
 * alone:
 *
 * | Population       | One unit is                                    |
 * | ---------------- | ---------------------------------------------- |
 * | `change`         | a commit to the fleet repository in the period |
 * | `leavers`        | a person whose employment ended in the period  |
 * | `mfa`            | an active account (not a service account)      |
 * | `devices`        | a device, or a machine Stolos adopted          |
 * | `repositories`   | a code repository                              |
 * | `access-reviews` | a manager's quarterly access review            |
 * | `verify`         | a managed server's verify or install result    |
 *
 * Each unit names the bundle items that are its evidence, by SHA-256.
 *
 * ## 3. Samples
 *
 * The auditor chooses the sample size (by their firm's methodology) and gives a seed: any text,
 * such as a number they picked or a public randomness beacon's value they chose. Stolos draws by
 * simple random sampling without replacement with random sort keys (each unit's key is
 * `sha256(seed + newline + unit id)`; the sample is the units with the smallest keys), so the
 * auditor redraws it with a shell:
 *
 * ```bash
 * deno task stolos audit sample soc2-2026 --control CC6.2 --seed 734019 --size 5
 * ```
 *
 * The sample, the seed, the method, and the population's hash are recorded in the trail.
 *
 * ## 4. Requests and responses
 *
 * ```bash
 * deno task stolos audit request soc2-2026 --by "Dana Example" --control CC6.2 --text "For each sampled leaver: ..."
 * deno task stolos audit respond soc2-2026 --re 3 --text "Each sample's evidence is on its page ..."
 * ```
 *
 * Each is a numbered file in `audits/<id>/trail/`, added in a signed commit whose trailer names the
 * file's SHA-256: the signature covers the exact text. The portal shows them in order, each with
 * its commit and signer.
 *
 * ## 5. The portal
 *
 * ```bash
 * deno task stolos audit portal soc2-2026
 * ```
 *
 * It starts the Stolos Console on 127.0.0.1 and prints a link that works once, for two minutes,
 * and opens a session that sees only this engagement, read-only, for at most four hours. Every
 * page refuses once the engagement has expired or been closed. The auditor sees each control's
 * population, each sample's evidence items with their SHA-256 and place in the signed manifest,
 * and `verifyBundle`'s result, and downloads any item or the whole bundle. The same data is JSON
 * under `/v1/audit/<id>/` (in the console's OpenAPI document).
 *
 * ## 6. A remote auditor: the export package
 *
 * The console answers only on this PC. For an auditor elsewhere, send the export package:
 *
 * ```bash
 * deno task stolos audit export soc2-2026
 * deno task stolos audit verify lab-audit-soc2-2026.zip   # the auditor, offline
 * ```
 *
 * It holds the bundle, engagement.ts and every trail entry with the raw signed commit that recorded
 * it, the populations, the fleet's signers, and the portal as one static page. `audit verify`
 * checks the bundle, every commit's trailer and signature, and recomputes every population and
 * redraws every sample; its README says how to do the same by hand. The package is not
 * time-boxed: sending it is your decision.
 *
 * @module
 */

export type { Auditor, Engagement, PinnedBundle, ScopedControl } from "./engagement.ts";
export type { PopulationId } from "./populations.ts";
export type { SampleRecord } from "./sample.ts";
export type { TrailEntry } from "./trail.ts";
