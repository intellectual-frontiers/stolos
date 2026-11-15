/**
 * Spec 077: people controls, on the control SDK (spec 078). Each is an estate
 * control: its SQL reads the people and accounts of the estate graph, and its
 * assertion compares them with what the fleet keeps in Git (roles, reviews,
 * policies, acknowledgements, training, screening), which {@link PeopleFacts}
 * carries. A leaver with an active account is the estate's own `leavers`
 * control, reused, not repeated.
 *
 * ```mermaid
 * flowchart LR
 *   estate[("estate graph")] --> sql["each control's SELECT"]
 *   facts["PeopleFacts: roles, reviews, acks, training, screening, activity"] --> assert["each control's assert"]
 *   sql --> assert
 *   assert --> results["people/&lt;control&gt;: pass, warn, fail"]
 *   results --> compliance["stolos compliance (a control pack)"]
 * ```
 *
 * @module
 */

import {
  type ControlPack,
  defineControl,
  defineControlPack,
  type EstateControl,
  type Row,
} from "../controls/define.ts";
import { ESTATE_CONTROLS } from "../estate/graph.ts";
import type { Activity, ReviewStatus, VerifiedAck } from "./git.ts";
import {
  cell,
  type Policy,
  type Quarter,
  type RoleMap,
  type ScreeningRecord,
  type TrainingRecord,
} from "./records.ts";
import { emailOf } from "./reviews.ts";

/** What the people controls compare the estate graph with. */
export interface PeopleFacts {
  /** people/roles.ts: the connectors each role needs (undefined: not kept). */
  roles?: RoleMap;
  /** The quarter whose reviews must be approved (the last that ended). */
  reviewQuarter: Quarter;
  /** That quarter's reviews, as committed (undefined: reviews are not kept). */
  reviews?: ReviewStatus[];
  /** The policies (policies/*.md). */
  policies: Policy[];
  /** The acknowledgements Git proves (signed by the person's own key). */
  acks: VerifiedAck[];
  /** people/training.ts (undefined: no file). */
  training?: TrainingRecord[];
  /** people/screening.ts (undefined: no file). */
  screening?: ScreeningRecord[];
  /** Each account's activity from Git (node uid to activity). */
  activity: Map<string, Activity>;
  /** How many days after the end date an account may stay active (default 1). */
  deprovisionDays?: number;
  /** How many months a training counts (default 12). */
  trainingMonths?: number;
}

const list = (xs: string[]) =>
  xs.slice(0, 12).join(", ") + (xs.length > 12 ? `, and ${xs.length - 12} more` : "");
const n = (r: Row[]) => Number(r[0]?.["n"] ?? 0);
const DAY = 86_400_000;
const today = (now: Date) => now.toISOString().slice(0, 10);

/** The estate's own control: a leaver with an active account fails (IAC-04). */
export const LEAVERS: EstateControl = (() => {
  const c = ESTATE_CONTROLS.find((x) => x.id === "leavers");
  if (!c) throw new Error("the estate controls have no leavers control (spec 085)");
  return c;
})();

const ACTIVE_PEOPLE = `SELECT u.uid, u.email_addr AS email, u.start_date,
  (SELECT group_concat(r.role_type, ',') FROM party_role r WHERE r.party_uid = u.uid) AS roles,
  (SELECT group_concat(DISTINCT a.connector) FROM edge e JOIN user_account a ON a.user_account_uid = e.dst_uid
     WHERE e.src_uid = u.uid AND e.verb = 'has_account' AND a.active = 1) AS systems
FROM user_inventory u WHERE u.status = 'active' ORDER BY u.email_addr`;

/** The connectors a person's roles need (with everyone's, `"*"`). */
export function requiredSystems(roles: RoleMap, personRoles: string[]): string[] {
  return [
    ...new Set([...(roles["*"] ?? []), ...personRoles.flatMap((r) => roles[r] ?? [])]),
  ].sort();
}

