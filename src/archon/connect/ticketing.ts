/**
 * Spec 087: what the ticketing connectors (Jira, Linear) share: how a ticket
 * is classed (change, incident, or other), how commit SHAs and pull request
 * URLs are found in the links a ticket carries, the tickets' posture, and the
 * policies on it. Evidence for change control (SCF CHG-03): a change that
 * shipped links the commit or pull request it shipped in.
 *
 * @module
 */

import { check, type Observation } from "./connector.ts";
import type { ObservedRecord } from "./sdk.ts";
import type { PolicyResult } from "../adopt/policy.ts";

/** How far back tickets are read (days). */
export const TICKET_DAYS = 90;

/** At most this many tickets are read per observation. */
export const TICKET_MAX = 1000;

/** A ticket's type from its issue type, project, or labels (the source's own words). */
export function ticketType(...words: Array<string | undefined>): "change" | "incident" | "other" {
  const w = words.filter(Boolean).join(" ").toLowerCase();
  if (/\b(incident|outage|sev[ -]?\d|postmortem|post-mortem)\b/.test(w)) return "incident";
  if (/\b(change|changes|rfc|release|deployment)\b/.test(w)) return "change";
  return "other";
}

/** The commit SHAs and pull (or merge) request URLs among a ticket's links, deduplicated, in order. */
export function devLinks(urls: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    const sha = u.match(/\/commits?\/([0-9a-f]{7,40})\b/i)?.[1];
    if (sha) out.push(sha.toLowerCase());
    else if (/\/(pull|pull-requests|merge_requests)\/\d+/.test(u)) out.push(u);
  }
  return [...new Set(out)];
}

/** The tickets' posture: changes, how many link their development work, incidents. */
export function ticketPosture(records: ObservedRecord[]): Observation["posture"] {
  const tickets = records.filter((r) => r.label === "ticket");
  const changes = tickets.filter((r) => r.props["type"] === "change");
  const done = changes.filter((r) => r.props["resolved"]);
  const linked = (r: ObservedRecord) =>
    ((r.props["links"] as unknown[] | undefined) ?? []).length > 0 ||
    Number(r.props["commits"] ?? 0) > 0 ||
    Number(r.props["pull_requests"] ?? 0) > 0;
  const incidents = tickets.filter((r) => r.props["type"] === "incident");
  const members = records.filter((r) => r.label === "user_account" && r.props["active"]);
  const adminKnown = members.some((r) => typeof r.props["admin"] === "boolean");
  return {
    tickets: tickets.length,
    changeTickets: changes.length,
    resolvedChanges: done.length,
    resolvedChangesUnlinked: done.filter((r) => !linked(r)).length,
    incidents: incidents.length,
    openIncidents: incidents.filter((r) => !r.props["resolved"]).length,
    activeMembers: members.length,
    ...(adminKnown ? { admins: members.filter((r) => r.props["admin"]).length } : {}),
  };
}

/** The ticketing policies, in the vendor's words (ids prefixed with `prefix`). */
export function ticketPolicies(
  o: Observation,
  prefix: string,
  fix: { changes: string; link: string; admins: string },
): PolicyResult[] {
  return [
    check(o, {
      id: `${prefix}-changes`,
      title: `Changes are recorded as tickets (last ${TICKET_DAYS} days)`,
      scf: ["CHG-03"],
      fact: "changeTickets",
      want: (v) => typeof v === "number" && v > 0,
      show: (v) => `${v} change ticket(s) of ${o.posture["tickets"]}`,
      fix: fix.changes,
      warnOnly: true,
    }),
    check(o, {
      id: `${prefix}-changes-linked`,
      title: "Every resolved change links the commit or pull request it shipped in",
      scf: ["CHG-03"],
      fact: "resolvedChangesUnlinked",
      want: (v) => v === 0,
      show: (v) =>
        `${v} of ${o.posture["resolvedChanges"]} resolved changes link no commit or pull request`,
      fix: fix.link,
    }),
    check(o, {
      id: `${prefix}-admins`,
      title: "Two to four administrators",
      scf: ["IAC-30"],
      fact: "admins",
      want: (v) => typeof v === "number" && v >= 2 && v <= 4,
      fix: fix.admins,
      warnOnly: true,
    }),
  ];
}

/** An ISO time `days` before `now`. */
export function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
}
