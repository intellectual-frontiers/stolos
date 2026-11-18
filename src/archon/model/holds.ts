/**
 * The model's holds at an engine tag (spec 115-compatibility FR-013), as the rungs above read them: the types of an `enginePin` and an
 * `engineHolds` (declared with the fleet model's types, `types.ts`) and the small shapes of a host and a fleet that carry them, so that a
 * business rule names what it reads without reaching around this rung.
 *
 * @module
 */
// Spec: 115-compatibility FR-013

import type { EngineHold, EngineHoldBy } from "./types.ts";

export type { EngineHold, EngineHoldBy, EngineTag } from "./types.ts";

/** What of a host the holds read: its name, its kind and its own `enginePin`. */
export interface HoldHost {
  /** Its name. */
  name: string;
  /** Its kind (`workstation` is not asked for its engine). */
  kind?: string | undefined;
  /** Its own hold at an engine tag. */
  enginePin?: EngineHold | undefined;
}

/** What of a fleet the holds read: its groups' holds. */
export interface HoldFleet {
  /** The holds of the hosts a tag expression chooses. */
  engineHolds?: EngineHoldBy[] | undefined;
}