/** Joiners (every active person) have the accounts their role needs (people/roles.ts). */
export function joinersControl(f: PeopleFacts): EstateControl {
  return defineControl({
    id: "joiners",
    title: "Every active person has the accounts their role needs",
    scf: ["IAC-04", "HRS-08"],
    subject: "estate",
    description:
      "people/roles.ts names the connectors each role (the HR system's role_type, or * for everyone) needs; a connector not connected is not asked for.",
    query: {
      people: ACTIVE_PEOPLE,
      connected: "SELECT DISTINCT connector FROM tenant ORDER BY connector",
    },
    assert: ({ people, connected }, { now }) => {
      if (!f.roles || !people.length) return undefined;
      const have = new Set(connected.map((r) => String(r["connector"])));
      const gaps: Array<{ uid: string; text: string }> = [];
      for (const p of people) {
        const mine = new Set(cell(p["systems"]).split(",").filter(Boolean));
        const need = requiredSystems(f.roles, cell(p["roles"]).split(",").filter(Boolean)).filter(
          (c) => have.has(c) && !mine.has(c),
        );
        if (!need.length) continue;
        const start = p["start_date"] ? cell(p["start_date"]) : undefined;
        const days = start
          ? Math.floor((now.getTime() - Date.parse(`${start}T00:00:00Z`)) / DAY)
          : undefined;
        gaps.push({
          uid: String(p["uid"]),
          text: `${cell(p["email"])} needs ${need.join(", ")}${
            days !== undefined && days >= 0 ? ` (started ${days} day(s) ago)` : ""
          }`,
        });
      }
      return {
        status: gaps.length ? "warn" : "pass",
        detail: gaps.length
          ? `${gaps.length} without an account their role needs: ${list(gaps.map((g) => g.text))}`
          : `${people.length} active person(s), each with the accounts their role needs`,
        subjects: gaps.map((g) => g.uid),
      };
    },
    fix: "create each missing account (identity provider first), or correct people/roles.ts",
  });
}

/** The accounts of people on leave are not left active (warn: a decision, not always wrong). */
export function onLeaveControl(): EstateControl {
  return defineControl({
    id: "on-leave",
    title: "People on leave have no active accounts, or a recorded reason",
    scf: ["IAC-08", "HRS-08"],
    subject: "estate",
    query: {
      leave: "SELECT count(*) AS n FROM person WHERE status = 'leave'",
      open: `SELECT u.email_addr AS email, a.connector AS system, a.user_account_uid AS uid
       FROM user_inventory u
       JOIN edge e ON e.src_uid = u.uid AND e.verb = 'has_account'
       JOIN user_account a ON a.user_account_uid = e.dst_uid
       WHERE u.status = 'leave' AND a.active = 1 ORDER BY u.email_addr, a.connector`,
    },
    assert: ({ leave, open }) =>
      !n(leave)
        ? undefined
        : {
            status: open.length ? "warn" : "pass",
            detail: open.length
              ? `${open.length} active account(s) of people on leave: ${list(
                  open.map((x) => `${cell(x["email"])} in ${cell(x["system"])}`),
                )}`
              : `${n(leave)} on leave, none with an active account`,
            subjects: open.map((x) => String(x["uid"])),
          },
    fix: "suspend their accounts while they are away, or record the decision in fleets/<fleet>/controls/accepted.ts (people/on-leave)",
  });
}

/** One leaver's account: how long it stayed active after their end date. */
export interface DeprovisionMeasure {
  /** The person's work email. */
  email: string;
  /** Their end date. */
  end: string;
  /** The system. */
  system: string;
  /** The account's name there. */
  account: string;
  /** The account's node uid. */
  uid: string;
  /** Still active now. */
  active: boolean;
  /** The last time Git saw it active (ISO), when it did. */
  lastActive?: string;
  /** The first time Git saw it off or gone after that (ISO). */
  offBy?: string;
  /** Whole days it stayed active after the end date (0: off by then); to now while still active. */
  days: number;
}

