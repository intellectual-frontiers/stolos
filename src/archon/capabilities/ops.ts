/**
 * 013-ops: the daily report (deterministic facts only). No agent runs on a
 * server (spec 030): workstations reach it through archon mcp over SSH.
 *
 * @module
 */
// Spec: 013-ops

import type { Capability, UnitDef } from "../model/types.ts";
import { archonService, timer } from "../render/systemd.ts";

/** A job run by a systemd timer. */
export type TimedJob = {
  name: string;
  description: string;
  argv: string[];
  onCalendar: string;
  spec: UnitDef["spec"];
};

/** A oneshot archon service plus its enabled timer. */
export function timedJob(j: TimedJob): UnitDef[] {
  return [
    {
      unitName: `archon-${j.name}.service`,
      managed: true,
      content: archonService({
        description: `Archon: ${j.description}`,
        argv: j.argv,
        spec: j.spec,
      }),
      state: "ignore",
      verify: `systemctl cat archon-${j.name}.service`,
      spec: j.spec,
    },
    {
      unitName: `archon-${j.name}.timer`,
      managed: true,
      content: timer({
        description: `Archon: ${j.description}`,
        onCalendar: j.onCalendar,
        spec: j.spec,
      }),
      state: "enabled",
      onCalendar: j.onCalendar,
      verify: `systemctl is-enabled archon-${j.name}.timer`,
      spec: j.spec,
    },
  ];
}

/** The daily report and its timer (spec 013). */
export const ops = (): Capability => () => ({
  spec: "013-ops",
  units: timedJob({
    name: "daily-report",
    description: "daily health report",
    argv: ["report", "daily"],
    onCalendar: "*-*-* 06:23:00",
    spec: "013-ops",
  }),
  notes: [
    "No agent runs here (spec 030): a workstation's agent reaches this host as ops over SSH, forced to archon mcp at the fleet's tier.",
    "The daily report is report-only (Article 17): /var/lib/archon/reports/daily-<date>.md and the journal (tag archon-report).",
  ],
});
