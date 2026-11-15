/**
 * # Clients: one PC, many client fleets
 *
 * Managed service providers and virtual CISOs look after many small companies' security. Stolos
 * lets one person do that from one PC (spec 082) while each client stays entirely its own: its own
 * fleet repository, its own vault (the secrets on this PC), and its own signers.
 *
 * ## Setting up clients
 *
 * Clone each client's fleet repository wherever you keep your work, then register each checkout
 * once:
 *
 * ```bash
 * deno task stolos clients add ../north-fleet --id north
 * deno task stolos clients add ../south-fleet --id south --title "South Example Co"
 * deno task stolos clients list
 * ```
 *
 * The registry is one file of yours (`clients.json` in Stolos's config folder: on Windows
 * `%APPDATA%\stolos`, elsewhere `~/.config/stolos`): each client's id, title, the path of its
 * checkout, and the fleet in it. It is never written into any client's repository, and it holds no
 * secret. `clients remove <id>` forgets a client and deletes nothing.
 *
 * Then any command works for one client:
 *
 * ```bash
 * deno task stolos --client north compliance
 * deno task stolos --client north evidence export --from 2026-01-01 --to 2026-06-30
 * deno task stolos --client south trust build
 * ```
 *
 * or choose a client for every command until you choose another (`--client` still wins for one
 * command; `--clear` goes back to the repository you are in):
 *
 * ```bash
 * deno task stolos clients use north
 * deno task stolos clients use --clear
 * ```
 *
 * Your signing key signs a client's commits and bundles only if that client's `signers.ts` lists
 * it: each client adds you as a signer in its own repository (`stolos signers add`, a commit signed
 * by one of its signers). One key may be on several clients' lists, or you may keep one key per
 * client (`--key` on `evidence export`).
 *
 * ## What stays apart
 *
 * `--client <id>` sets the repository, the fleet, and the client for the whole run (ARCHON_REPO,
 * ARCHON_FLEET, ARCHON_CLIENT), and every per-user folder moves under `stolos/clients/<id>/`:
 *
 * | What                                          | Where, for client `<id>`                            |
 * | --------------------------------------------- | --------------------------------------------------- |
 * | the repository, the model, rendered output     | the client's checkout                               |
 * | state: records, evidence bundles, OSCAL, logs | `<data>/stolos/clients/<id>/state/<fleet>`          |
 * | secrets (the vault)                           | `<config>/stolos/clients/<id>/secrets/<fleet>`      |
 * | the key store (recovery key)                  | `<config>/stolos/clients/<id>/keys`                 |
 * | the backup ledger                             | `<data>/stolos/vault/clients/<id>/ledger.json`      |
 * | a backup ZIP                                  | `stolos-backup-<pc>-<id>-<time>.zip`, that client's secrets only |
 *
 * The downloaded catalogs (public reference data) and the boot server's cache are shared. Two
 * clients never share a checkout: `clients add` refuses a checkout that is another client's, or
 * inside it, or holds it.
 *
 * - A bundle (`evidence export`), the OSCAL documents (`compliance export`), and the Trust Center
 *   (`trust build`) are made from one client's checkout and folders, signed by one of that client's
 *   signers; a key that is not on its list is refused.
 * - `clients report --out <folder>` writes `<folder>/<id>/` for each client (its report, its
 *   numbers, its compliance view), each read in its own scope, and refuses a folder inside any
 *   client's checkout.
 *
 * ## The summary
 *
 * `clients summary` (and the console's Clients page, and `/v1/clients`) reads each client on its
 * own and shows numbers and dates only:
 *
 * - controls passing, failing, partial, without evidence, and with stale evidence;
 * - controls changed in the last day (`--since`), and how many got worse;
 * - when anything was last observed;
 * - open POA&M items (failing checks, open risks in the register, open vulnerabilities);
 * - the date of the newest evidence bundle on this PC.
 *
 * No machine, account, check, finding, or person of any client is in it. A client that cannot be
 * read is shown as not read, with a general reason.
 *
 * ## The provider's console
 *
 * ```bash
 * deno task stolos clients console
 * ```
 *
 * It opens like the Stolos Console (127.0.0.1, a one-time launch link) on the Clients page: the
 * summary, with an Open button per client. Opening a client ends your session and starts a new one
 * for that client alone: every page, the REST API under `/v1/`, and every command you run there
 * are that client's, from its checkout, its folders, and a console of its own (its own sessions and
 * caches). The top bar names the client, with a link back to All clients. To see another client,
 * switch again: an old session's cookie stops working, so no tab left open on one client ever shows
 * another's pages.
 *
 * ```mermaid
 * flowchart LR
 *   reg["clients.json (yours)"] --> sum["Clients: numbers per client"]
 *   sum -->|"Open: a new session"| a["north: its repository, vault, signers"]
 *   sum -->|"Open: a new session"| b["south: its repository, vault, signers"]
 * ```
 *
 * The boot server's log is this PC's (installs at every client's site), so a client's Installs
 * page in the provider's console is empty; run `stolos --client <id> console` for one client's
 * console with everything.
 *
 * @module
 */

export {};