const LEAVER_ACCOUNTS = `SELECT u.email_addr AS email, u.end_date, a.connector AS system, a.display_name AS account,
  a.user_account_uid AS uid, a.active
FROM user_inventory u
JOIN edge e ON e.src_uid = u.uid AND e.verb = 'has_account'
JOIN user_account a ON a.user_account_uid = e.dst_uid
WHERE u.status = 'terminated' AND u.end_date IS NOT NULL ORDER BY u.email_addr, a.connector`;

/** The time to deprovision each leaver's account, from the rows of {@link LEAVER_ACCOUNTS} and Git's activity. */
export function deprovisionMeasures(
  rows: Row[],
  activity: Map<string, Activity>,
  now: Date,
): DeprovisionMeasure[] {
  return rows.map((r) => {
    const end = String(r["end_date"]);
    const endMs = Date.parse(`${end}T23:59:59Z`);
    const a = activity.get(String(r["uid"])) ?? {};
    const active = Number(r["active"]) === 1;
    const until = active ? now.getTime() : a.lastActive ? Date.parse(a.lastActive) : endMs;
    return {
      email: String(r["email"]),
      end,
      system: String(r["system"]),
      account: String(r["account"]),
      uid: String(r["uid"]),
      active,
      ...(a.lastActive ? { lastActive: a.lastActive } : {}),
      ...(a.offBy ? { offBy: a.offBy } : {}),
      days: Math.max(0, Math.ceil((until - endMs) / DAY)),
    };
  });
}

/** How long leavers' accounts stayed active after their end date (HRS-12), from Git's history. */
export function deprovisionControl(f: PeopleFacts): EstateControl {
  const target = f.deprovisionDays ?? 1;
  return defineControl({
    id: "time-to-deprovision",
    title: `Leavers' accounts are turned off within ${target} day(s) of their end date`,
    scf: ["IAC-04", "HRS-12"],
    subject: "estate",
    description:
      "From each observation in Git: the last time an account could sign in, after its person's end date. One still active now is the leavers control's failure.",
    query: LEAVER_ACCOUNTS,
    assert: (rows, { now }) => {
      if (!rows.length) return undefined;
      const ms = deprovisionMeasures(rows, f.activity, now);
      const late = ms.filter((m) => !m.active && m.days > target);
      const open = ms.filter((m) => m.active);
      const worst = Math.max(0, ...ms.filter((m) => !m.active).map((m) => m.days));
      return {
        status: late.length ? "warn" : "pass",
        detail:
          (late.length
            ? `${late.length} account(s) stayed active past ${target} day(s): ${list(
                late.map((m) => `${m.email} in ${m.system}, ${m.days} day(s)`),
              )}`
            : `${
                ms.length - open.length
              } leaver account(s) turned off, the slowest after ${worst} day(s)`) +
          (open.length ? `; ${open.length} still active (the leavers control)` : ""),
        subjects: late.map((m) => m.uid),
      };
    },
    fix: "make offboarding turn every account off on the last day (identity provider first, then each system)",
  });
}

const MANAGERS = `SELECT DISTINCT r.to_party_uid AS uid FROM party_relationship r
JOIN person p ON p.party_uid = r.from_party_uid
WHERE r.party_relationship_type = 'reports_to' AND p.status IN ('active', 'leave')
ORDER BY r.to_party_uid`;

