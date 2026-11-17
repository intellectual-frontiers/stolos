/**
 * # Changing and releasing the engine
 *
 * This guide is for people who change the engine (this repository). Fleets adopt a version with
 * `stolos fleet upgrade` (see [the fleet repository](./archon/fleet/mod.ts)); a release is simply an
 * annotated Git tag, `stolos-v<version>`, that CI made: there is no GitHub release, no package to
 * download and nothing to build. A fleet depends on the engine by Git at that tag
 * (`"@intellectual-frontiers/stolos": "github:intellectual-frontiers/stolos#stolos-v<version>"`), and its
 * `bun.lock` pins the commit and its integrity (specs 096-bun-runtime, 114-release-record).
 *
 * ## One work, one record
 *
 * Stolos is one work (commons' 0026-works-versioning: kind `Software`, slug `stolos`), and its
 * record is `release.ts` at the root of this repository: data, read and never run, with the
 * version and the paths that change without being the work (`out`, `test-results`). The version has
 * one source, `src/archon/version.ts`; `package.json` and `release.ts` follow it, and
 * `bun run version` is the only thing that writes them:
 *
 * - `bun run version bump` raises the minor number in the three files (0.150.0 to 0.151.0);
 * - `bun run version set <version>` writes a given version in the three (the first release is 0.150.0);
 * - `bun run version sync` writes the version of `src/archon/version.ts` into the other two;
 * - `bun run version check [base]` fails unless the three agree and the version is newer than the
 *   one on `base` (`origin/main` by default).
 *
 * The same push is also judged by commons' own check, offline and path-scoped: `bun run versions:check`
 * (`versions check` of IFC's Mizan) compares the files of the work and its record with the base
 * and reports `versions/not-grown` where files changed and the version did not grow, and
 * `versions/record-invalid` where `release.ts` does not decode. CI runs both in the `check` job.
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
 *    bun run version bump        # 0.150.0 → 0.151.0, in src/archon/version.ts, package.json and release.ts
 *    ```
 *
 * 4. **Run exactly what CI runs**, and push only when it passes:
 *
 *    ```sh
 *    bun run gen
 *    bun run ci                  # generated files fresh, types, lint, format, tests, both version checks
 *    git push
 *    ```
 *
 * 5. **Watch CI.** The `ci` workflow checks again and, when it passes, installs the commit into an
 *    empty project as a fleet does (by Git, `bun tools/smoke.ts`), runs `archon --version` and
 *    `stolos --version` there on Bun and on Node 26 (with commons' hook), then tags the commit
 *    `stolos-v<version>` (annotated, with the commit and the tree hash in its message, made by
 *    commons' `versions tag stolos`; CI holds no signing key, so the tag is not signed) and
 *    publishes this version's documentation under that name.
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
 * - never delete or re-create a `stolos-v*` tag, and never push a tag by hand: CI makes them;
 * - a broken release is fixed by a newer version, never by moving its tag.
 *
 * ### Protecting the tags on GitHub (an owner of `intellectual-frontiers` does this once)
 *
 * 1. Open <https://github.com/intellectual-frontiers/stolos/settings/rules>.
 * 2. **New ruleset → New tag ruleset.** Name: `release tags are immutable`.
 * 3. **Enforcement status:** Active. **Bypass list:** leave empty.
 * 4. **Target tags → Add target → Include by pattern:** `stolos-v*`.
 * 5. **Rules:** check **Restrict updates**, **Restrict deletions**, and **Block force pushes**. Leave
 *    **Restrict creations** unchecked: the `ci` workflow must still be able to create new tags.
 * 6. **Create.**
 *
 * To check it: a moved or deleted `stolos-v*` tag is now refused for everyone, the workflow included, while
 * new tags still appear after each push to `main`.
 *
 * ## The first release, 0.150.0
 *
 * 0.150.0 is the first version under this scheme: the engine's older tags (`v0.1.0` to `v0.145.0`)
 * were deleted, and nothing reads that spelling any more. A fleet repository that still pins one
 * re-pins once, by hand, on a PC where it can sign:
 *
 * ```sh
 * bun add github:intellectual-frontiers/stolos#stolos-v0.150.0
 * bun run stolos update
 * ```
 *
 * From then on `stolos update` finds the newest `stolos-v<version>` tag, moves the pin and sends
 * it, as before. A bootstrap one-liner copied from an old document names an old tag: take the
 * current one from this repository's README.
 *
 * ## What a version promises
 *
 * - Every file of the engine at `stolos-v<version>` stays exactly as it is (the tag never moves).
 * - `src/archon/version.ts` at that tag, `package.json` and `release.ts` say `<version>`.
 * - The package is the whole engine at that commit, as its TypeScript sources (its text assets
 *   inside, through `assets.auto.ts`): `bun.lock` holds one commit and one integrity for all of it.
 *   Bun runs it from `node_modules`; Node 26 runs it with commons' hook
 *   (`node --import @intellectual-frontiers/commons/ts/node archon.ts`).
 *
 * @module
 */
// Spec: 096-bun-runtime
// Spec: 114-release-record FR-001 to FR-004, FR-008, FR-009, FR-011

export {};
