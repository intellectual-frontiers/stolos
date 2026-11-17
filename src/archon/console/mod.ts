/**
 * # The Stolos Console
 *
 * The fleet in your browser, on your PC only (spec 066). Every machine (managed, adopted, in a cloud),
 * the clouds, one SQL question to every machine, the changes waiting and who may approve them, and the
 * `stolos` commands as forms.
 *
 * ```bash
 * bun run stolos console
 * ```
 *
 * ```mermaid
 * sequenceDiagram
 *   participant T as Your terminal
 *   participant C as Stolos Console (127.0.0.1)
 *   participant B as Your browser
 *   T->>T: gh: may your account push to the fleet repository?
 *   T->>C: listen on 127.0.0.1:8091
 *   T->>B: open the one-time launch link
 *   B->>C: /launch?t=... (once, within two minutes)
 *   C->>B: a session cookie (HttpOnly, SameSite=Strict)
 *   B->>C: Run "apply"
 *   C->>T: bun run stolos apply (asks for a passphrase here, if it needs one)
 *   C-->>B: the output, line by line
 * ```
 *
 * ## How you sign in
 *
 * There is no password and no new key. The terminal prints a launch link that works once, for two
 * minutes; whoever can read your terminal is you. The console answers only on 127.0.0.1 and localhost
 * (another web page cannot reach it), and only forms from its own pages may run commands. With
 * `--lan` it also answers over HTTPS on the LAN, to devices a fleet signer approved with a passkey
 * (spec 100: `bun run stolos docs remote-access`).
 *
 * Before it starts, it asks GitHub (with `gh`) whether your account may push to the fleet repository:
 * the console is for the fleet's operators. Offline, `--no-github` skips that check.
 *
 * ## Passphrases and tokens
 *
 * A command that needs a secret (a signing key's passphrase, a cloud token, the backup passphrase)
 * asks for it in the terminal where the console runs, never in the browser. One command runs at a
 * time, so the terminal is never asked two things at once.
 *
 * ## What it offers, and what it does not
 *
 * | Page              | What it is for                                                                   |
 * | ----------------- | -------------------------------------------------------------------------------- |
 * | Overview          | What needs you: failing checks, failing policies, commits servers will refuse    |
 * | Machines          | Every machine, filterable by how it joined; this PC (the controller) first; CSV |
 * | Clouds            | Each cloud account's assets and posture                                          |
 * | Ask every machine | One osquery SELECT to every machine at once, one table that fills in as they answer |
 * | Changes, Trust    | What is waiting for approval, the history, and who may approve                   |
 * | Actions           | The `stolos` commands, grouped, each as a form with its output live              |
 *
 * **Ask every machine** (spec 107-pairing-and-query) asks all machines at the same time (8 at a time, 15
 * seconds each): the table, AG Grid Community vendored in this repository (`vendor/ag-grid/`, pinned by
 * its SHA-256 and served by the console itself, never from a CDN), fills in as each machine answers; a
 * machine that fails or times out has a row with its reason, and a line says "N of M answered". The
 * table pages, sorts, filters, resizes and pins columns, works from the keyboard, and exports CSV.
 *
 * The **Machines** page puts this PC first, in a **This PC** group: the controller is auto-adopted (it
 * needs no pairing and is observed by the local probe), with an "Auto-adopted, controller" badge and its
 * Release and Remove off. Every machine has a **How it joined** column and filter: auto-adopted, paired,
 * integrated, managed, or cloud.
 *
 * Commands that change keys (`keys setup`, `keys rotate`, `keys lost`) and `vault restore` stay in the
 * terminal: they are rare, and each deserves your full attention.
 *
 * ## The REST API (read-only)
 *
 * The console also answers JSON under `/v1/` (spec 094), for scripts and tools on this PC. It is
 * read-only (GET and HEAD; anything else is 405), on 127.0.0.1 only, and for the signed-in console
 * session: there are no API keys. A request without the session's cookie gets 401. A local tool
 * uses the cookie your browser holds (`stolos_session`, from the browser's developer tools).
 *
 * | Route                     | What it answers                                                       |
 * | ------------------------- | --------------------------------------------------------------------- |
 * | `/v1/`                    | What it serves                                                        |
 * | `/v1/openapi.json`        | The OpenAPI 3.1 document, generated from the estate schema            |
 * | `/v1/<table or view>`     | Every estate table and view: `{ items, limit, offset, total }`        |
 * | `/v1/finding?format=ocsf` | The findings as OCSF Compliance Findings (or `Accept: application/vnd.ocsf+json`) |
 * | `/v1/oscal/<document>`    | `component-definition`, `system-security-plan`, `assessment-results`, `poam` |
 * | `/v1/evidence/`           | The evidence bundles on this PC (`stolos evidence export`), to download |
 *
 * A list takes `limit` (default 100, at most 1000), `offset`, and an equality filter on any of its
 * columns: `?status=active`, `?admin=true`. Booleans are `true` and `false`. Every value is bound
 * as a parameter, never written into the SQL.
 *
 * ```bash
 * curl -s --cookie "stolos_session=<the cookie's value>" \
 *   "http://127.0.0.1:8091/v1/user_account?admin=true&mfa=false&limit=20"
 * ```
 *
 * @module
 */
// Spec: 100-remote-access
// Spec: 107-pairing-and-query FR-008, FR-011, FR-012

export {};
