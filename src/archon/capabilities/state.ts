/**
 * 014-state and 015-reconcile: hosts converge to the repository on a timer
 * (Article 9), and capture their state daily into /var/lib/archon (runtime;
 * spec 048: nothing is recorded in the repository).
 *
 * @module
 */
// Spec: 014-state
// Spec: 015-reconcile

import type { Capability } from "../model/types.ts";
import { timedJob } from "./ops.ts";

/** The reconcile timer (every 15 minutes) and the daily capture (specs 014, 015). */
export const state = (): Capability => () => ({
  spec: "015-reconcile",
  units: [
    ...timedJob({
      name: "reconcile",
      description: "converge to the repository",
      argv: ["reconcile"],
      onCalendar: "*:0/15",
      spec: "015-reconcile",
    }),
    ...timedJob({
      name: "capture",
      description: "daily state capture",
      argv: ["capture", "--summary"],
      onCalendar: "*-*-* 05:47:00",
      spec: "014-state",
    }),
  ],
  notes: [
    "archon-reconcile.timer applies origin/main every 15 minutes when the checkout is clean (Article 9).",
  ],
});
