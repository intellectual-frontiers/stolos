/**
 * # People controls
 *
 * Joiners and leavers, quarterly access reviews, policies, training, and screening, kept the Git
 * way and checked on the estate graph (spec 077). The HR system says who works here, who reports to
 * whom, and who left; every connected system says which accounts exist. Stolos compares them, and
 * what a person must sign (an access review, a policy) is a signed commit in the fleet repository.
 *
 * ```mermaid
 * flowchart LR
 *   hr["HR system: people, managers, end dates"] --> estate[("estate graph")]
 *   sys["identity, code, cloud, SaaS: accounts"] --> estate
 *   files["fleets/&lt;fleet&gt;/people/ and policies/"] --> controls["people controls"]
 *   estate --> controls
 *   git["Git: signed commits, observation history"] --> controls
 *   controls --> status["stolos people status"] & compliance["stolos compliance: the People pack"]
 *   estate --> review["stolos people review: one file per manager, a pull request"]
 *   review --> git
 * ```
 *
 * ## Joiners and leavers
 *
 * - **Leavers**: a person the HR system marks as terminated with an account that can still sign in
 *   fails the estate's own check, `leavers` (SCF IAC-04).
 * - **Joiners**: `fleets/<fleet>/people/roles.ts` names the connected systems each role needs (the
 *   HR system's role, such as employee or contractor, or `"*"` for everyone). An active person
 *   without one of them is named (IAC-04, HRS-08). A system that is not connected is not asked for.
 * - **On leave**: the active accounts of people on leave are named (IAC-08, HRS-08); record a
 *   decision to keep them open in `controls/accepted.ts` as `people/on-leave`.
 * - **Time to deprovision**: for each leaver's account, how many days it stayed active after the
 *   end date, from the history of the observations in Git (the last observation in which it could
 *   sign in). More than a day is a warning (HRS-12).
 *
 * ```ts
 * // fleets/<fleet>/people/roles.ts
 * export const roles = {
 *   "*": ["google", "onepassword"],
 *   employee: ["github"],
 * };
 * ```
 *
 * ## Access reviews
 *
 * ```bash
 * deno task stolos people review --quarter 2026-Q4
 * ```
 *
 * Writes `people/reviews/<quarter>/<manager>.md` for each manager (from the HR system's reporting
 * lines): each report's active accounts, and which are administrators, one unticked line each. It
 * commits them, signed, on the branch `people/review-<quarter>`, pushes it, and opens a pull request
 * with `gh`. `--check` shows what it would write; `--local` commits without pushing.
 *
 * The manager ticks each line they confirm (`- [x]`), removes in the system itself any access they
 * do not, and commits the file signed with their own key, or asks a fleet signer to. That commit is
 * the approval; a later signed commit with the trailer `Access-Review: <quarter>/<manager>` approves
 * a file as it stands. Merge the pull request so the commits are kept (a merge commit or a
 * fast-forward, never a squash or a rebase), then `deno task stolos apply` as usual.
 *
 * The check `people/access-reviews` (IAC-12) passes when every manager has an approved review for
 * the last quarter that ended. Each review's file and its signed commit are evidence by themselves:
 * `deno task stolos evidence export` puts both in the bundle for the quarters of its period.
 *
 * A manager's own key is in `fleets/<fleet>/people/keys.ts`, by work email (the email is the
 * principal Git verifies the signature against):
 *
 * ```ts
 * // fleets/<fleet>/people/keys.ts
 * export const keys = {
 *   "bob@example.org": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExample",
 * };
 * ```
 *
 * Adding a key is a change like any other: a commit a fleet signer signs.
 *
 * ## Policies
 *
 * Each policy is Markdown in `fleets/<fleet>/policies/<policy>.md`, with front matter:
 *
 * ```markdown
 * ---
 * title: Acceptable use
 * version: 1.2
 * owner: alice@example.org
 * review: 2027-06-30
 * ---
 * ```
 *
 * `review` is the date by which it must next be reviewed; after it, `people/policy-reviews` fails
 * (GOV-04.1). Everyone acknowledges each current version:
 *
 * ```bash
 * deno task stolos people ack acceptable-use
 * ```
 *
 * adds you to `policies/acks/acceptable-use.ts` and commits it, signed with your own key (the one
 * in `people/keys.ts`), with the trailer `Acknowledges: acceptable-use@1.2`. The signed commit is
 * the e-signature: a line in the acks file without one does not count. `people/policy-acks`
 * (HRS-08.2) fails while an active person owes an acknowledgement of a current version.
 *
 * ## Training and screening
 *
 * The records, with no more than a control needs (never a screening's details):
 *
 * ```ts
 * // fleets/<fleet>/people/training.ts
 * export const training = [
 *   { email: "alice@example.org", course: "security awareness", date: "2026-03-02", result: "passed" },
 * ];
 * ```
 *
 * ```ts
 * // fleets/<fleet>/people/screening.ts
 * export const screening = [
 *   { email: "alice@example.org", check: "background", date: "2025-01-10", result: "clear" },
 * ];
 * ```
 *
 * `people/training` (SAT-04, SAT-10) fails for an active person with no passed training in the last
 * 12 months; `people/screening` (HRS-05) for one with no screening on file, or none clear. A
 * connector that reads a learning system or a screening provider supplies records labeled
 * `person_record` (with `kind`: training or screening) and the checks read them too.
 *
 * ## Commands
 *
 * ```bash
 * deno task stolos people status
 * deno task stolos people review --quarter 2026-Q4
 * deno task stolos people ack acceptable-use
 * ```
 *
 * `people status` runs every check now and lists each leaver account's time to deprovision; with
 * people files kept, the same checks show in `deno task stolos compliance` as the People pack.
 *
 * @module
 */

export {
  type Policy,
  type PolicyAck,
  type RoleMap,
  type ScreeningRecord,
  type TrainingRecord,
} from "./records.ts";
export { peopleControls, type PeopleFacts, peoplePack } from "./controls.ts";