/** Every manager's access review for the last quarter exists and is approved by a signed commit (IAC-12). */
export function reviewsControl(f: PeopleFacts): EstateControl {
  return defineControl({
    id: "access-reviews",
    title: "Every manager approved last quarter's access review with a signed commit",
    scf: ["IAC-12"],
    subject: "estate",
    description:
      "people/reviews/<quarter>/<manager>.md on main, every line ticked, in a commit signed by the manager's own key (people/keys.ts) or a fleet signer.",
    query: MANAGERS,
    assert: (rows) => {
      if (!f.reviews || !rows.length) return undefined;
      const q = f.reviewQuarter;
      const missing: string[] = [];
      const open: string[] = [];
      const subjects: string[] = [];
      for (const r of rows) {
        const m = emailOf(String(r["uid"]));
        const s = f.reviews.find((x) => x.manager === m);
        if (!s) missing.push(m);
        else if (!s.approvedBy) open.push(`${m} (${s.why})`);
        else continue;
        subjects.push(String(r["uid"]));
      }
      const approved = f.reviews.filter((x) => x.approvedBy);
      return {
        status: missing.length || open.length ? "fail" : "pass",
        detail:
          missing.length || open.length
            ? [
                missing.length ? `${q}: no review for ${list(missing)}` : "",
                open.length ? `${q}: not approved: ${list(open)}` : "",
              ]
                .filter(Boolean)
                .join("; ")
            : `${q}: ${approved.length} review(s), each approved by a signed commit (${list(
                approved.map((x) => `${x.manager} by ${x.approvedBy}`),
              )})`,
        subjects,
      };
    },
    fix: `bun run stolos people review --quarter ${f.reviewQuarter}, then each manager ticks and signs their file`,
  });
}

/** Every active person acknowledged every current policy version, by a commit signed with their own key (HRS-08.2). */
export function acksControl(f: PeopleFacts): EstateControl {
  return defineControl({
    id: "policy-acks",
    title: "Every active person acknowledged every current policy",
    scf: ["HRS-08.2"],
    subject: "estate",
    description:
      "An acknowledgement is a commit with Acknowledges: <policy>@<version>, signed by the person's own key (people/keys.ts): bun run stolos people ack <policy>.",
    query:
      "SELECT uid, email_addr AS email FROM user_inventory WHERE status = 'active' ORDER BY email_addr",
    assert: (people) => {
      const current = f.policies.filter((p) => p.version);
      if (!current.length || !people.length) return undefined;
      const gaps: Array<{ uid: string; text: string }> = [];
      for (const p of people) {
        const owed = current.filter(
          (pol) =>
            !f.acks.some(
              (a) => a.email === p["email"] && a.policy === pol.id && a.version === pol.version,
            ),
        );
        if (owed.length) {
          gaps.push({
            uid: String(p["uid"]),
            text: `${cell(p["email"])}: ${owed.map((x) => `${x.id} ${x.version}`).join(", ")}`,
          });
        }
      }
      return {
        status: gaps.length ? "fail" : "pass",
        detail: gaps.length
          ? `${gaps.length} person(s) owe an acknowledgement: ${list(gaps.map((g) => g.text))}`
          : `${people.length} person(s), each acknowledged all ${current.length} current polic(ies)`,
        subjects: gaps.map((g) => g.uid),
      };
    },
    fix: "each of them runs bun run stolos people ack <policy> (a commit signed with their own key; add the key to people/keys.ts)",
  });
}

/** Every policy's review date has not passed (GOV-04.1). */
export function policyReviewControl(f: PeopleFacts): EstateControl {
  return defineControl({
    id: "policy-reviews",
    title: "Every policy is reviewed by its review date",
    scf: ["GOV-04.1"],
    subject: "estate",
    query: "SELECT count(*) AS n FROM person",
    assert: (_rows, { now }) => {
      if (!f.policies.length) return undefined;
      const day = today(now);
      const bad = f.policies.filter((p) => !p.review || p.review < day);
      return {
        status: bad.length ? "fail" : "pass",
        detail: bad.length
          ? `${bad.length} overdue or without a review date: ${list(
              bad.map((p) => `${p.id} (${p.review || "none"})`),
            )}`
          : `${f.policies.length} polic(ies), each due for review on or after ${day}`,
      };
    },
    fix: "review the policy with its owner, raise its version if it changed, and set its next review date in its front matter",
  });
}

/** A connector's records of one kind (person_record nodes), as rows of email, subject, date, result. */
const connectorRecords = (kind: string) =>
  `SELECT lower(json_extract(props, '$.email')) AS email, json_extract(props, '$.subject') AS subject,
  json_extract(props, '$.date') AS date, json_extract(props, '$.result') AS result
FROM node WHERE label = 'person_record' AND json_extract(props, '$.kind') = '${kind}'`;

