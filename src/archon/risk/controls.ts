/**
 * Spec 080: the register and the vendors in the estate graph, and the
 * controls over them, written on the control SDK (spec 078) like any other
 * pack. {@link addRiskData} loads the register (`risk`), the accepted risks
 * (`poam_item`), and the vendors (`organization` parties with the
 * `party_role` supplier, their `edge`s, and their `data_classification`)
 * into an estate; {@link RISK_PACK}'s controls then ask it with SQL:
 *
 * | control             | fails or warns when                                             | SCF              |
 * | ------------------- | --------------------------------------------------------------- | ---------------- |
 * | `review-due`        | an open risk is past its next review (fails)                    | RSK-14, RSK-13.2 |
 * | `owner-on-roster`   | a risk's owner is not an active person on the roster (warns)    | RSK-11           |
 * | `accepted-current`  | an accepted risk is past its date (fails); one is unregistered  | RSK-16.1         |
 * | `vendors-triaged`   | a discovered vendor is not triaged in vendors.ts (warns)        | TPM-08, TPM-09   |
 *
 * ```mermaid
 * flowchart LR
 *   risks["risks.ts"] & accepted["controls/accepted.ts, adopted machines"] & vendors["discoverVendors + vendors.ts"] --> add["addRiskData"]
 *   add --> estate[("estate graph: risk, poam_item, organization, data_classification")]
 *   estate --> pack["RISK_PACK (estate controls)"]
 *   pack --> comp["stolos compliance, stolos risks check"]
 * ```
 *
 * @module
 */
// Spec: 080-risks-vendors

import type { Acceptance, AdoptedDef } from "../adopt/adopt.ts";
import type { Estate } from "../estate/graph.ts";
import { edge, organization, party, partyRole } from "../estate/schema.ts";
import {
  type ControlPack,
  defineControl,
  defineControlPack,
  type EstateControl,
  type Row,
} from "../controls/define.ts";
import { type PackRun, runPack } from "../controls/run.ts";
import { type Column, type RowOf, rowParams, type TableDef, upsertSql } from "../schema/define.ts";
import { dataClassification, poamItem, risk, riskSchemaSql } from "./schema.ts";
import { type Risk, today } from "./register.ts";
import type { Vendor } from "./vendors.ts";

/** A row's column as text ("" where it is empty or not a scalar). */
const txt = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
      ? String(v)
      : "";

/** A vendor's party uid in the estate. */
export const vendorUid = (id: string): string => `organization:vendor:${id}`;

/** One accepted risk, with where it applies. */
export interface ScopedAcceptance extends Acceptance {
  /** "fleet" (controls/accepted.ts), or the adopted machine it belongs to. */
  scope: string;
}

/** Every accepted risk: the fleet's (controls/accepted.ts) and each adopted machine's. */
export function allAcceptances(
  accepted: readonly Acceptance[] = [],
  adopted: ReadonlyArray<{ machine: AdoptedDef }> = [],
): ScopedAcceptance[] {
  return [
    ...accepted.map((a) => ({ ...a, scope: "fleet" })),
    ...adopted.flatMap(({ machine }) =>
      (machine.accepted ?? []).map((a) => ({ ...a, scope: machine.name })),
    ),
  ];
}

/** An accepted risk's uid: `<pack>/<control>` for the fleet's, `<machine>:<policy>` for a machine's. */
export const acceptanceUid = (a: ScopedAcceptance): string =>
  a.scope === "fleet" ? a.policy : `${a.scope}:${a.policy}`;

/** What {@link addRiskData} loads. */
export interface RiskData {
  /** The register (undefined: there is no risks.ts). */
  risks?: readonly Risk[];
  /** Every accepted risk. */
  acceptances?: readonly ScopedAcceptance[];
  /** The vendors, discovered and triaged. */
  vendors?: readonly Vendor[];
  /** Now. */
  now?: Date;
}

