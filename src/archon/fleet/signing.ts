/**
 * Signing a commit with the person's daily key, and what is said about it (spec 105-calm-output
 * FR-012, FR-013, FR-014): the line that names what is being signed, a wrong passphrase retried in
 * place (three tries), and the engine upgrade that waits for its signature. The passphrase is asked
 * once per command and kept only in its memory (spec 106-one-passphrase-speed): it goes from the
 * person to the command's session and from there to OpenSSH, never to a file, a log or an argument.
 *
 * @module
 */
// Spec: 105-calm-output FR-012, FR-013, FR-014
// Spec: 106-one-passphrase-speed FR-001 to FR-004
// Spec: 114-release-record FR-007

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { passphrases } from "../core/passphrase.ts";
import { ui } from "../core/ui.ts";
import { recordOf, yoursNamed } from "./records.ts";

/** How many times a wrong passphrase is tried again in place before the commit fails (spec 105-calm-output FR-013). */
export const PASSPHRASE_TRIES = 3;

/** What git and ssh-keygen say when the key could not be decrypted. */
const WRONG_PASSPHRASE = /incorrect passphrase|bad passphrase|passphrase.*incorrect/i;

/** The message of the commit that adopts an engine version (written by `fleet upgrade`, and by update and apply when they finish one). */
export const adoptMessage = (tag: string): string => `stolos: adopt the engine ${tag}`;

/** What `git commit` came to. */
export interface SignedCommit {
  /** The commit was made. */
  ok: boolean;
  /** It failed because the passphrase did not unlock the key, every time. */
  wrongPassphrase: boolean;
  /** The raw text git and ssh-keygen wrote (for the run log). */
  raw: string;
}

/**
 * `git commit`, signed: the key's passphrase is asked once for the whole command and kept only in its
 * memory (spec 106-one-passphrase-speed FR-001 to FR-003), whatever number of commits it signs. A
 * wrong passphrase is said so ("That passphrase didn't unlock your daily key (2 left)") and tried
 * again, up to three times in all; what was typed replaces what was kept only after it unlocked the
 * key. The raw text goes to the run log, not the screen, and the passphrase to no log at all.
 */
export async function commitSigned(repo: string, args: string[]): Promise<SignedCommit> {
  const session = passphrases();
  // Which key signs here: two keys are two passphrases (OpenSSH's prompt does not always say).
  const scope = (
    await run(["git", "-C", repo, "config", "--get", "user.signingkey"])
  ).stdout.trim();
  let raw = "";
  for (let n = 1; n <= PASSPHRASE_TRIES; n++) {
    ui.pause();
    let r;
    try {
      r = await proc.output(["git", "-C", repo, "commit", ...args], {
        stdin: "inherit",
        stdout: "piped",
        stderr: "piped",
        env: await session.signingEnv(scope),
      });
    } finally {
      ui.resume();
    }
    raw = new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout);
    if (raw.trim()) ui.log(`   git commit: ${raw.trim().replace(/\n/g, " | ")}`);
    const wrong = !r.success && WRONG_PASSPHRASE.test(raw);
    await session.settle(r.success ? "unlocked" : wrong ? "refused" : "failed");
    if (r.success) return { ok: true, wrongPassphrase: false, raw };
    if (!wrong) return { ok: false, wrongPassphrase: false, raw };
    const left = PASSPHRASE_TRIES - n;
    if (left > 0) ui.live(`That passphrase didn't unlock your daily key (${left} left)`);
  }
  return { ok: false, wrongPassphrase: true, raw };
}

/**
 * What is being sent, for people (spec 105-calm-output FR-012): Stolos's own records and engine
 * upgrades by what they are, anything else by its file name.
 */
export function describeSigning(files: readonly string[], upgrade?: { to: string }): string {
  if (upgrade) return `engine upgrade to ${upgrade.to}`;
  const names = [
    ...new Set(
      files.map((f) => recordOf(f.replace(/\\/g, "/")) ?? yoursNamed(f.replace(/\\/g, "/"))),
    ),
  ];
  return names.length > 5
    ? `${names.slice(0, 5).join(", ")}, ${names.length - 5} more`
    : names.join(", ");
}

/** A commit's subject for people: an engine upgrade by what it is, else the subject as written. */
export function describeCommit(subject: string): string {
  const m = subject.match(/^stolos: adopt the engine (stolos-v\d+\.\d+\.\d+)/);
  return m ? `engine upgrade to ${m[1]}` : subject;
}