const ACTIVE =
  "SELECT uid, email_addr AS email FROM user_inventory WHERE status = 'active' ORDER BY email_addr";

/** Every active person passed training within the last 12 months (SAT-04, SAT-10). */
export function trainingControl(f: PeopleFacts): EstateControl {
  const months = f.trainingMonths ?? 12;
  return defineControl({
    id: "training",
    title: `Every active person passed awareness training within ${months} months`,
    scf: ["SAT-04", "SAT-10"],
    subject: "estate",
    query: { people: ACTIVE, records: connectorRecords("training") },
    assert: ({ people, records }, { now }) => {
      const all = [
        ...(f.training ?? []).map((t) => ({ email: t.email, date: t.date, result: t.result })),
        ...records.map((r) => ({
          email: String(r["email"]),
          date: String(r["date"]),
          result: String(r["result"]),
        })),
      ];
      if (!people.length || (f.training === undefined && !records.length)) return undefined;
      const since = new Date(now);
      since.setUTCMonth(since.getUTCMonth() - months);
      const from = today(since);
      const due = people.filter(
        (p) => !all.some((t) => t.email === p["email"] && t.result === "passed" && t.date >= from),
      );
      return {
        status: due.length ? "fail" : "pass",
        detail: due.length
          ? `${due.length} without a passed training since ${from}: ${list(
              due.map((p) => String(p["email"])),
            )}`
          : `${people.length} active person(s), each trained since ${from}`,
        subjects: due.map((p) => String(p["uid"])),
      };
    },
    fix: "have each of them take the awareness training, and record it in people/training.ts",
  });
}

/** Every active person has a screening on file (HRS-05). */
export function screeningControl(f: PeopleFacts): EstateControl {
  return defineControl({
    id: "screening",
    title: "Every active person has a screening on file",
    scf: ["HRS-05"],
    subject: "estate",
    query: { people: ACTIVE, records: connectorRecords("screening") },
    assert: ({ people, records }) => {
      const all = [
        ...(f.screening ?? []).map((s) => ({ email: s.email, result: s.result })),
        ...records.map((r) => ({ email: String(r["email"]), result: String(r["result"]) })),
      ];
      if (!people.length || (f.screening === undefined && !records.length)) return undefined;
      const none = people.filter((p) => !all.some((s) => s.email === p["email"]));
      const unclear = people.filter(
        (p) =>
          all.some((s) => s.email === p["email"]) &&
          !all.some((s) => s.email === p["email"] && s.result === "clear"),
      );
      return {
        status: none.length || unclear.length ? "fail" : "pass",
        detail:
          none.length || unclear.length
            ? [
                none.length
                  ? `${none.length} without a screening: ${list(none.map((p) => String(p["email"])))}`
                  : "",
                unclear.length
                  ? `${unclear.length} not clear: ${list(unclear.map((p) => String(p["email"])))}`
                  : "",
              ]
                .filter(Boolean)
                .join("; ")
            : `${people.length} active person(s), each screened and clear`,
        subjects: [...none, ...unclear].map((p) => String(p["uid"])),
      };
    },
    fix: "record each screening in people/screening.ts (the check, its date, its result: nothing more)",
  });
}

/** The people controls, in the order results are shown (without `leavers`: it is the estate's). */
export function peopleControls(f: PeopleFacts): EstateControl[] {
  return [
    joinersControl(f),
    onLeaveControl(),
    deprovisionControl(f),
    reviewsControl(f),
    acksControl(f),
    policyReviewControl(f),
    trainingControl(f),
    screeningControl(f),
  ];
}

/** The people controls as a pack (results `people/<control>`), for Compliance. */
export function peoplePack(f: PeopleFacts, version = "1.0.0"): ControlPack {
  return defineControlPack({
    id: "people",
    title: "People",
    version,
    description:
      "Joiners and leavers, access reviews, policies, training, and screening (spec 077).",
    controls: peopleControls(f),
  });
}
