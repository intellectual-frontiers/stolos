/**
 * Signing a commit with the person's daily key, and what is said about it (spec 105-calm-output
 * FR-012, FR-013, FR-014): the line that names what is being signed, a wrong passphrase retried in
 * place (three tries, never stored), and the engine upgrade that waits for its signature.
 *
 * @module
 */
// Spec: 105-calm-output FR-012, FR-013, FR-014

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { ui } from "../core/ui.ts";
import { recordOf, yoursNamed } from "./records.ts";

/** How many times a wrong passphrase is tried again in place before the commit fails (spec 105-calm-output FR-013). */
export const PASSPHRASE_TRIES = 3;

/** What git and ssh-keygen say when the key could not be decrypted. */
const WRONG_PASSPHRASE = /incorrect passphrase|bad passphrase|passphrase.*incorrect/i;

/** The message of the commit that adopts an engine version (written by `fleet upgrade`, and by update and apply when they finish one). */
export const adoptMessage = (tag: string): string => `stolos ${tag}: adopt the engine ${tag}`;

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
 * `git commit` with the terminal (the key's passphrase is asked by OpenSSH): a wrong passphrase is
 * said so ("That passphrase didn't unlock your daily key (2 left)") and tried again, up to
 * three times in all. The raw text goes to the run log, not the screen. The passphrase is never read
 * or kept here: it goes from the person to OpenSSH.
 */
export async function commitSigned(repo: string, args: string[]): Promise<SignedCommit> {
  let raw = "";
  for (let n = 1; n <= PASSPHRASE_TRIES; n++) {
    ui.pause();
    let r;
    try {
      r = await proc.output(["git", "-C", repo, "commit", ...args], {
        stdin: "inherit",
        stdout: "piped",
        stderr: "piped",
      });
    } finally {
      ui.resume();
    }
    raw = new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout);
    if (raw.trim()) ui.log(`   git commit: ${raw.trim().replace(/\n/g, " | ")}`);
    if (r.success) return { ok: true, wrongPassphrase: false, raw };
    if (!WRONG_PASSPHRASE.test(raw)) return { ok: false, wrongPassphrase: false, raw };
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
  const m = subject.match(/^stolos (v\d+\.\d+\.\d+): adopt the engine/);
  return m ? `engine upgrade to ${m[1]}` : subject;
}
