/**
 * Spec 077: quarterly access reviews, written from the estate graph. Each
 * manager (the people others report to, `party_relationship` `reports_to`)
 * gets one Markdown file per quarter, `people/reviews/<quarter>/<manager>.md`:
 * each report's active accounts (`has_account` edges) with their admin
 * rights, one line each, unticked. The manager ticks each line they confirm
 * (and removes, in the system itself, any access they do not) and commits it
 * signed: that commit is the approval.
 *
 * ```mermaid
 * flowchart LR
 *   estate[("estate graph: reports_to, has_account")] --> files["reviewFiles: one per manager"]
 *   files --> branch["a branch, a pull request"]
 *   branch --> tick["the manager ticks each line: a signed commit"]
 *   tick --> main["merged to main, signatures kept"]
 *   main --> control["people-access-reviews: approved?"]
 * ```
 *
 * @module
 */

import { type Estate, estateQuery } from "../estate/graph.ts";
import type { Quarter } from "./records.ts";

/** One review file to write. */
export interface ReviewFile {
  /** The manager (work email). */
  manager: string;
  /** Its path under the fleet: `people/reviews/<quarter>/<manager>.md`. */
  path: string;
  /** Its text. */
  text: string;
  /** How many lines there are to tick. */
  lines: number;
}

/** The reports, and their active accounts, of every manager with someone still employed. */
export const REVIEW_SQL =
  `SELECT r.to_party_uid AS manager, p.uid, p.email_addr AS email, p.type, p.status,
  a.connector AS system, a.display_name AS account, a.admin
FROM party_relationship r
JOIN user_inventory p ON p.uid = r.from_party_uid
LEFT JOIN edge e ON e.src_uid = p.uid AND e.verb = 'has_account'
LEFT JOIN user_account a ON a.user_account_uid = e.dst_uid AND a.active = 1
WHERE r.party_relationship_type = 'reports_to' AND p.status IN ('active', 'leave')
ORDER BY r.to_party_uid, p.email_addr, a.connector, a.display_name`;

/** A party uid's work email ("person:alice@example.org" to "alice@example.org"). */
export const emailOf = (uid: string): string => uid.replace(/^person:/, "");

/** The review files of a quarter, one per manager, from the estate graph. */
export function reviewFiles(e: Estate, quarter: Quarter, now = new Date()): ReviewFile[] {
  const rows = estateQuery(e, REVIEW_SQL);
  const byManager = new Map<
    string,
    Map<string, { type?: string; status: string; lines: string[] }>
  >();
  for (const r of rows) {
    const m = emailOf(String(r.manager));
    const reports = byManager.get(m) ?? new Map();
    byManager.set(m, reports);
    const email = String(r.email ?? emailOf(String(r.uid)));
    const p = reports.get(email) ??
      { ...(r.type ? { type: String(r.type) } : {}), status: String(r.status), lines: [] };
    reports.set(email, p);
    if (r.system) {
      p.lines.push(`${r.system}: ${r.account}${Number(r.admin) === 1 ? " (admin)" : ""}`);
    }
  }
  const day = now.toISOString().slice(0, 10);
  const out: ReviewFile[] = [];
  for (const [manager, reports] of [...byManager].sort(([a], [b]) => a.localeCompare(b))) {
    const body: string[] = [];
    let lines = 0;
    for (const [email, p] of reports) {
      body.push(
        "",
        `## ${email}${
          p.type
            ? ` (${p.type}${p.status === "leave" ? ", on leave" : ""})`
            : p.status === "leave"
            ? " (on leave)"
            : ""
        }`,
        "",
      );
      const items = p.lines.length ? [...new Set(p.lines)] : ["no active accounts"];
      for (const l of items) body.push(`- [ ] ${l}`);
      lines += items.length;
    }
    const text = [
      "---",
      `quarter: ${quarter}`,
      `manager: ${manager}`,
      `generated: ${day}`,
      "---",
      "",
      `# Access review ${quarter}: ${manager}`,
      "",
      "Tick each line you confirm: change `- [ ]` to `- [x]`. Access a report should not have: remove it",
      "in that system first, then tick the line and say so after it. Commit the file signed with your own",
      "key (or ask a fleet signer to): that signed commit is your approval.",
      ...body,
      "",
    ].join("\n");
    out.push({ manager, path: `people/reviews/${quarter}/${manager}.md`, text, lines });
  }
  return out;
}

/** How many lines of a review are ticked, of how many. */
export function reviewTicks(text: string): { ticked: number; lines: number } {
  const items = [...text.matchAll(/^\s*[-*] \[( |x|X)\] /gm)];
  return { ticked: items.filter((m) => m[1] !== " ").length, lines: items.length };
}
