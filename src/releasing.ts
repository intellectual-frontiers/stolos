/**
 * # Changing and releasing the engine
 *
 * This guide is for people who change the engine (this repository). Fleets adopt a version with
 * `stolos fleet upgrade` (see [the fleet repository](./archon/fleet/mod.ts)); a release is simply a
 * version tag that CI made: there is no GitHub release, no package to download and nothing to
 * build. A fleet depends on the engine by Git at that tag
 * (`"@intellectual-frontiers/stolos": "github:intellectual-frontiers/stolos#v<version>"`), and its
 * `bun.lock` pins the commit and its integrity (spec 096-bun-runtime).
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
 * 5. **Watch CI.** The `ci` workflow checks again and, when it passes, installs the commit into an
 *    empty project as a fleet does (by Git, `bun tools/smoke.ts`), runs `archon --version` and
 *    `stolos --version` there on Bun and on Node 26 (with commons' hook), then tags the commit
 *    `v<version>` and publishes this version's documentation.
 *    The `e2e` workflow installs a blank Secure Boot VM from network boot to `Ready` with this
 *    commit's engine; it takes a while. Tell fleet owners to prefer versions whose `e2e` run passed.
 *
 * ## Why tags must never move
 *
 * A fleet's `bun.lock` holds the commit a tag named when the fleet adopted it, and that commit's
 * integrity. A moved tag would not change what those fleets install, but every fleet that adopts it
 * afterwards would get other code under the same version (and a deleted commit would leave the
 * hosts of the earlier fleets unable to install at all). So:
 *
 * - never delete or re-create a `v*` tag, and never push a tag by hand: CI makes them;
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
 * - Every file of the engine at `v<version>` stays exactly as it is (the tag never moves).
 * - `src/archon/version.ts` at that tag, and `package.json`, say `<version>`.
 * - The package is the whole engine at that commit, as its TypeScript sources (its text assets
 *   inside, through `assets.auto.ts`): `bun.lock` holds one commit and one integrity for all of it.
 *   Bun runs it from `node_modules`; Node 26 runs it with commons' hook
 *   (`node --import @intellectual-frontiers/commons/ts/node archon.ts`).
 *
 * @module
 */
// Spec: 096-bun-runtime

export {};
