# The fleet repository: pin, lock, upgrade

This guide is for whoever looks after a fleet repository (for example `shah/fleet`): the private
repository that holds your fleets and that every host checks out at `/srv/archon`. Read it once
before your first engine upgrade; keep it at hand for the troubleshooting table at the end.

## What is in a fleet repository

```
deno.json     the pin: which engine version this repository uses (@stolos/ → a tagged URL)
deno.lock     a SHA-256 hash of every file of that engine version
stolos.ts     stolos, the fleet's command on your PC (deno task stolos; two lines: the pinned engine)
archon.ts     archon, each machine's command (/usr/local/bin/archon runs it; two lines, the same way)
engine.ts     names every engine module, so deno.lock covers all of them
fleets/<id>/  one folder per fleet: fleet.ts, site.ts, signers.ts, hosts/<host>/host.ts, ...
```

Nothing here is the engine itself. The engine lives in the public repository
`intellectual-frontiers/stolos` and is downloaded, by version, from GitHub.

## Starting a new fleet repository

You need Deno, git, and `gh` signed in (`gh auth login`). Create an empty private repository on
GitHub, clone it, and from inside the clone run the engine once straight from its released URL
(replace `v<version>` with the latest tag on `intellectual-frontiers/stolos`):

```
deno run -A https://raw.githubusercontent.com/intellectual-frontiers/stolos/v<version>/src/stolos/main.ts fleet init lab
```

`fleet init lab` writes `deno.json` pinned to that same tag (one task: `stolos`), `stolos.ts`,
`archon.ts`, `engine.ts`, `.gitignore`, and `deno.lock`, then `fleets/lab/fleet.ts` from your GitHub
identity. It asks for your Unix account name and an admin password; only the password's hash is
kept, on your machine, never in Git. From then on use the pinned engine through the tasks:

```
deno task stolos keys setup       # your signing keys (see Signing below)
deno task stolos host add <name> --claim  # the first host (or --mac-address <mac>)
```

A second fleet in the same repository is one more `deno task stolos fleet init <id>`. When the
repository holds more than one fleet, choose the one this checkout works on, once:
`deno task stolos fleet use lab` (remembered in `.git`, never committed; `fleet init` chooses the
fleet it creates). For one command, `--fleet <id>` (or `ARCHON_FLEET`) chooses another, for example
`deno task stolos boot serve --fleet lab`. Files that already exist are never overwritten by
`fleet init`.

## Why the pin and the lock matter (security, not only tidiness)

Every host runs `archon` as root, so whatever code it runs can do anything on that host. That code
comes from two places:

1. **This repository.** A host only moves to a commit at the tip of `main` that is **signed** by one
   of the fleet's signers (`fleets/<id>/signers.ts`, `stolos signers`). Pushing an unsigned commit
   does nothing: every host refuses it and says so in its journal.
2. **The engine.** It is fetched from
   `https://raw.githubusercontent.com/intellectual-frontiers/stolos/<tag>/src/`. Your signature does
   not reach those files by itself: they are not in this repository.

`deno.lock` is what joins the two. It is a file in this repository, so it is covered by your
signature, and it holds the hash of every engine file. Hosts run the engine with `--frozen`: if any
engine file they download differs from its hash (a moved tag, a compromised GitHub account, an
altered file on the way), Deno refuses to run it. The host stops; it does not run unapproved code.

So: **never delete `--frozen`, never hand-edit `deno.lock`, and never change the pin without
`stolos fleet upgrade`.** If something about the lock is in your way, the table at the end says what
it means and what to do.

## The pin

`deno.json` holds one mapping:

```json
{
  "imports": {
    "@stolos/": "https://raw.githubusercontent.com/intellectual-frontiers/stolos/v0.8.0/src/"
  }
}
```

`v0.8.0` is the engine version. Engine versions only go up (0.7.0, 0.8.0, 0.9.0, ...); each one is a
tag that the engine's CI made after its checks passed. The engine's own `src/archon/version.ts` at
that tag says the same version: that is how `fleet upgrade` knows a tag is a real release.

## Upgrading the engine (the only supported way)

Do this on the boot machine or your workstation, in your clone of the fleet repository, with your
signing key at hand (you will type its passphrase once).

1. **Pick the version.** The engine's tags are listed at
   <https://github.com/intellectual-frontiers/stolos/tags>; its commit messages and specifications
   (`specs/`) say what changed. Prefer the newest tag whose end-to-end run (the `e2e` workflow)
   passed.
2. **Start clean and current:**

   ```sh
   git pull
   git status          # must show nothing to commit
   ```

