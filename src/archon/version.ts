/**
 * The engine's version (spec 046-engine-instance). A fleet imports the engine
 * from GitHub (`@stolos/` → raw.githubusercontent.com/.../v<VERSION>/src/), so
 * every push to main raises it and the release workflow tags that commit
 * v<VERSION>. `deno task version bump` raises the minor number (0.1.0, 0.2.0,
 * ...); `deno task version check` fails when main already has this version.
 *
 * @module
 */

export const VERSION = "0.57.0";

/** The git tag a fleet pins: "v0.1.0". */
export const TAG = `v${VERSION}`;
