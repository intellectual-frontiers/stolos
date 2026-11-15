/**
 * Spec 077: what a fleet keeps about its people, beside the estate graph,
 * and how Stolos reads it. Every file is in `fleets/<fleet>/` and is read as
 * a TypeScript literal (never run), so a past version from Git reads the
 * same way:
 *
 * - `people/roles.ts`: which connected systems each role needs (`roles`);
 * - `people/keys.ts`: each person's own SSH public key, by work email (`keys`);
 * - `people/training.ts` and `people/screening.ts`: the records (`training`,
 *   `screening`), with no more than a control needs;
 * - `policies/<policy>.md`: each policy, with its front matter;
 * - `policies/acks/<policy>.ts`: who acknowledged which version (`acks`);
 * - `people/reviews/<quarter>/<manager>.md`: the access reviews.
 *
 * Connectors may supply training and screening records too (none does yet):
 * a record labeled {@link PERSON_RECORD} is a node of the estate graph, and
 * the controls read it beside the files.
 *
 * ```mermaid
 * flowchart LR
 *   roles["people/roles.ts"] & keys["people/keys.ts"] & tr["people/training.ts"] & sc["people/screening.ts"] --> read["readPeopleFiles"]
 *   pol["policies/*.md"] --> parse["parsePolicy: front matter"]
 *   conn["a connector's person_record"] --> estate[("estate graph")]
 *   read & parse & estate --> controls["people controls"]
 * ```
 *
 * @module
 */

import { exportedLiteral } from "../core/ts-literal.ts";
import { defineLabel, type LabelView } from "../schema/define.ts";

/**
 * Which connectors each role needs: the key is a `role_type` from the HR
 * system (employee, contractor, ...), or `"*"` for everyone; the value lists
 * connector ids (google, github, onepassword, ...).
 */
export type RoleMap = Record<string, string[]>;

/** Each person's own SSH public key (`ssh-ed25519 AAAA...`), by work email. */
export type PeopleKeys = Record<string, string>;

/** One training record: who, which course, when, and how it went. */
export interface TrainingRecord {
  /** The person's work email. */
  email: string;
  /** The course (for example "security awareness"). */
  course: string;
  /** When it was completed (YYYY-MM-DD). */
  date: string;
  /** passed or failed. */
  result: "passed" | "failed";
}

/** One screening record: who, which check, when, and its outcome (never the check's details). */
export interface ScreeningRecord {
  /** The person's work email. */
  email: string;
  /** The check (for example "background", "right to work"). */
  check: string;
  /** When it was completed (YYYY-MM-DD). */
  date: string;
  /** clear, or not clear (a decision the record does not explain). */
  result: "clear" | "not clear";
}

/** One acknowledgement of a policy version, as listed in `policies/acks/<policy>.ts`. */
export interface PolicyAck {
  /** The person's work email. */
  email: string;
  /** The policy version acknowledged. */
  version: string;
  /** When (YYYY-MM-DD). */
  date: string;
}

/** A policy: its id (file name) and front matter. */
export interface Policy {
  /** Its id: the file name without `.md`. */
  id: string;
  /** Its title. */
  title: string;
  /** Its version (an acknowledgement names it). */
  version: string;
  /** Who owns it (a work email). */
  owner: string;
  /** When it must next be reviewed (YYYY-MM-DD); overdue after it. */
  review: string;
  /** What is wrong with its front matter (an empty list when nothing is). */
  problems: string[];
}

/**
 * A connector's training and screening records (none supplies them yet: the
 * hook a learning system's or a screening provider's connector fills). Each
 * record is a node of the estate graph with this label; `kind` says which.
 */
export const PERSON_RECORD: LabelView = defineLabel({
  name: "person_record",
  terms: [{ from: "udm", term: "person" }, { from: "d3fend", term: "record" }],
  doc: "A training or screening record about a person, from a connector (spec 077).",
  props: {
    email: { type: "text", doc: "The person's work email." },
    kind: { type: "text", doc: "training or screening.", values: ["training", "screening"] },
    subject: { type: "text", doc: "The course, or the check." },
    date: { type: "text", doc: "When it was completed (YYYY-MM-DD)." },
    result: { type: "text", doc: "passed or failed (training); clear or not clear (screening)." },
  },
});

/** The people files of a fleet, as read. */
export interface PeopleFiles {
  /** people/roles.ts (undefined: none). */
  roles?: RoleMap;
  /** people/keys.ts. */
  keys: PeopleKeys;
  /** people/training.ts (undefined: no file). */
  training?: TrainingRecord[];
  /** people/screening.ts (undefined: no file). */
  screening?: ScreeningRecord[];
  /** Whether the fleet keeps people files at all (a people/ or policies/ folder). */
  inUse: boolean;
  /** The policies, by file name. */
  policies: Policy[];
  /** The acknowledgements each policy's acks file lists. */
  acks: Record<string, PolicyAck[]>;
  /** What could not be read, and why. */
  problems: string[];
}