3. **Upgrade:**

   ```sh
   deno task stolos fleet upgrade v0.8.0
   ```

   It prints one line per step:

   - **Engine version**: the tag is a release, and newer than the current pin (going back needs
     `--downgrade`, on purpose).
   - **Lock**: the pin moves, `engine.ts` is checked, and `deno.lock` is built again: the engine is
     downloaded and every file hashed.
   - **Validate**: every fleet in the repository is validated with the new engine. If one fails,
     nothing is committed; the message says how to see why, and how to stay on the old version.
   - **Commit**: one signed commit of `deno.json`, `deno.lock`, and `engine.ts`, with the subject
     `stolos v0.8.0: adopt the engine v0.8.0`. Git asks for your key's passphrase here.

4. **Approve it by pushing:**

   ```sh
   git push
   ```

5. **Watch the hosts move** (each one within 15 minutes, or at once with `archon update` on it):

   ```sh
   deno task stolos fleet status
   ```

To review before committing, add `--no-commit`: the files change, and you commit yourself with
`git commit -S`. Never commit without `-S` (or `commit.gpgsign=true`): an unsigned tip is refused by
every host.

## The synthetic fleet: test before a real server

A fleet repository can hold a **synthetic fleet**: a fleet made for the end-to-end lab, shaped like
your real one (the same providers, mail and web settings, capabilities), with made-up hosts. GitHub
Actions installs its server from a blank Secure Boot VM with the engine your `deno.json` pins,
reboots it, and sets up its workstation, which then reaches the server over MCP. When that passes,
the same engine version and the same kind of model are ready for a physical server.

A synthetic fleet differs from a real one in three places, so the lab can run it:

```ts
// fleets/<id>/fleet.ts
const E2E_ADMIN_KEY = "ssh-ed25519 AAAA..."; // each run replaces it with its own key
// ...
repository: { slug: "<owner>/<repo>", url: "http://10.77.0.1:8000/fleet.git" }, // the lab serves it
admin: { user: "uat", uid: 1000, github: { /* ... */ sshKeys: [E2E_ADMIN_KEY] } },
// fleets/<id>/hosts/<server>/host.ts
mac: "52:54:00:12:34:56", // the lab's VM
```

Each run makes its own signer, admin password hash, and the server's host keys, signs the fleet's
tip, and throws all of them away: nothing secret is stored in the repository or in GitHub. Use
`providers: { acme: "letsencrypt-staging" }` and documentation domains (`example.net`) so nothing
reaches a real provider.

The workflow in the fleet repository calls the engine's, at the same tag as the pin
(`archon fleet
upgrade` moves both):

```yaml
# .github/workflows/e2e.yml
on: { workflow_dispatch: {} } # by hand: a private repository's runs cost Actions minutes
jobs:
  e2e:
    uses: intellectual-frontiers/stolos/.github/workflows/fleet-e2e.yml@v0.14.0
    with: { fleet: synthetic-uat, server: e2e-server-uat, workstation: e2e-workstation-uat }
```

**How the server is installed in the lab.** A private repository's runners have 8 GB of memory, too
little for Ubuntu's network installer (it holds the whole installer image in memory) next to the
runner itself. There, the lab starts the server from Ubuntu's cloud image and finishes it with
`stolos host bootstrap`, the path for a server installed by hand: the same first boot, fleet,
signers, and registered SSH host keys. The engine's own lab (public, 16 GB runners) runs the full
network install, Secure Boot and all, on every engine release.

**Cost.** A run in a private repository takes about 8 minutes of a Linux runner, counted against the
GitHub account's included Actions minutes (2,000 a month on the Free plan, 3,000 on Pro); beyond
them, GitHub charges only if you set a budget above zero. Run it by hand, for difficult or major
changes (install, identity, boot); simple ones are proven in the engine's public lab and then on the
real machines. Check usage under Settings, Billing and licensing.

## Registration: who each host is

`stolos host add <host>` writes `fleets/<id>/hosts/<host>/registration.ts`: the host's SSH host
**public** keys (the private halves stay on the boot machine and in its backup ZIP), its network
card, and its deploy key's fingerprint. Commit it with the host's `host.ts`.

Your machine checks every server against those keys, so a first connection is never trusted blindly:
`stolos fleet status` and `stolos fleet query` do it on their own, and once on each workstation (and
again after a host is added) run

```sh
deno task stolos fleet trust     # writes the registered keys into your known_hosts
```

so plain `ssh <host>` and your MCP client check the same keys. If ssh ever says a host's key
changed, do not accept it: compare with `registration.ts`, and ask whoever looks after the boot
machine.

## Decisions: what is on, on each host

