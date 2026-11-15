# 058: `archon update` on your PC (instead of git pull)

## Why

After `git pull`, a person had to remember what else to do: notice that the engine has a newer
release and move the pin, check that what arrived is signed (or a server will refuse it), repair the
signing setup, and run the doctor. Newbies do none of that. One command should.

## Requirements

- **FR-001** On a machine that is not an installed host (no /etc/archon/fleet), `archon update` runs
  as you (the repo tier), in this order, each step idempotent:
  1. Bun is at least the pinned version (a warning with `bun upgrade`); on Node 26, the runtime and
     its version are named.
  2. Pull: fetch, then fast-forward a clean checkout. Never a merge or a rewrite: local commits that
     went another way, or uncommitted changes, are named with what to do.
  3. Approval: the pulled tip is checked against the signers the fleet had before (spec 047's check,
     as servers make it); a tip servers will refuse is a warning with its code.
  4. Engine: the newest release tag of the pinned engine repository; when newer, `fleet upgrade`
     (one signed commit, pushed by you), unless `--no-upgrade` or there are local changes; then
     `bun install --frozen-lockfile`, so the engine `bun.lock` holds is the one installed.
  5. Keys: the passphrase-free parts of `keys setup` (Git's allowed signers, the pre-push check).
  6. Doctor: `boot doctor` on a boot machine (keys included), else `archon keys`; `--no-doctor`
     skips it.
- **FR-002** On an installed host, `archon update` is spec 015's, unchanged (elevated, locked).
- **FR-003** The READMEs use `bun run stolos update` wherever they said `git pull`.

## Success criteria

- **SC-001** `tests/update058.test.ts`: a pull, an unsigned tip named, a second run that changes
  nothing, local changes never merged over.
