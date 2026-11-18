/**
 * The engine's version (specs 046-engine-instance, 096-bun-runtime, 114-release-record). Every push
 * to main raises it, and the release workflow tags that commit `stolos-v<VERSION>`, an annotated Git
 * tag, which a fleet repository depends on by its URL. `bun run version bump` raises the minor number
 * (0.150.0, 0.151.0, ...) here, in `package.json` and in the work's record `release.ts`; `bun run
 * version check` fails when main already has this version or the three differ.
 *
 * @module
 */
// Spec: 046-engine-instance
// Spec: 096-bun-runtime
// Spec: 114-release-record FR-004, FR-005, FR-013, FR-014

/** The engine's version (semver), raised on every push to main. */
export const VERSION = "0.155.0";

/**
 * The slug of the work Stolos is (commons 0026-works-versioning FR-008): the one place it is written in code. `release.ts`
 * says the same (the tool and a test hold them equal), and the prefix of every tag is made from it.
 */
export const WORK_SLUG = "stolos";

/** The prefix of every release tag of the engine: the work's slug and `-v` (commons 0026-works-versioning FR-018). */
export const TAG_PREFIX = `${WORK_SLUG}-v`;

/** The git tag of a version of the engine: `stolos-v0.150.0`. */
export const tagOf = (version: string): string => `${TAG_PREFIX}${version}`;

/** The git tag a fleet pins: "stolos-v0.150.0". */
export const TAG = tagOf(VERSION);

/** What `archon --version` and `stolos --version` print: "0.150.0 (engine stolos-v0.150.0)". */
export const versionLine = (version: string = VERSION): string =>
  `${version} (engine ${tagOf(version)})`;