Opt-ins (PostgreSQL, S3, SMB shares, the telemetry web UI) are off on every server until someone
turns one on. Record that decision in Git, from your workstation, so it is approved like any other
change and survives a re-install:

```sh
deno task stolos decide pg on --durable --host olympia     # or --ephemeral; off to turn it off
git commit -S -m "fcr decide: pg on on olympia" && git push
```

It writes `fleets/<id>/hosts/<host>/decisions.ts`; the host applies it within 15 minutes. A decision
in Git wins over anything recorded on the host itself. **Durable or ephemeral** matters: durable
data is backed up, and the boot machine refuses to re-install a durable host unless a person types
`--confirm-destroy <host>` (Article 23); going from durable to ephemeral needs the same.

Running `archon pg on` (and the others) on the host itself still works, but only that machine
remembers it; it tells you the `stolos decide` line that records it in Git.

## Signing: your keys (spec 057)

Each operator signs with their own key, listed in the fleet's `signers.ts`. The key is a file,
protected by a passphrase that you type and never store; it is never loaded into an ssh-agent, so
nothing on your machine (an agent included) can sign without you. One command sets it all up, and
can be run again at any time (it does only what is missing, and never overwrites a key):

```sh
deno task stolos keys setup     # keys, Git's signing (this repository only), signers.ts, the push check
deno task stolos keys           # every check, each with its fix; boot doctor shows the same
```

`keys setup` makes your **daily** key (`~/.ssh/fleet-signing`) and a **recovery** key in this PC's
key store (`%APPDATA%\stolos\keys`; Linux and macOS: `~/.config/stolos/keys`), each locked by its
own passphrase. Every backup (`deno task stolos vault backup`) holds both keys with every secret, so
one ZIP is everything a disaster needs: keep it somewhere safe and encrypted, since with it and your
passphrases anyone could change your servers. Prove the recovery key still works twice a year
(`stolos keys` reminds you):

```sh
deno task stolos keys check-recovery
```

The pre-push check `keys setup` installs refuses, on your PC, a push that servers would refuse (an
unsigned commit, or one signed by a key `signers.ts` does not list), with the fix.

| When                                                 | Run                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| a new PC, or anything is wrong                       | `deno task stolos keys setup`                                                    |
| a planned change of key (yearly, or a new PC)        | `deno task stolos keys rotate` (approved by the current key), then `git push`    |
| the daily key is lost                                | `deno task stolos keys lost` (approved by the recovery key), push                |
| the daily key may have been copied (a stolen laptop) | the same, with `--stolen`                                                        |
| a new recovery key (yearly)                          | `deno task stolos keys rotate-recovery` (approved by the old recovery key), push |

Each of them continues where it stopped if interrupted. A new person becomes a signer when someone
already listed adds them and signs that commit:

```sh
deno task stolos signers add <name> --role daily --key <their .pub file>
git commit -m "<fleet> signers: add <name>" && git push
```

## Troubleshooting

| What you see                                                                           | What it means                                                                          | What to do                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error: ... integrity check failed` or `lockfile is out of date` when running `archon` | an engine file differs from its hash in `deno.lock` (the tag moved, or a file changed) | Stop. Do not regenerate the lock to make it go away. Tell the engine's maintainers; compare the tag with the engine's history. Only after you know why: `stolos fleet upgrade` to a known-good tag. |
| `Engine version: vX is not a released engine version`                                  | the tag does not exist, or is misspelled                                               | pick a tag from the engine's tags page                                                                                                                                                              |
| `... own version.ts says ...: not a release`                                           | the tag does not point at a release commit                                             | pick another tag; tell the engine's maintainers                                                                                                                                                     |
| `vX is older than the pinned vY`                                                       | going backwards                                                                        | if you mean it, add `--downgrade` (and say why in the commit)                                                                                                                                       |
| `the repository has uncommitted changes`                                               | the upgrade must be a commit of its own                                                | commit or stash your other change first                                                                                                                                                             |
| `Validate: fleet <id> does not validate with vX`                                       | the new engine expects something your model lacks                                      | run `ARCHON_FLEET=<id> deno task stolos validate`, fix the model in its own commit, then upgrade again                                                                                              |
| `Commit: the commit was not made`                                                      | signing failed or was cancelled                                                        | `deno task stolos keys` shows what is missing in your setup                                                                                                                                         |
| a host's journal says `refused ...: not signed` (`journalctl -t archon-approval`)      | someone pushed an unsigned tip                                                         | push a signed commit on top (`git commit -S --allow-empty -m "approve"` only if the unsigned work is right)                                                                                         |
