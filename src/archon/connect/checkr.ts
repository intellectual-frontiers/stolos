/**
 * Spec 088: Checkr background screening, read through its API with GET only:
 * each candidate's work email and, for each of their reports, only its
 * outcome and date (never what the check found). A completed report is a
 * `person_record` of kind screening, the hook spec 077's `people/screening`
 * control reads beside `people/screening.ts`: `clear` when Checkr's result is
 * clear (or its assessment eligible), `not clear` otherwise. Pending reports
 * are counted, not recorded. Evidence for personnel screening (SCF HRS-05).
 *
 * Credential: a Checkr secret API key, sent as HTTP Basic's user name.
 * Checkr's keys are not scoped: one can make any call. Stolos's guard sends
 * only GET with it; make a key for Stolos alone, so it can be revoked on its
 * own. Docs: https://docs.checkr.com/ (Authentication; Candidates; Reports).
 *
 * @module
 */

import { check, type Connector, fresh } from "./connector.ts";
import { defineConnector } from "./sdk.ts";
import { PERSON_RECORD } from "../people/records.ts";

const API = "https://api.checkr.com/v1";

interface Candidate {
  id: string;
  email?: string;
  report_ids?: string[];
}

interface Report {
  id: string;
  status?: string;
  result?: string | null;
  assessment?: string | null;
  completed_at?: string | null;
  package?: string;
}

/** One report, with its candidate's email. */
interface Screening {
  email: string;
  report: Report;
}

/** Checkr. */
export const checkr: Connector = defineConnector({
  id: "checkr",
  title: "Checkr",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["cloud-hcm-suites"],
  connectHelp: [
    "dashboard.checkr.com > Account Settings > Developer Settings > API keys > Create key: stolos-read",
    "Checkr's keys are not scoped (none is read only): Stolos only reads with it (GET), and keeps it in the vault; revoke it there when you disconnect",
    "Copy the secret key",
  ],
  recipe: {
    open: {
      href: "https://dashboard.checkr.com/account/developer_settings",
      label: "Checkr: Developer Settings",
    },
  },
  fields: { token: { secret: true, hint: "a Checkr secret API key (Stolos only reads with it)" } },
  auth: (cred) =>
    Promise.resolve({
      Authorization: `Basic ${btoa(`${cred.token}:`)}`,
      Accept: "application/json",
    }),
  account: () => "Checkr",
  resources: {
    reports: {
      label: PERSON_RECORD,
      ocsf: "evidence_info",
      async *list(ctx): AsyncGenerator<Screening> {
        let n = 0;
        for await (const c of ctx.cursorPages<
          { data?: Candidate[]; next_href?: string | null },
          Candidate
        >(
          `${API}/candidates?per_page=100`,
          (b) => b.data,
          (b) => b.next_href ?? undefined,
        )) {
          if (!c.email) continue;
          for (const id of c.report_ids ?? []) {
            const r = await ctx.orGap(`report ${id}`, undefined as Report | undefined, () =>
              ctx.json<Report>(`${API}/reports/${encodeURIComponent(id)}`),
            );
            if (!r) continue;
            if (r.status !== "complete") {
              n++;
              continue;
            }
            yield { email: c.email, report: r };
          }
        }
        ctx.fact("screeningPending", n);
      },
      map: ({ email, report: r }: Screening) => ({
        native_id: r.id,
        display_name: `${email}: ${r.package ?? "background"}`,
        props: {
          email: email.toLowerCase(),
          kind: "screening",
          subject: r.package ?? "background",
          ...(r.completed_at ? { date: r.completed_at.slice(0, 10) } : {}),
          result: r.result === "clear" || r.assessment === "eligible" ? "clear" : "not clear",
        },
      }),
      asset: () => undefined,
    },
  },
  posture: (records) => ({
    screenings: records.length,
    screeningsClear: records.filter((r) => r.props["result"] === "clear").length,
  }),
  policies(o, now) {
    return [
      fresh(o, now, "checkr"),
      check(o, {
        id: "checkr-pending",
        title: "No screening report is still pending",
        scf: ["HRS-05"],
        fact: "screeningPending",
        want: (v) => v === 0,
        show: (v) => `${v} report(s) not complete yet`,
        fix: "dashboard.checkr.com > Candidates: filter Status pending; follow up each one",
        warnOnly: true,
      }),
    ];
  },
});
