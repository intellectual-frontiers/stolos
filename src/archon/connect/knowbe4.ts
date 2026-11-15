/**
 * Spec 088: KnowBe4 security awareness training, read-only, through its
 * Reporting API: every training enrollment (who, which module, its status,
 * and when it was completed). A completed (passed) or failed enrollment is a
 * `person_record` of kind training, the hook spec 077's `people/training`
 * control reads beside `people/training.ts`; the rest are counted (in
 * progress, not started, past due). Evidence for awareness training and its
 * records (SCF SAT-04, SAT-10).
 *
 * Credential: the Reporting API key (Account Settings > Account Integrations
 * > API > Reporting API), which can only read. One call per 500 enrollments.
 * Docs: https://developer.knowbe4.com/rest/reporting (base URLs per region:
 * us, eu, ca, uk, de; `Authorization: Bearer <key>`; `page` and `per_page`).
 *
 * @module
 */

import { http } from "@intellectual-frontiers/ifc-ts/runtime";
import { check, type Connector, fresh } from "./connector.ts";
import { defineConnector } from "./sdk.ts";
import { PERSON_RECORD } from "../people/records.ts";

const FIELDS = {
  region: { secret: false, hint: "your KnowBe4 region: us (the default), eu, ca, uk, or de" },
  token: { secret: true, hint: "the Reporting API key (read only)" },
};

const base = (region: string) => {
  const r = (region || "us").trim().toLowerCase();
  return `https://${["us", "eu", "ca", "uk", "de"].includes(r) ? r : "us"}.api.knowbe4.com`;
};

const PER_PAGE = 500;

/** One enrollment, as the Reporting API returns it. */
interface Enrollment {
  enrollment_id: number;
  module_name?: string;
  campaign_name?: string;
  user?: { id?: number; email?: string };
  completion_date?: string | null;
  status?: string;
}

const done = (e: Enrollment) => e.status === "Passed" || e.status === "Failed";

/** KnowBe4. */
export const knowbe4: Connector = defineConnector({
  id: "knowbe4",
  title: "KnowBe4 Security Awareness Training",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["security-awareness-training"],
  connectHelp: [
    "training.knowbe4.com > Account Settings > Account Integrations > API: tick Enable Reporting API Access",
    "Copy the Reporting API key (it can only read reports)",
    "Your region is the start of your console's address (us, eu, ca, uk, de)",
  ],
  recipe: {
    open: {
      href: "https://training.knowbe4.com/ui/account/settings/integrations",
      label: "KnowBe4: Account Integrations",
    },
  },
  fields: FIELDS,
  auth: (cred) => Promise.resolve(http.bearer(cred.token)),
  account: (cred) => new URL(base(cred.region)).host,
  resources: {
    enrollments: {
      label: PERSON_RECORD,
      ocsf: "evidence_info",
      async *list(ctx): AsyncGenerator<Enrollment> {
        let pastDue = 0,
          open = 0;
        for (let page = 1; page <= 200; page++) {
          const rows = await ctx.json<Enrollment[]>(
            `${base(ctx.cred.region)}/v1/training/enrollments?page=${page}&per_page=${PER_PAGE}`,
          );
          for (const e of rows) {
            if (done(e)) yield e;
            else if (e.status === "Past Due") pastDue++;
            else open++;
          }
          if (rows.length < PER_PAGE) break;
        }
        ctx.fact("trainingPastDue", pastDue);
        ctx.fact("trainingOpen", open);
      },
      map: (e: Enrollment) => ({
        native_id: String(e.enrollment_id),
        display_name: `${e.user?.email ?? "?"}: ${e.module_name ?? e.campaign_name ?? "training"}`,
        props: {
          email: (e.user?.email ?? "").toLowerCase(),
          kind: "training",
          subject: e.module_name ?? e.campaign_name ?? "security awareness",
          ...(e.completion_date ? { date: e.completion_date.slice(0, 10) } : {}),
          result: e.status === "Passed" ? "passed" : "failed",
        },
      }),
      asset: () => undefined,
    },
  },
  posture: (records) => ({
    trainingRecords: records.length,
    trainingPassed: records.filter((r) => r.props["result"] === "passed").length,
  }),
  policies(o, now) {
    return [
      fresh(o, now, "knowbe4"),
      check(o, {
        id: "kb4-past-due",
        title: "No training enrollment is past due",
        scf: ["SAT-04"],
        fact: "trainingPastDue",
        want: (v) => v === 0,
        show: (v) => `${v} past due, ${o.posture["trainingOpen"] ?? 0} not finished yet`,
        fix: "training.knowbe4.com > Training > the campaign > Users: remind each one past due (or extend the campaign)",
        warnOnly: true,
      }),
    ];
  },
});
