/**
 * The engine's version (specs 046-engine-instance, 096-bun-runtime). Every push to main raises it,
 * and the release workflow tags that commit `v<VERSION>` and attaches the package built from it,
 * which a fleet repository depends on by its URL. `bun run version bump` raises the minor number
 * (0.1.0, 0.2.0, ...) here and in `package.json`; `bun run version check` fails when main already
 * has this version or the two files differ.
 *
 * @module
 */
// Spec: 046-engine-instance
// Spec: 096-bun-runtime

/** The engine's version (semver), raised on every push to main. */
export const VERSION = "0.139.0";

/** The git tag a fleet pins: "v0.1.0". */
export const TAG = `v${VERSION}`;
