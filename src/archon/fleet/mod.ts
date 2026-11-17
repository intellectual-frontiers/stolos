/**
 * # The fleet repository: pin, lock, upgrade
 *
 * This guide is for whoever looks after a fleet repository (for example `example-org/fleet`): the private
 * repository that holds your fleets and that every host checks out at `/srv/archon`. Read it once
 * before your first engine upgrade; keep it at hand for the troubleshooting table at the end.
 *
 * ## What is in a fleet repository
 *
 * ```
 * package.json  the pin: which engine version this repository uses (the engine by Git at its tag),
 *               and the commands `bun run stolos` and `bun run archon`
 * bun.lock      the commit that tag names, and the integrity (SHA-512) of that commit's archive
 * stolos.ts     stolos, the fleet's command on your PC (bun run stolos; two lines: the pinned engine)
 * archon.ts     archon, each machine's command (/usr/local/bin/archon runs it; two lines, the same way)
 * .gitignore    out/ and node_modules/ (where bun install puts the engine)
 * fleets/<id>/  one folder per fleet: fleet.ts, site.ts, signers.ts, hosts/<host>/host.ts, ...
 * ```
 *
 * Nothing here is the engine itself. The engine lives in the public repository
 * `intellectual-frontiers/stolos`; each version is a tag of it (`v<version>`), and `bun install`
 * puts the engine at that tag in `node_modules/`, as its TypeScript sources. There is no GitHub
 * release and nothing to build: Bun runs the sources, and Node 26 runs them with commons' hook
 * (`node --import @intellectual-frontiers/commons/ts/node stolos.ts`).
 *
 * ## Starting a new fleet repository
 *
 * You need Bun, git, and `gh` signed in (`gh auth login`). Create an empty private repository on
 * GitHub, clone it, and from inside the clone run the engine once at a version tag (replace
 * `<version>` with the newest tag of `intellectual-frontiers/stolos`):
 *
 * ```
 * bun add github:intellectual-frontiers/stolos#v<version>
 * bun node_modules/@intellectual-frontiers/stolos/src/stolos/main.ts fleet init lab
 * ```
 *
 * `fleet init lab` writes `package.json` pinned to that same tag (the commands `stolos` and
 * `archon`), `stolos.ts`, `archon.ts` and `.gitignore`, runs `bun install` (which writes `bun.lock`),
 * then `fleets/lab/fleet.ts` from your GitHub identity. It asks for your Unix account name and an admin password; only the password's hash is
 * kept, on your machine, never in Git. From then on use the pinned engine through the tasks:
 *
 * ```
 * bun run stolos keys setup       # your signing keys (see Signing below)
 * bun run stolos host add <name> --claim  # the first host (or --mac-address <mac>)
 * ```
 *
 * A second fleet in the same repository is one more `bun run stolos fleet init <id>`. When the
 * repository holds more than one fleet, choose the one this checkout works on, once:
 * `bun run stolos fleet use lab` (remembered in `.git`, never committed; `fleet init` chooses the
 * fleet it creates). For one command, `--fleet <id>` (or `ARCHON_FLEET`) chooses another, for example
 * `bun run stolos boot serve --fleet lab`. Files that already exist are never overwritten by
 * `fleet init`.
 *
 * ## Why the pin and the lock matter (security, not only tidiness)
 *
 * Every host runs `archon` as root, so whatever code it runs can do anything on that host. That code
 * comes from two places:
 *
 * 1. **This repository.** A host only moves to a commit at the tip of `main` that is **signed** by one
 *    of the fleet's signers (`fleets/<id>/signers.ts`, `stolos signers`). Pushing an unsigned commit
 *    does nothing: every host refuses it and says so in its journal.
 * 2. **The engine.** It is downloaded from GitHub, the engine's repository at its tag
 *    (`github:intellectual-frontiers/stolos#<tag>`). Your signature does not reach the engine by
 *    itself: it is not in this repository.
 *
 * `bun.lock` is what joins the two. It is a file in this repository, so it is covered by your
 * signature, and it holds the commit the tag named and the integrity of that commit's archive.
 * Hosts install the engine with `bun install --frozen-lockfile`: they fetch that commit, not
 * whatever the tag names today, and if what they download differs from the lock (a moved tag, a
 * compromised GitHub account, an altered file on the way), Bun refuses to install it. The host
 * stays on the commit it runs; it does not run unapproved code.
 *
 * So: **never drop `--frozen-lockfile`, never hand-edit `bun.lock`, and never change the pin without
 * `stolos fleet upgrade`.** If something about the lock is in your way, the table at the end says what
 * it means and what to do.
 *
 * ## The pin
 *
 * `package.json` holds one dependency:
 *
 * ```json
 * {
 *   "dependencies": {
 *     "@intellectual-frontiers/stolos": "github:intellectual-frontiers/stolos#v0.8.0"
 *   }
 * }
 * ```
 *
 * `v0.8.0` is the engine version. Engine versions only go up (0.7.0, 0.8.0, 0.9.0, ...); each one is a
 * tag that the engine's CI made after its checks passed (and after installing that commit as you do,
 * and running it on Bun and on Node). The tag is the release: there is nothing else to download.
 * The installed package's own `package.json` says the same version: that is how `fleet upgrade` knows
 * a tag is a real version.
 *
 * ## Upgrading the engine (the only supported way)
 *
 * Do this on the boot machine or your workstation, in your clone of the fleet repository, with your
 * signing key at hand (you will type its passphrase once).
 *
 * 1. **Pick the version.** The engine's tags are listed at
 *    <https://github.com/intellectual-frontiers/stolos/tags>; its commit messages and specifications
 *    (`specs/`) say what changed. Prefer the newest tag whose end-to-end run (the `e2e` workflow)
 *    passed.
 * 2. **Start clean and current:**
 *
 *    ```sh
 *    git pull
 *    git status          # must show nothing to commit
 *    ```
 *
 * 3. **Upgrade:**
 *
 *    ```sh
 *    bun run stolos fleet upgrade v0.8.0
 *    ```
 *
 *    It prints one line per step:
 *
 *    - **Engine version**: the tag is a version, and newer than the current pin (going back needs
 *      `--downgrade`, on purpose).
 *    - **Lock**: the pin moves and `bun install` downloads the engine at that tag and records its
 *      commit and integrity in `bun.lock`; the installed package must say it is that version.
 *    - **Validate**: every fleet in the repository is validated with the new engine. If one fails,
 *      nothing is committed; the message says how to see why, and how to stay on the old version.
 *    - **Commit**: one signed commit of `package.json` and `bun.lock`, with the subject
 *      `stolos v0.8.0: adopt the engine v0.8.0`. Git asks for your key's passphrase here.
 *
 * 4. **Approve it by pushing** (spec 060: the signed commit is checked and pushed):
 *
 *    ```sh
 *    bun run stolos apply
 *    ```
 *
 * 5. **Watch the hosts move** (each one within 15 minutes, or at once with `archon update` on it):
 *
 *    ```sh
 *    bun run stolos fleet status
 *    ```
 *
 * To review before committing, add `--no-commit`: the files change, and you commit yourself with
 * `git commit -S`. Never commit without `-S` (or `commit.gpgsign=true`): an unsigned tip is refused by
 * every host.
 *
 * ## The synthetic fleet: test before a real server
 *
 * A fleet repository can hold a **synthetic fleet**: a fleet made for the end-to-end lab, shaped like
 * your real one (the same providers, mail and web settings, capabilities), with made-up hosts. GitHub
 * Actions installs its server from a blank Secure Boot VM with the engine your `package.json` pins,
 * reboots it, and sets up its workstation, which then reaches the server over MCP. When that passes,
 * the same engine version and the same kind of model are ready for a physical server.
 *
 * A synthetic fleet differs from a real one in three places, so the lab can run it:
 *
 * ```ts ignore
 * // fleets/<id>/fleet.ts
 * const E2E_ADMIN_KEY = "ssh-ed25519 AAAA..."; // each run replaces it with its own key
 * // ...
 * repository: { slug: "<owner>/<repo>", url: "http://10.77.0.1:8000/fleet.git" }, // the lab serves it
 * admin: { user: "uat", uid: 1000, github: { /* ... *\/ sshKeys: [E2E_ADMIN_KEY] } },
 * // fleets/<id>/hosts/<server>/host.ts
 * mac: "52:54:00:12:34:56", // the lab's VM
 * ```
 *
 * Each run makes its own signer, admin password hash, and the server's host keys, signs the fleet's
 * tip, and throws all of them away: nothing secret is stored in the repository or in GitHub. Use
 * `providers: { acme: "letsencrypt-staging" }` and documentation domains (`example.net`) so nothing
 * reaches a real provider.
 *
 * The workflow in the fleet repository calls the engine's, at the same tag as the pin
 * (`archon fleet
 * upgrade` moves both):
 *
 * ```yaml
 * # .github/workflows/e2e.yml
 * on: { workflow_dispatch: {} } # by hand: a private repository's runs cost Actions minutes
 * jobs:
 *   e2e:
 *     uses: intellectual-frontiers/stolos/.github/workflows/fleet-e2e.yml@v0.14.0
 *     with: { fleet: synthetic-uat, server: e2e-server-uat, workstation: e2e-workstation-uat }
 * ```
 *
 * **How the server is installed in the lab.** A private repository's runners have 8 GB of memory, too
 * little for Ubuntu's network installer (it holds the whole installer image in memory) next to the
 * runner itself. There, the lab starts the server from Ubuntu's cloud image and finishes it with
 * `stolos host bootstrap`, the path for a server installed by hand: the same first boot, fleet,
 * signers, and registered SSH host keys. The engine's own lab (public, 16 GB runners) runs the full
 * network install, Secure Boot and all, on every engine release.
 *
 * **Cost.** A run in a private repository takes about 8 minutes of a Linux runner, counted against the
 * GitHub account's included Actions minutes (2,000 a month on the Free plan, 3,000 on Pro); beyond
 * them, GitHub charges only if you set a budget above zero. Run it by hand, for difficult or major
 * changes (install, identity, boot); simple ones are proven in the engine's public lab and then on the
 * real machines. Check usage under Settings, Billing and licensing.
 *
 * ## Registration: who each host is
 *
 * `stolos host add <host>` writes `fleets/<id>/hosts/<host>/registration.ts`: the host's SSH host
 * **public** keys (the private halves stay on the boot machine and in its backup ZIP), its network
 * card, and its deploy key's fingerprint. Commit it with the host's `host.ts`.
 *
 * Your machine checks every server against those keys, so a first connection is never trusted blindly:
 * `stolos fleet status` and `stolos fleet query` do it on their own, and once on each workstation (and
 * again after a host is added) run
 *
 * ```sh
 * bun run stolos fleet trust     # writes the registered keys into your known_hosts
 * ```
 *
 * so plain `ssh <host>` and your MCP client check the same keys. If ssh ever says a host's key
 * changed, do not accept it: compare with `registration.ts`, and ask whoever looks after the boot
 * machine.
 *
 * ## Decisions: what is on, on each host
 *
 * Opt-ins (PostgreSQL, S3, SMB shares, the telemetry web UI) are off on every server until someone
 * turns one on. Record that decision in Git, from your workstation, so it is approved like any other
 * change and survives a re-install:
 *
 * ```sh
 * bun run stolos decide pg on --durable --host olympia     # or --ephemeral; off to turn it off
 * bun run stolos apply -m "fcr decide: pg on on olympia"     # one signed commit, verified, pushed
 * ```
 *
 * It writes `fleets/<id>/hosts/<host>/decisions.ts`; the host applies it within 15 minutes. A decision
 * in Git wins over anything recorded on the host itself. **Durable or ephemeral** matters: durable
 * data is backed up, and the boot machine refuses to re-install a durable host unless a person types
 * `--confirm-destroy <host>` (Article 23); going from durable to ephemeral needs the same.
 *
 * Running `archon pg on` (and the others) on the host itself still works, but only that machine
 * remembers it; it tells you the `stolos decide` line that records it in Git.
 *
 * ## Tags: what each machine is (spec 108-tags)
 *
 * A fleet describes its machines with **tags** it defines itself, in `fleets/<id>/tags.ts` (a new fleet
 * gets a starter kit: an environment, a role, a site, an owner, a criticality and a data class). A tag is
 * `<dimension>:<value>` (`env:prod`); a one-of dimension holds one value per machine, a many-of one
 * (`role`) any number. A tag the file does not define is a type error where it is written and a problem
 * of `stolos build`. Machines (managed servers and workstations, adopted machines, the controller) get
 * tags from a person, from a rule, or from a group, and each tag shows which:
 *
 * ```sh
 * bun run stolos tag add alpha env:prod role:web     # one signed commit (decisions.ts or machine.ts)
 * bun run stolos tag add alpha pilot                 # a free-form tag: always shown as custom
 * bun run stolos tag list --select 'env:prod and not role:database'
 * bun run stolos fleet query "select * from uptime" --tag env:prod
 * bun run stolos pair --tag env:lab --tag role:nas   # every machine paired in the session
 * ```
 *
 * A rule in `tags.ts` gives a defined tag from what Stolos knows of a machine (`osIs("windows")`,
 * `addressIn("10.0.1.0/24")`), a group gives its tags to a site network or named machines; a tag a person
 * gave wins over a rule's, and a rule's over a group's. The Stolos Console draws a chip for every tag,
 * filters and groups the machines by them, and picks the machines for "Ask every machine".
 *
 * ## Signing: your keys (spec 057)
 *
 * Each operator signs with their own key, listed in the fleet's `signers.ts`. The key is a file,
 * protected by a passphrase that you type and never store; it is never loaded into an ssh-agent, so
 * nothing on your machine (an agent included) can sign without you. One command sets it all up, and
 * can be run again at any time (it does only what is missing, and never overwrites a key):
 *
 * ```sh
 * bun run stolos keys setup     # keys, Git's signing (this repository only), signers.ts, the push check
 * bun run stolos keys           # every check, each with its fix; boot doctor shows the same
 * ```
 *
 * `keys setup` makes your **daily** key (`~/.ssh/fleet-signing`) and a **recovery** key in this PC's
 * key store (`%APPDATA%\stolos\keys`; Linux and macOS: `~/.config/stolos/keys`), each locked by its
 * own passphrase. Every backup (`bun run stolos vault backup`) holds both keys with every secret, so
 * one ZIP is everything a disaster needs: keep it somewhere safe and encrypted, since with it and your
 * passphrases anyone could change your servers. Prove the recovery key still works twice a year
 * (`stolos keys` reminds you):
 *
 * ```sh
 * bun run stolos keys check-recovery
 * ```
 *
 * The pre-push check `keys setup` installs refuses, on your PC, a push that servers would refuse (an
 * unsigned commit, or one signed by a key `signers.ts` does not list), with the fix.
 *
 * | When                                                 | Run                                                                              |
 * | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
 * | a new PC, or anything is wrong                       | `bun run stolos keys setup`                                                    |
 * | a planned change of key (yearly, or a new PC)        | `bun run stolos keys rotate` (approved by the current key), then `bun run stolos apply` |
 * | the daily key is lost                                | `bun run stolos keys lost` (approved by the recovery key), `bun run stolos apply` |
 * | the daily key may have been copied (a stolen laptop) | the same, with `--stolen`                                                        |
 * | a new recovery key (yearly)                          | `bun run stolos keys rotate-recovery` (approved by the old recovery key), `bun run stolos apply` |
 *
 * Each of them continues where it stopped if interrupted. A new person becomes a signer when someone
 * already listed adds them and signs that commit:
 *
 * ```sh
 * bun run stolos signers add <name> --role daily --key <their .pub file>
 * bun run stolos apply -m "<fleet> signers: add <name>"
 * ```
 *
 * ## Troubleshooting
 *
 * | What you see                                                                           | What it means                                                                          | What to do                                                                                                                                                                                          |
 * | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | `bun install --frozen-lockfile` fails with an integrity error (E046-LOCK-INTEGRITY) | the engine fetched differs from its commit or integrity in `bun.lock` | Stop. Do not regenerate the lock to make it go away. Tell the engine's maintainers; compare the commit with the engine's history. Only after you know why: `stolos fleet upgrade` to a known-good tag. |
 * | `Lock: the engine at vX could not be installed` | the tag does not exist, or is misspelled | pick a tag from the engine's tags page |
 * | `Lock: vX's package says it is ...: not that version` | the tag names a commit whose package is another version | pick another tag; tell the engine's maintainers |
 * | `vX is older than the pinned vY`                                                       | going backwards                                                                        | if you mean it, add `--downgrade` (and say why in the commit)                                                                                                                                       |
 * | `the repository has uncommitted changes`                                               | the upgrade must be a commit of its own                                                | commit or stash your other change first                                                                                                                                                             |
 * | `Validate: fleet <id> does not validate with vX`                                       | the new engine expects something your model lacks                                      | run `ARCHON_FLEET=<id> bun run stolos validate`, fix the model in its own commit, then upgrade again                                                                                              |
 * | `Commit: the commit was not made`                                                      | signing failed or was cancelled                                                        | `bun run stolos keys` shows what is missing in your setup                                                                                                                                         |
 * | a host's journal says `refused ...: not signed` (`journalctl -t archon-approval`)      | someone pushed an unsigned tip                                                         | approve it with a signed commit on top (`git commit -S --allow-empty -m "approve"`, then `bun run stolos apply`, only if the unsigned work is right)                                                                                         |
 *
 * @module
 */
// Spec: 108-tags FR-006, FR-007

export {};
