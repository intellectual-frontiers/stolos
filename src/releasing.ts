/**
 * # Changing and releasing the engine
 *
 * This guide is for people who change the engine (this repository). Fleets adopt a release with
 * `stolos fleet upgrade` (see [fleet-repository.md](fleet-repository.md)); a release is simply a
 * version tag that CI made.
 *
 * ## Every change
 *
 * 1. **Spec first.** Find or create `specs/NNN-short-name/spec.md` (Spec Kit; the prompts are in
 *    `.specify/commands/`). The commit subject starts with the spec's ID.
 * 2. **Change the code and its tests.** TypeScript only; no fleet's data (use `examples/fleets/lab`);
 *    generated files are named `.auto.` and come from `bun run gen`.
 * 3. **Raise the version.** Every push to `main` raises it, because fleets pin versions and each
 *    version must be one exact set of files:
 *
 *    ```sh
 *    bun run version bump        # 0.7.0 → 0.8.0, in src/archon/version.ts and package.json
 *    ```
 *
 * 4. **Run exactly what CI runs**, and push only when it passes:
 *
 *    ```sh
 *    bun run gen
 *    bun run ci                  # generated files fresh, types, lint, format, tests, version newer than main
 *    git push
 *    ```
 *
 * 5. **Watch CI.** The `ci` workflow checks again and, when it passes, tags the commit `v<version>`,
 *    builds the package (`tsc` into JavaScript with its types), packs it, installs it into an empty
 *    project and runs it on Bun and on Node, then attaches
 *    `intellectual-frontiers-stolos-<version>.tgz` and its SHA-256 to the release of that tag.
 *    The `e2e` workflow installs a blank Secure Boot VM from network boot to `Ready` with this
 *    commit's engine; it takes a while. Tell fleet owners to prefer versions whose `e2e` run passed.
 *
 * ## Why tags must never move
 *
 * A fleet's `bun.lock` holds the integrity of the engine's tarball at a tag. If a tag's release
 * asset changed, every host of every fleet pinned to it would refuse to install it (by design: that
 * is the alarm). So:
 *
 * - never delete or re-create a `v*` tag or its release asset, and never push a tag by hand: CI
 *   makes them;
 * - a broken release is fixed by a newer version, never by moving its tag.
 *
 * ### Protecting the tags on GitHub (an owner of `intellectual-frontiers` does this once)
 *
 * 1. Open <https://github.com/intellectual-frontiers/stolos/settings/rules>.
 * 2. **New ruleset → New tag ruleset.** Name: `release tags are immutable`.
 * 3. **Enforcement status:** Active. **Bypass list:** leave empty.
 * 4. **Target tags → Add target → Include by pattern:** `v*`.
 * 5. **Rules:** check **Restrict updates**, **Restrict deletions**, and **Block force pushes**. Leave
 *    **Restrict creations** unchecked: the `ci` workflow must still be able to create new tags.
 * 6. **Create.**
 *
 * To check it: a moved or deleted `v*` tag is now refused for everyone, the workflow included, while
 * new tags still appear after each push to `main`.
 *
 * ## What a version promises
 *
 * - Every file of the engine at `v<version>` stays exactly as it is (the tag never moves), and so
 *   does its package, `intellectual-frontiers-stolos-<version>.tgz`, on the release.
 * - `src/archon/version.ts` at that tag, and the package's `package.json`, say `<version>`.
 * - The package is the whole engine (its text assets inside, through `assets.auto.ts`): `bun.lock`
 *   holds one integrity for all of it.
 *
 * @module
 */

export {};
