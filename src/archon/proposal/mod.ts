/**
 * # Proposals: changes made on a server
 *
 * Sometimes a person changes a server directly: `sudo apt install nginx`, an edit under `/etc`,
 * `sudo systemctl enable ...`. Servers never push to GitHub and run no agent, so such a change has
 * no path into the fleet repository by itself. A **proposal** is that path (spec 095): the server
 * collects the evidence of what changed outside Stolos, adds the exact model change that would
 * adopt it, signs it with its SSH host key, and mails it to the fleet's mailbox. On your PC,
 * `stolos` verifies it and turns it into a model change that goes through the normal loop.
 *
 * ```mermaid
 * flowchart LR
 *   ops["a person on a server<br/>sudo apt install nginx ..."] --> obs["collectors<br/>(evidence, who, when)"]
 *   obs --> drift["archon drift<br/>host minus plan minus birth"]
 *   drift --> prop["archon propose<br/>a reason, signed by the host key"]
 *   prop -- "mail: text + proposal.json" --> pc["on your PC:<br/>verify, edit the model, build"]
 *   pc --> apply["stolos apply<br/>signed commit"] --> conv["the server converges<br/>drift becomes intent"]
 * ```
 *
 * ## What counts as a change outside Stolos
 *
 * Each server records evidence with Ubuntu's own tools, into its own `archon.sql` (kind
 * `observation`; ask it with `archon query "select * from archon_observation"`):
 *
 * | Source                                                       | What it shows                                                              |
 * | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
 * | sudo's entries in journald                                   | the exact command, the person, the time: who and why                       |
 * | apt's `history.log`, `dpkg.log`                              | installs and removals, with the command and who asked                     |
 * | etckeeper's history of `/etc`                                | every file change, by whom (diffs only for small files without secrets)    |
 * | osquery (packages, users, sudoers, listening ports, modules) | what changed between two looks, even what nothing logged                   |
 * | `systemctl list-unit-files`                                  | units enabled, disabled, or masked by hand                                 |
 * | snapd, podman                                                | snaps and containers                                                       |
 * | `dpkg -S` on `/usr/local` and `/opt`                         | files no package owns: flagged (Article 5: binaries only)                  |
 * | `debsums -c`, else `dpkg --verify`                           | a package's file was modified: a **security alert**, mailed, never a proposal |
 *
 * **The birth snapshot.** At install, the server records what Ubuntu put there (manual packages,
 * units, accounts, ports, `/etc` at etckeeper's first commit). Drift is what the host has, minus
 * its plan, minus that snapshot, so Ubuntu's own changes (unattended upgrades, a package's presets)
 * are never drift.
 *
 * ```mermaid
 * flowchart LR
 *   have["what the host has"] --> m1["minus the plan"] --> m2["minus the birth snapshot"] --> d["drift items<br/>(who, when, the edit that adopts each)"]
 * ```
 *
 * ## On a server
 *
 * ```sh
 * archon drift                   # what changed outside Stolos and is not proposed yet
 * sudo archon drift --collect    # read every source again first
 * archon drift --all             # also what is proposed, kept local, or rejected
 * ```
 *
 * The daily report collects every day and lists the same items. `archon drift` is read-only, so a
 * workstation's agent can call it over MCP.
 *
 * **Change sessions.** Items are grouped into one *intent* per sudo session (the same person, each
 * command within 30 minutes of the previous): "installed nginx, edited its site, enabled it, opened
 * 443" is one thing to decide. `archon drift` lists the sessions with their ids.
 *
 * ## Proposing
 *
 * Anyone with sudo on the server may propose. Choose the items, an action for each, and say why:
 *
 * ```sh
 * sudo archon propose --all --reason "nginx for the app"
 * sudo archon propose --intent s-alice-202611141500 --reason "nginx for the app"
 * sudo archon propose --item package:htop --item file:/etc/htoprc --local file:/etc/htoprc -r "debugging"
 * archon propose --all --reason "..." --dry-run   # show it; send nothing
 * ```
 *
 * | Action  | Means                                                                                                    |
 * | ------- | -------------------------------------------------------------------------------------------------------- |
 * | adopt   | put it in the model (the default)                                                                        |
 * | revert  | let Stolos converge it back; for what Archon never removes (Article 11), the proposal names the command  |
 * | local   | keep it on this server as accepted local drift, until `--until` (30 days by default); not for managed items |
 *
 * The message to the fleet's mailbox has a readable summary and two attachments: `proposal.json`
 * (format `stolos-proposal/1`: the host, the model commit it runs, the evidence, and for each item
 * the model change as structured edits such as `packages.add("nginx")` or
 * `units.enable("nginx.service")`) and `proposal.json.sig`, signed with the server's SSH host key.
 * A copy stays in `/var/lib/archon/proposals/<id>/`.
 *
 * **No secrets, ever (Article 13).** A path in the secret inventory (or secret on every host, such as
 * `/etc/shadow` or an SSH host key), and anything that looks like a key, is sent as its SHA-256 hash
 * only. A file's content is sent only when it is a small text file with nothing secret in it.
 *
 * ## Recording a change
 *
 * When you know you are about to change a server by hand, say so first:
 *
 * ```sh
 * archon record "nginx for the app"
 * sudo apt install nginx            # ... the work ...
 * archon record done                # shows what changed, as one intent
 * sudo archon propose --intent r-202611141458
 * ```
 *
 * Everything observed between the two is one intent with your reason, which also counts as the
 * proposal's written reason. One recording runs at a time; `archon record` alone shows it.
 *
 * ## The hold: a hand edit is not undone at once
 *
 * The reconcile timer applies every 15 minutes, and would undo a hand edit to something the plan
 * manages (a file a capability writes, a unit it enables or masks) before anyone could propose it.
 * So before each apply, archon reads sudo's journal: a managed item that differs from the plan and
 * that someone's sudo command named is **held**. Apply leaves it alone (it says so, with who and
 * until when) for up to 7 days, or until its proposal is decided in Git, whichever comes first;
 * proposing it as `revert` ends the hold at once. Then the model in Git wins, as always.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> held: changed under sudo
 *   held --> ended: 7 days, or revert
 *   held --> proposed: archon propose
 *   proposed --> ended: accepted or rejected in Git, or 7 days
 *   ended --> [*]: apply converges it to the model
 * ```
 *
 * ## Reminders
 *
 * The daily report and `archon doctor` count the changes not proposed yet and the proposals not
 * decided. When either has waited more than 3 days, the daily report mails a reminder (at most
 * every 3 days).
 *
 * ## On your PC
 *
 * Nothing reads the mailbox for you (no IMAP, no new credential): save the message (`.eml`), or its
 * two attachments, then in the fleet repository:
 *
 * ```sh
 * bun run stolos proposal import ~/Downloads/proposal.eml   # or the .json, or a folder
 * bun run stolos proposal list
 * bun run stolos proposal show alpha-20261114-1905-ab12      # the model diff, and any conflict
 * bun run stolos proposal accept alpha-20261114-1905-ab12
 * bun run stolos apply -m "096-alpha-nginx-for-the-app: adopt proposal alpha-20261114-1905-ab12"
 * ```
 *
 * `import` checks that the host is in the fleet and that the proposal was signed with that host's
 * SSH host key, the one already in `fleets/<fleet>/hosts/<host>/registration.ts`; a forged or
 * altered proposal is refused. Imported proposals are kept in your own state folder, not in Git.
 *
 * `accept` compares each edit with the model as it is now. What the model already has is left
 * out; what the model sets otherwise (a unit a capability masks, a file a capability writes) is a
 * **conflict**, named with the spec that owns it, and nothing is written: change that capability
 * by hand, or leave the item out with `--skip <key>`. Otherwise it:
 *
 * - adds one `adopted({...})` to the host's `capabilities` in `host.ts` (bare keys), naming the
 *   proposal and its draft spec;
 * - writes that draft spec, `fleets/<fleet>/specs/NNN-<host>-<reason>/spec.md`, from the reason and
 *   the evidence (review and edit it);
 * - records the decision in `fleets/<fleet>/hosts/<host>/proposals.ts`, with what stays local and
 *   until when;
 * - runs `stolos build`.
 *
 * You review it and run `stolos apply` (a signed commit); the server converges, and the change made
 * by hand is now intent. `bun run stolos proposal reject <id> --reason "..."` records a
 * rejection instead: after the push, the items the plan manages revert at the next apply, and
 * anything else stays flagged in `archon drift`.
 *
 * ```mermaid
 * flowchart LR
 *   mail["saved mail"] --> imp["import: verify"] --> show["show: diff, conflicts"]
 *   show --> acc["accept: host.ts, draft spec, proposals.ts, build"]
 *   show --> rej["reject: proposals.ts"]
 *   acc & rej --> apply["stolos apply"] --> host["the server converges"]
 * ```
 *
 * @module
 */

export {};
