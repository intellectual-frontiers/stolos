/**
 * Spec 091: what every HR connector declared with the SDK shares. An HR
 * system gives the roster only (the source of truth for who should have
 * access): work email, name, status, start and end dates, manager, and role
 * type. Never compensation, government ids, addresses, birth dates, or other
 * personal fields: each connector reduces the vendor's record to a
 * {@link RosterRow} inside its `list`, so nothing else leaves it.
 *
 * Evidence for account management (SCF IAC-08) and provisioning (IAC-04):
 * the estate graph checks every account against the roster.
 *
 * @module
 */

import { check, fresh, type Observation } from "./connector.ts";
import { emailKey } from "./entities.ts";
import { PERSON } from "./labels.ts";
import type { Ctx, FieldDef, ObservedRecord, ResourceDef } from "./sdk.ts";
import type { Column } from "../schema/define.ts";
import type { PolicyResult } from "../adopt/policy.ts";

/** One person on the roster, reduced to what Stolos keeps. */
export interface RosterRow {
  /** Their id in the HR system. */
  id: string;
  /** Work email (lowercase). */
  email: string;
  /** Their name. */
  name?: string;
  /** active, terminated, leave, or unknown. */
  status: "active" | "terminated" | "leave" | "unknown";
  /** Start date (YYYY-MM-DD). */
  start?: string;
  /** End date (YYYY-MM-DD). */
  end?: string;
  /** Their manager's work email. */
  manager?: string;
  /** Employee, contractor, ... (the source's own word). */
  type?: string;
}

/** A date's YYYY-MM-DD part, or undefined. */
export const day = (s?: string | null): string | undefined =>
  s && /^\d{4}-\d{2}-\d{2}/.test(s) && !s.startsWith("0000") ? s.slice(0, 10) : undefined;

/** A row, with the optional parts left out when unknown (no email: no row). */
export function rosterRow(r: {
  id: string;
  email?: string | null | undefined;
  name?: string | null | undefined;
  status: RosterRow["status"];
  start?: string | null | undefined;
  end?: string | null | undefined;
  manager?: string | null | undefined;
  type?: string | null | undefined;
}): RosterRow | undefined {
  const email = emailKey(r.email ?? undefined);
  if (!email) return undefined;
  const manager = emailKey(r.manager ?? undefined);
  const start = day(r.start);
  const end = day(r.end);
  return {
    id: r.id,
    email,
    status: r.status,
    ...(r.name?.trim() ? { name: r.name.trim() } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(manager ? { manager } : {}),
    ...(r.type ? { type: r.type } : {}),
  };
}

/** The PERSON resource of an HR connector, given how it lists its rows. */
export function rosterResource<F extends Record<string, FieldDef>>(
  list: (ctx: Ctx<F>) => AsyncIterable<RosterRow>,
): ResourceDef<F, RosterRow, Record<string, Column>> {
  return {
    label: PERSON,
    ocsf: "user_inventory",
    async *list(ctx) {
      const since = ctx.now.getTime() - 90 * 86_400_000;
      let left = 0;
      for await (const p of list(ctx)) {
        if (p.status === "terminated" && p.end && Date.parse(p.end) > since) left++;
        yield p;
      }
      ctx.fact("leftLast90Days", left);
    },
    map: (p: RosterRow) => ({
      native_id: p.id,
      display_name: p.name ?? p.email,
      props: {
        email: p.email,
        status: p.status,
        ...(p.name ? { name: p.name } : {}),
        ...(p.start ? { start_date: p.start } : {}),
        ...(p.end ? { end_date: p.end } : {}),
        ...(p.manager ? { manager: p.manager } : {}),
        ...(p.type ? { role_type: p.type } : {}),
      },
    }),
    // People live in the estate graph, not in `estate assets`.
    asset: () => undefined,
  };
}

/**
 * The roster's posture: how many people, how many active, and leavers with
 * no end date (`leftLast90Days` is recorded as the roster is read).
 */
export function rosterPosture(records: ObservedRecord[]): Observation["posture"] {
  const people = records.filter((r) => r.label === "person");
  return {
    people: people.length,
    active: people.filter((r) => r.props["status"] === "active").length,
    leaversWithoutEndDate: people.filter(
      (r) => r.props["status"] === "terminated" && !r.props["end_date"],
    ).length,
  };
}

/** An HR connector's policies: observed lately, and every leaver has an end date. */
export function rosterPolicies(
  id: string,
  title: string,
): (o: Observation, now: number) => PolicyResult[] {
  return (o, now) => [
    fresh(o, now, id),
    check(o, {
      id: `${id}-leaver-dates`,
      title: "Every leaver has an end date",
      scf: ["IAC-08"],
      fact: "leaversWithoutEndDate",
      want: (v) => v === 0,
      show: (v) => `${v} leavers without one`,
      fix: `${title}: record each leaver's termination date, so access is removed on that day`,
      warnOnly: true,
    }),
  ];
}