/** Load the register, the accepted risks, and the vendors into an estate (idempotent). */
export function addRiskData(e: Estate, d: RiskData): void {
  e.db.exec(riskSchemaSql());
  // A json column takes its value as it is (rowParams writes it as JSON), which RowOf types as text.
  const put = <C extends Record<string, Column>>(
    t: TableDef<C>,
    row: Record<string, unknown>,
  ): void => {
    e.db.prepare(upsertSql(t)).run(...rowParams(t, row as RowOf<C>));
  };
  for (const r of d.risks ?? []) {
    put(risk, {
      risk_uid: r.id,
      title: r.title,
      description: r.description,
      likelihood: r.likelihood,
      impact: r.impact,
      level: r.level,
      owner: r.owner.toLowerCase(),
      treatment: r.treatment,
      scf_controls: [...r.scf],
      accepted: [...(r.accepted ?? [])],
      next_review: r.nextReview,
      status: r.status,
    });
  }
  for (const a of d.acceptances ?? []) {
    put(poamItem, {
      poam_item_uid: acceptanceUid(a),
      policy_id: a.policy,
      scope: a.scope,
      reason: a.reason,
      accepted_by: a.by,
      until: a.until,
    });
  }
  const at = (d.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  for (const v of d.vendors ?? []) {
    const uid = vendorUid(v.id);
    put(party, { party_uid: uid, party_type: "organization" });
    put(organization, { party_uid: uid, name: v.name });
    // UDM's supplier role (The Data Model Resource Book, Vol. 1: organization roles).
    put(partyRole, {
      party_uid: uid,
      role_type: "supplier",
      source: v.seen[0]?.source ?? "vendors.ts",
    });
    for (const s of v.seen) {
      put(edge, {
        src_uid: uid,
        verb: "supplies",
        dst_uid: s.uid,
        source: s.source,
        basis: s.kind === "dns" ? "hostname" : "native",
        first_seen: at,
        last_seen: at,
      });
    }
    if (v.triage) {
      put(dataClassification, {
        party_uid: uid,
        criticality: v.triage.criticality,
        categories: [...v.triage.data],
        owner: v.triage.owner ?? null,
      });
    }
  }
}

const n = (r: Row[]) => Number(r[0]?.["n"] ?? 0);
const list = (r: Row[], f: (x: Row) => string) =>
  r.slice(0, 12).map(f).join(", ") + (r.length > 12 ? `, and ${r.length - 12} more` : "");

/** Every open risk is reviewed by its next review date. */
export const reviewDue: EstateControl = defineControl({
  id: "review-due",
  title: "Every open risk is reviewed by its next review date",
  scf: ["RSK-14", "RSK-13.2"],
  subject: "estate",
  query:
    "SELECT risk_uid AS uid, title, owner, next_review FROM risk WHERE status = 'open' ORDER BY next_review, risk_uid",
  assert: (rows, { now }) => {
    if (!rows.length) {
      return {
        status: "warn",
        detail: "the risk register lists no open risk (fleets/<fleet>/risks.ts)",
        fix: "write the register: fleets/<fleet>/risks.ts (bun run stolos docs risks)",
      };
    }
    const due = rows.filter((r) => txt(r["next_review"]) < today(now));
    return {
      status: due.length ? "fail" : "pass",
      detail: due.length
        ? `${due.length} of ${rows.length} overdue: ${list(
            due,
            (r) => `${txt(r["uid"])} (due ${txt(r["next_review"])}, ${txt(r["owner"])})`,
          )}`
        : `${rows.length} open risk(s), each reviewed on time; next ${String(rows[0]?.["next_review"])}`,
      subjects: due.map((r) => txt(r["uid"])),
    };
  },
  fix: "review each overdue risk with its owner: bun run stolos risks review <id> (a signed pull request)",
});

/** Every open risk's owner is an active person on the roster. */
export const ownerOnRoster: EstateControl = defineControl({
  id: "owner-on-roster",
  title: "Every open risk's owner is an active person on the roster",
  scf: ["RSK-11"],
  subject: "estate",
  query: {
    people: "SELECT count(*) AS n FROM person",
    owners: `SELECT r.risk_uid AS uid, r.owner,
      (SELECT count(*) FROM user_inventory u WHERE lower(u.email_addr) = r.owner AND u.status = 'active') AS active
      FROM risk r WHERE r.status = 'open' ORDER BY r.risk_uid`,
  },
  assert: ({ people, owners }) => {
    if (!owners.length) return undefined;
    if (!n(people)) {
      return {
        status: "unknown",
        detail: "no roster to check the owners against (no HR system or identity provider)",
        fix: "connect the HR system or the identity provider: bun run stolos connect",
      };
    }
    const off = owners.filter((r) => !Number(r["active"]));
    return {
      status: off.length ? "warn" : "pass",
      detail: off.length
        ? `${off.length} risk(s) owned by someone not active on the roster: ${list(
            off,
            (r) => `${txt(r["uid"])} (${txt(r["owner"])})`,
          )}`
        : `${owners.length} risk(s), each owned by an active person`,
      subjects: off.map((r) => txt(r["uid"])),
    };
  },
  fix: "give each a new owner in risks.ts (a person on the roster), through a pull request",
});

/** Accepted risks are current, and each is in the register. */
export const acceptedCurrent: EstateControl = defineControl({
  id: "accepted-current",
  title: "Every accepted risk is current and in the risk register",
  scf: ["RSK-16.1"],
  subject: "estate",
  query: {
    items:
      "SELECT poam_item_uid AS uid, scope, accepted_by, until FROM poam_item ORDER BY poam_item_uid",
    links:
      "SELECT r.risk_uid AS risk, j.value AS link FROM risk r, json_each(r.accepted) j ORDER BY r.risk_uid",
  },
  assert: ({ items, links }, { now }) => {
    if (!items.length && !links.length) return undefined;
    const day = today(now);
    const ids = new Set(items.map((i) => txt(i["uid"])));
    const linked = new Set(links.map((l) => txt(l["link"])));
    const expired = items.filter((i) => txt(i["until"]) < day);
    const broken = links.filter((l) => !ids.has(txt(l["link"])));
    const loose = items.filter((i) => !linked.has(txt(i["uid"])) && txt(i["until"]) >= day);
    const parts = [
      expired.length &&
        `${expired.length} past its date: ${list(expired, (i) => `${txt(i["uid"])} (ended ${txt(i["until"])})`)}`,
      broken.length &&
        `${broken.length} link(s) to no accepted risk: ${list(
          broken,
          (l) => `${txt(l["risk"])} -> ${txt(l["link"])}`,
        )}`,
      loose.length && `${loose.length} not in the register: ${list(loose, (i) => txt(i["uid"]))}`,
    ].filter(Boolean);
    return {
      status: expired.length ? "fail" : parts.length ? "warn" : "pass",
      detail: parts.length
        ? parts.join("; ")
        : `${items.length} accepted risk(s), each current and in the register`,
      subjects: [...expired, ...loose].map((i) => txt(i["uid"])),
      ...(expired.length
        ? {}
        : loose.length || broken.length
          ? {
              fix: "link each accepted risk from a risk in risks.ts (accepted: [...]), and fix links that name none",
            }
          : {}),
    };
  },
  fix: "renew each expired acceptance with its owner (a new date and reason, in a signed commit), or fix what it excuses",
});

/** Every discovered vendor is triaged. */
export const vendorsTriaged: EstateControl = defineControl({
  id: "vendors-triaged",
  title: "Every discovered vendor is triaged: its criticality and the data it holds",
  scf: ["TPM-08", "TPM-09"],
  subject: "estate",
  query: `SELECT o.party_uid AS uid, o.name, d.criticality FROM organization o
    JOIN party_role r ON r.party_uid = o.party_uid AND r.role_type = 'supplier'
    LEFT JOIN data_classification d ON d.party_uid = o.party_uid
    ORDER BY o.name`,
  assert: (rows) => {
    if (!rows.length) return undefined;
    const open = rows.filter((r) => !r["criticality"] || r["criticality"] === "unassessed");
    const high = rows.filter((r) => r["criticality"] === "high").length;
    return {
      status: open.length ? "warn" : "pass",
      detail: open.length
        ? `${open.length} of ${rows.length} vendor(s) not triaged: ${list(open, (r) =>
            txt(r["name"]),
          )}`
        : `${rows.length} vendor(s), all triaged (${high} high)`,
      subjects: open.map((r) => txt(r["uid"])),
    };
  },
  fix: "bun run stolos vendors triage --write (a pull request adding them to vendors.ts), then set each one's criticality and data",
});

/** The risk register and vendor inventory's controls, as a pack (results `risk-register/<control>`). */
export const RISK_PACK: ControlPack = defineControlPack({
  id: "risk-register",
  title: "Risk register and vendors",
  version: "1.0.0",
  description: "Spec 080: the risk register (risks.ts) and the vendor inventory (vendors.ts).",
  controls: [reviewDue, ownerOnRoster, acceptedCurrent, vendorsTriaged],
});

/** What {@link runRiskPack} needs. */
export interface RiskRunInputs extends RiskData {
  /** The estate graph (augmented in place). */
  estate: Estate;
  /** The fleet's accepted risks (controls/accepted.ts), applied to these results too. */
  accepted?: readonly Acceptance[];
  /** Adopted machines (their accepted risks). */
  adopted?: ReadonlyArray<{ machine: AdoptedDef }>;
  /** Why the register or the triage file did not load (each becomes a failing result). */
  problems?: readonly string[];
}

/** Load the data into the estate and run the pack; a file that did not load is a failing result. */
export async function runRiskPack(i: RiskRunInputs): Promise<PackRun> {
  const now = i.now ?? new Date();
  addRiskData(i.estate, {
    ...i,
    acceptances: i.acceptances ?? allAcceptances(i.accepted, i.adopted),
    now,
  });
  const run = await runPack(RISK_PACK, {
    estate: i.estate,
    accepted: i.accepted ?? [],
    ...(i.adopted ? { adopted: i.adopted } : {}),
    now,
  });
  for (const p of i.problems ?? []) {
    run.results.unshift({
      id: `${RISK_PACK.id}/loads`,
      control: "loads",
      subject: "the fleet repository",
      title: "The risk register and the vendor triage file load",
      scf: ["RSK-14"],
      status: "fail",
      detail: p,
      fix: "fix the file (bun run check names the line), then bun run stolos risks check",
    });
  }
  return run;
}
