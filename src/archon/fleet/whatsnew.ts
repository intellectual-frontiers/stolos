/**
 * What's new after an engine upgrade (spec 105-calm-output FR-016): up to five bullets from the
 * engine repository's commit subjects between the old and the new tag, from GitHub's public compare
 * API (unauthenticated; `ARCHON_GITHUB_API` names a mirror), and every commit-body line that
 * begins `Operator action:` as something for the person to do. A lookup that fails says nothing.
 *
 * @module
 */
// Spec: 105-calm-output FR-016

import { proc } from "@intellectual-frontiers/commons/ts/runtime";

/** The engine's public repository, whose commits the compare lists whatever mirror the fleet installs it from. */
export const ENGINE_REPOSITORY = "intellectual-frontiers/stolos";

/** What an upgrade brought, for people. */
export interface WhatsNew {
  /** Up to five subjects, newest first, deduplicated. */
  bullets: string[];
  /** Each `Operator action:` line of a commit body. */
  actions: string[];
}

/** How many bullets are shown. */
export const MAX_BULLETS = 5;

/** A commit subject without the noise a person does not need ("spec ", a pull request's number), keeping the spec's id. */
export function tidySubject(subject: string): string {
  return subject
    .trim()
    .replace(/^spec\s+/i, "")
    .replace(/\s*\(#\d+\)$/, "")
    .replace(/\s+/g, " ");
}

/** The bullets and operator actions in commit messages, oldest first as the API lists them. */
export function summarizeCommits(messages: readonly string[]): WhatsNew {
  const bullets: string[] = [];
  const actions: string[] = [];
  for (const message of [...messages].reverse()) {
    const [subject = "", ...body] = message.split("\n");
    const s = tidySubject(subject);
    if (s && !/^(merge |version bump)/i.test(s) && !bullets.includes(s)) bullets.push(s);
    for (const line of body) {
      const m = line.match(/^\s*Operator action:\s*(.+?)\s*$/);
      if (m?.[1] && !actions.includes(m[1])) actions.push(m[1]);
    }
  }
  return { bullets: bullets.slice(0, MAX_BULLETS), actions };
}

/** What the engine brought between two tags; empty (never an error) where GitHub cannot be asked. */
export async function whatsNew(from: string, to: string, timeoutMs = 5000): Promise<WhatsNew> {
  const api = (proc.env.get("ARCHON_GITHUB_API") ?? "https://api.github.com").replace(/\/$/, "");
  try {
    const r = await fetch(`${api}/repos/${ENGINE_REPOSITORY}/compare/${from}...${to}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { bullets: [], actions: [] };
    const d: unknown = await r.json();
    const commits =
      typeof d === "object" && d !== null && "commits" in d && Array.isArray(d.commits)
        ? (d.commits as unknown[])
        : [];
    const messages = commits.flatMap((c) => {
      const m =
        typeof c === "object" && c !== null && "commit" in c
          ? (c.commit as { message?: unknown } | null)?.message
          : undefined;
      return typeof m === "string" ? [m] : [];
    });
    return summarizeCommits(messages);
  } catch {
    return { bullets: [], actions: [] };
  }
}
