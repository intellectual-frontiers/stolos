/**
 * # The Stolos Console
 *
 * The fleet in your browser, on your PC only (spec 066). Every machine (managed, adopted, in a cloud),
 * the clouds, one SQL question to every machine, the changes waiting and who may approve them, and the
 * `stolos` commands as forms.
 *
 * ```bash
 * deno task stolos console
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
 *   C->>T: deno task stolos apply (asks for a passphrase here, if it needs one)
 *   C-->>B: the output, line by line
 * ```
 *
 * ## How you sign in
 *
 * There is no password and no new key. The terminal prints a launch link that works once, for two
 * minutes; whoever can read your terminal is you. The console answers only on 127.0.0.1 and localhost
 * (another web page cannot reach it), and only forms from its own pages may run commands.
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
 * | Machines          | Every machine, filterable; download it as CSV, and every result with SCF as JSON |
 * | Clouds            | Each cloud account's assets and posture                                          |
 * | Ask every machine | One osquery SELECT to every machine, as one table                                |
 * | Changes, Trust    | What is waiting for approval, the history, and who may approve                   |
 * | Actions           | The `stolos` commands, grouped, each as a form with its output live              |
 *
 * Commands that change keys (`keys setup`, `keys rotate`, `keys lost`) and `vault restore` stay in the
 * terminal: they are rare, and each deserves your full attention.
 *
 * @module
 */

export {};
