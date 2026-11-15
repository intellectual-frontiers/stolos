/**
 * An example control pack (spec 078): the lab's own controls, in TypeScript, tested like code
 * (baseline.test.ts, with `bun test`). Stolos loads every fleets/<fleet>/controls/<pack>/pack.ts
 * and shows its results in stolos compliance and the Compliance tab ("control pack").
 *
 * @module
 */

import {
  defineControl,
  defineControlPack,
} from "@intellectual-frontiers/stolos/archon/controls/mod";

/** No system has more than three active administrators (over the estate graph). */
export const fewAdmins = defineControl({
  id: "few-admins",
  title: "No system has more than three active administrators",
  scf: ["IAC-30"],
  subject: "estate",
  query: {
    known: "SELECT count(*) AS n FROM user_account WHERE admin IS NOT NULL",
    many: `SELECT connector AS system, count(*) AS n FROM user_account
           WHERE active = 1 AND admin = 1 GROUP BY connector HAVING count(*) > 3 ORDER BY connector`,
  },
  // Without any account that says whether it is an administrator, the control does not apply.
  assert: ({ known, many }) =>
    !Number(known[0]?.["n"] ?? 0)
      ? undefined
      : {
          status: many.length ? "warn" : "pass",
          detail: many.length
            ? many
                .map((r) => `${String(r["n"])} administrators in ${String(r["system"])}`)
                .join(", ")
            : "at most three administrators in each system",
        },
  fix: "remove administrator rights from accounts that do not need them",
});

/** Nothing listens on the telnet port (osquery, on each adopted machine). */
export const noTelnet = defineControl({
  id: "no-telnet",
  title: "Nothing listens on the telnet port",
  scf: ["CFG-04", "CRY-05"],
  subject: "osquery",
  query: "SELECT port, address FROM listening_ports WHERE port = 23",
  assert: (rows) => ({
    status: rows.length ? "fail" : "pass",
    detail: rows.length
      ? `telnet listens on ${rows.map((r) => String(r["address"])).join(", ")}`
      : "no telnet listener",
  }),
  fix: "turn the telnet service off, and use SSH",
});

/** The lab's baseline. */
export const pack = defineControlPack({
  id: "baseline",
  title: "Lab baseline",
  version: "1.0.0",
  description: "Two controls the lab adds to Stolos's own.",
  controls: [fewAdmins, noTelnet],
});
