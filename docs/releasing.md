# Changing and releasing the engine

This guide is for people who change the engine (this repository). Fleets adopt a release with
`archon fleet upgrade` (see [fleet-repository.md](fleet-repository.md)); a release is simply a
version tag that CI made.

## Every change

1. **Spec first.** Find or create `specs/NNN-short-name/spec.md` (Spec Kit; the prompts are in
   `.specify/commands/`). The commit subject starts with the spec's ID.
2. **Change the code and its tests.** TypeScript only; no fleet's data (use `examples/fleets/lab`);
   generated files are named `.auto.` and come from `deno task gen`.
3. **Raise the version.** Every push to `main` raises it, because fleets pin versions and each
   version must be one exact set of files:

   ```sh
   deno task version bump      # 0.7.0 → 0.8.0, in src/archon/version.ts
   ```

4. **Run exactly what CI runs**, and push only when it passes:

   ```sh
   deno task gen
   deno task ci                # generated files fresh, types, lint, format, tests, version newer than main
   git push
   ```

5. **Watch CI.** The `ci` workflow checks again and, when it passes, tags the commit `v<version>`.
   The `e2e` workflow installs a blank Secure Boot VM from network boot to `Ready` with this
   commit's engine; it takes a while. Tell fleet owners to prefer versions whose `e2e` run passed.

## Why tags must never move

A fleet's `deno.lock` holds the hash of every engine file at a tag. If a tag moved to other files,
every host of every fleet pinned to it would refuse to run (by design: that is the alarm). So:

- never delete or re-create a `v*` tag, and never push a tag by hand: CI makes them;
- a broken release is fixed by a newer version, never by moving its tag.

### Protecting the tags on GitHub (an owner of `intellectual-frontiers` does this once)

1. Open <https://github.com/intellectual-frontiers/stolos/settings/rules>.
2. **New ruleset → New tag ruleset.** Name: `release tags are immutable`.
3. **Enforcement status:** Active. **Bypass list:** leave empty.
4. **Target tags → Add target → Include by pattern:** `v*`.
5. **Rules:** check **Restrict updates**, **Restrict deletions**, and **Block force pushes**. Leave
   **Restrict creations** unchecked: the `ci` workflow must still be able to create new tags.
6. **Create.**

To check it: a moved or deleted `v*` tag is now refused for everyone, the workflow included, while
new tags still appear after each push to `main`.

## What a version promises

- Every file of the engine at `v<version>` stays exactly as it is (the tag never moves).
- `src/archon/version.ts` at that tag says `<version>`.
- `src/archon/modules.auto.ts` names every module, so `archon fleet upgrade` locks all of them.