/** Reads a repository's files (a working tree or a commit): see `gitReader` in the estate. */
export interface FileReader {
  /** A file's text, or undefined. */
  read(path: string): Promise<string | undefined>;
  /** A folder's names (empty when it does not exist). */
  list(dir: string): Promise<string[]>;
}

const lower = (s: string) => s.trim().toLowerCase();

/** The front matter of a Markdown file (`---` lines, `key: value`), and its body. */
export function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return { meta, body: text.slice(m[0].length) };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A policy from its file name and text. */
export function parsePolicy(file: string, text: string): Policy {
  const { meta } = frontMatter(text);
  const id = file.replace(/\.md$/, "");
  const problems: string[] = [];
  for (const k of ["title", "version", "owner", "review"]) {
    if (!meta[k]) problems.push(`policies/${file}: no ${k} in its front matter`);
  }
  if (meta.review && !DATE.test(meta.review)) {
    problems.push(`policies/${file}: review must be a date (YYYY-MM-DD)`);
  }
  return {
    id,
    title: meta.title ?? id,
    version: meta.version ?? "",
    owner: lower(meta.owner ?? ""),
    review: meta.review ?? "",
    problems,
  };
}

/** A policy id is its file name: lower case letters, digits, and hyphens. */
export const POLICY_ID: RegExp = /^[a-z0-9][a-z0-9-]*$/;

/** Read the fleet's people files through a reader (`base` is `fleets/<fleet>`). */
export async function readPeopleFiles(r: FileReader, base: string): Promise<PeopleFiles> {
  const problems: string[] = [];
  const lit = async <T>(path: string, name: string, fallback: T): Promise<T> => {
    const text = await r.read(`${base}/${path}`);
    if (text === undefined) return fallback;
    try {
      return exportedLiteral(text, name) as T;
    } catch (e) {
      problems.push(
        `${path}: ${(e as Error).message} (write it as a literal: export const ${name} = ...)`,
      );
      return fallback;
    }
  };
  const roles = await lit<RoleMap | undefined>("people/roles.ts", "roles", undefined);
  const keys = Object.fromEntries(
    Object.entries(await lit<PeopleKeys>("people/keys.ts", "keys", {})).map((
      [k, v],
    ) => [lower(k), String(v).trim().split(/\s+/).slice(0, 2).join(" ")]),
  );
  const training =
    (await lit<TrainingRecord[] | undefined>("people/training.ts", "training", undefined))
      ?.map((t) => ({ ...t, email: lower(t.email) }));
  const screening =
    (await lit<ScreeningRecord[] | undefined>("people/screening.ts", "screening", undefined))
      ?.map((s) => ({ ...s, email: lower(s.email) }));
  const policyFiles = await r.list(`${base}/policies`);
  const inUse = (await r.list(`${base}/people`)).length > 0 ||
    policyFiles.some((f) => f.endsWith(".md"));
  const policies: Policy[] = [];
  const acks: Record<string, PolicyAck[]> = {};
  for (const f of policyFiles) {
    if (!f.endsWith(".md") || f.toLowerCase() === "readme.md") continue;
    const id = f.replace(/\.md$/, "");
    if (!POLICY_ID.test(id)) {
      problems.push(`policies/${f}: name it in lower case letters, digits, and hyphens`);
      continue;
    }
    const p = parsePolicy(f, (await r.read(`${base}/policies/${f}`)) ?? "");
    problems.push(...p.problems);
    policies.push(p);
    acks[id] = (await lit<PolicyAck[]>(`policies/acks/${id}.ts`, "acks", []))
      .map((a) => ({ ...a, email: lower(a.email) }));
  }
  return {
    ...(roles ? { roles } : {}),
    keys,
    ...(training ? { training } : {}),
    ...(screening ? { screening } : {}),
    inUse,
    policies,
    acks,
    problems,
  };
}

/** A quarter, as `2026-Q4`. */
export type Quarter = string;

/** The quarter a date falls in. */
export function quarterOf(d: Date): Quarter {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** Whether a string is a quarter (`2026-Q4`). */
export function isQuarter(q: string): boolean {
  return /^\d{4}-Q[1-4]$/.test(q);
}

/** The quarter before. */
export function previousQuarter(q: Quarter): Quarter {
  const [y, n] = [Number(q.slice(0, 4)), Number(q.slice(6))];
  return n === 1 ? `${y - 1}-Q4` : `${y}-Q${n - 1}`;
}

/** A quarter's first and last days (YYYY-MM-DD). */
export function quarterDays(q: Quarter): { from: string; to: string } {
  const [y, n] = [Number(q.slice(0, 4)), Number(q.slice(6))];
  const from = new Date(Date.UTC(y, (n - 1) * 3, 1));
  const to = new Date(Date.UTC(y, n * 3, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** The quarters that overlap a period (dates, both included), oldest first. */
export function quartersIn(from: string, to: string): Quarter[] {
  const out: Quarter[] = [];
  let q = quarterOf(new Date(`${to}T00:00:00Z`));
  const first = quarterOf(new Date(`${from}T00:00:00Z`));
  for (;;) {
    out.unshift(q);
    if (q <= first) break;
    q = previousQuarter(q);
  }
  return out;
}
