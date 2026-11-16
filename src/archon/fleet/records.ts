/**
 * Spec 099 (FR-006): the files in a fleet repository that Stolos writes itself, as records of what
 * happened (an install's registration, an adoption, an observation). A changed record is expected,
 * not a mistake: `stolos update` sends it (one signed commit, `stolos apply`), and the doctor calls
 * it "not sent yet", never a failure. A person's own edits are different: they are never committed
 * for them without asking.
 *
 * @module
 */
// Spec: 099-engine-update FR-006
// Spec: 100-remote-access FR-006
// Spec: 101-ladder FR-006

import type { FileKind } from "../ontology.auto.ts";

/** What a record is, for people ("olympia's registration, from its install"). */
const RECORDS: Array<{ re: RegExp; what: (m: RegExpMatchArray) => string }> = [
  {
    re: /^fleets\/[^/]+\/hosts\/([^/]+)\/registration\.ts$/,
    what: (m) => `${m[1]}'s registration (from its install)`,
  },
  {
    re: /^fleets\/[^/]+\/adopted\/([^/]+)\/(machine|observed)\.ts$/,
    what: (m) =>
      `${m[1]}, adopted (${m[2] === "observed" ? "what it reported" : "how to reach it"})`,
  },
  { re: /^fleets\/[^/]+\/discovered\.ts$/, what: () => "machines discovered" },
  {
    re: /^fleets\/[^/]+\/devices\/([^/]+)\/observed\.ts$/,
    what: (m) => `${m[1]} (what it reported)`,
  },
  {
    re: /^fleets\/[^/]+\/(clouds|estate)\/[^/]+\.ts$/,
    what: () => "connected accounts' observations",
  },
];

/** A changed file's path from a `git status --porcelain` line ("R  a -> b" gives b). */
export function porcelainPath(line: string): string {
  const p = line.slice(3).trim();
  const i = p.indexOf(" -> ");
  return (i >= 0 ? p.slice(i + 4) : p).replace(/^"|"$/g, "").replace(/\\/g, "/");
}

/** What a changed file is, when Stolos wrote it; undefined for a person's own file. */
export function recordOf(file: string): string | undefined {
  for (const r of RECORDS) {
    const m = file.replace(/\\/g, "/").match(r.re);
    if (m) return r.what(m);
  }
  return undefined;
}

/**
 * Spec 100: files Stolos writes that are decisions, not records: sent by the command that made the
 * decision (signed by whoever decided), never by `stolos update` on its own. Left uncommitted, they
 * are a person's change (update asks), named for what they are.
 */
const DECISIONS: Array<{ re: RegExp; what: string }> = [
  { re: /^fleets\/[^/]+\/access\.ts$/, what: "who may sign in to the console (access.ts)" },
];

/** What a changed decision file is ("who may sign in to the console"); undefined otherwise. */
export function decisionOf(file: string): string | undefined {
  const f = file.replace(/\\/g, "/");
  return DECISIONS.find((d) => d.re.test(f))?.what;
}

/**
 * Spec 101-ladder FR-006: whether a file Stolos writes is a record or a decision, as the ontology's
 * code list `stolos:FileKind` names them; undefined for a person's own file.
 */
export function fileKindOf(file: string): FileKind | undefined {
  if (recordOf(file) !== undefined) return "record";
  return decisionOf(file) !== undefined ? "decision" : undefined;
}

/** A person's changed file for people: a decision's name, else its path. */
export function yoursNamed(file: string): string {
  return decisionOf(file) ?? file;
}

/** Changed files, split: records Stolos wrote (with what each is), and a person's own. */
export function splitChanges(files: readonly string[]): {
  records: Array<{ file: string; what: string }>;
  yours: string[];
} {
  const records: Array<{ file: string; what: string }> = [];
  const yours: string[] = [];
  for (const f of files) {
    const what = recordOf(f);
    if (what) records.push({ file: f, what });
    else yours.push(f);
  }
  return { records, yours };
}
