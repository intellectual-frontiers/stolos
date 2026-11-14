/**
 * How many problems `deno doc --lint` may still find in the engine (spec 055).
 * It only goes down: `deno task docs:baseline` lowers it after a fix.
 *
 * @module
 */

/** The documentation problems left to fix. */
export const DOC_LINT_BASELINE = 651;
