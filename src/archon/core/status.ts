/**
 * The prompt's Archon segment (spec 009): every archon command ends by writing
 * one short line to /var/lib/archon/status/prompt, and the oh-my-posh theme
 * only reads that file, so the prompt stays instant. The line says how the
 * last run went, how many disruptive changes wait, and whether the checkout
 * has local commits that are not on GitHub.
 *
 * @module
 */

import { P } from "./paths.ts";
import { run } from "./exec.ts";
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";

/** Where the status files live: `prompt`, `prompt-plain`, `last.json` and `verify.json`. */
export const STATUS_DIR = "/var/lib/archon/status";

// Nerd Font glyphs (the theme already needs a Nerd Font).
const G = {
  ok: "\u{f00c}",
  fail: "\u{f00d}",
  warn: "\u{f071}",
  lock: "\u{f023}",
  push: "\u{f093}",
};

/** How an archon command's run went, as the prompt shows it. */
export interface RunStatus {
  /** The command that ran (`"update"`, `"apply"`). */
  command: string;
  /** How many steps failed. */
  failures: number;
  /** How many steps warned. */
  warnings: number;
  /** How many disruptive changes wait for approval. */
  deferred: number;
}

/** Local commits not on GitHub yet (no network: uses the last fetch). */
export async function pushPending(repo = P.repo): Promise<boolean> {
  const ahead = await run(["git", "-C", repo, "rev-list", "--count", "origin/main..HEAD"]);
  return ahead.ok && Number(ahead.stdout.trim()) > 0;
}

/** The prompt segment with Nerd Font glyphs: the result, deferred changes, and a push marker. */
export function promptLine(s: RunStatus, push: boolean): string {
  const parts = [
    s.failures
      ? `${G.fail} ${s.command}`
      : s.warnings
        ? `${G.warn} ${s.command}`
        : `${G.ok} ${s.command}`,
  ];
  if (s.deferred) parts.push(`${G.lock} ${s.deferred}`);
  if (push) parts.push(`${G.push} push`);
  return parts.join("  ");
}

/** The same status in words, for the plain prompt (spec 036): "update ok, push". */
export function promptLinePlain(s: RunStatus, push: boolean): string {
  const parts = [`${s.command} ${s.failures ? "FAILED" : s.warnings ? "warn" : "ok"}`];
  if (s.deferred) parts.push(`${s.deferred} deferred`);
  if (push) parts.push("push");
  return parts.join(", ");
}

/** The last run, as data (the welcome page reads it; the prompt reads the line). */
export interface LastRun extends RunStatus {
  /** When it was written (ISO 8601). */
  at: string;
  /** Whether the checkout had local commits not on GitHub. */
  push: boolean;
}

/** The last `archon verify` as root (spec 035): the welcome page's "checks now". */
export interface LastVerify {
  /** When it ran (ISO 8601). */
  at: string;
  /** How many checks passed. */
  passed: number;
  /** How many checks ran. */
  total: number;
  /** The resources whose checks failed. */
  failed: string[];
}

async function writeText(name: string, text: string): Promise<void> {
  const tmp = `${STATUS_DIR}/.${name}.${proc.pid}`;
  await fs.writeTextFile(tmp, text, { mode: 0o664 });
  await fs.chmod(tmp, 0o664);
  await fs.rename(tmp, `${STATUS_DIR}/${name}`);
}

async function writeJson(name: string, data: unknown): Promise<void> {
  const tmp = `${STATUS_DIR}/.${name}.${proc.pid}`;
  await fs.writeTextFile(tmp, JSON.stringify(data) + "\n", { mode: 0o664 });
  await fs.chmod(tmp, 0o664);
  await fs.rename(tmp, `${STATUS_DIR}/${name}`);
}

/** Save the last verify for the welcome page (`verify.json`). Best effort: errors are ignored. */
export async function writeVerify(v: LastVerify): Promise<void> {
  try {
    await writeJson("verify.json", v);
  } catch {
    /* no status directory, or not writable */
  }
}

/**
 * Write the run's status: `last.json`, the plain line and the prompt line.
 * Best effort: a host without /var/lib/archon (a workstation) has no segment.
 */
export async function writeStatus(s: RunStatus): Promise<void> {
  try {
    const push = await pushPending();
    await writeJson("last.json", {
      ...s,
      push,
      at: new Date().toISOString(),
    } satisfies LastRun).catch(() => {});
    await writeText("prompt-plain", promptLinePlain(s, push) + "\n").catch(() => {});
    const line = promptLine(s, push);
    const tmp = `${STATUS_DIR}/.prompt.${proc.pid}`;
    await fs.writeTextFile(tmp, line + "\n", { mode: 0o664 });
    await fs.chmod(tmp, 0o664);
    await fs.rename(tmp, `${STATUS_DIR}/prompt`);
  } catch {
    /* no status directory, or not writable */
  }
}
