/**
 * Spec 099 (FR-005): a passphrase typed in the browser, not the terminal, while the Stolos Console
 * runs a command that signs (`stolos update`, `stolos apply`). OpenSSH asks for a key's passphrase
 * through a helper program when `SSH_ASKPASS` names one and `SSH_ASKPASS_REQUIRE=force`; the
 * console's runs name this file's helper, which asks the console (on 127.0.0.1, with a token made
 * for this console only), and the console shows the question on the page that started the run.
 * The answer goes back to OpenSSH and nowhere else: it is not logged, not stored, and not sent to
 * the page again.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant B as Browser (the run's page)
 *   participant C as Stolos Console (127.0.0.1)
 *   participant K as ssh-keygen (git commit -S)
 *   participant H as askpass helper
 *   K->>H: SSH_ASKPASS "Enter passphrase for ..."
 *   H->>C: POST /askpass (token)
 *   C->>B: a passphrase field (and the HTTP warning)
 *   B->>C: POST /askpass/answer (the session)
 *   C->>H: the passphrase
 *   H->>K: the passphrase (standard output)
 * ```
 *
 * @module
 */
// Spec: 099-engine-update FR-005

import { fs, path, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";

/** How long a question waits for the browser before OpenSSH is told no. */
export const ASK_TIMEOUT_MS = 5 * 60_000;

/** One question waiting for the browser. */
export interface Question {
  /** Its id (in the page's form). */
  id: string;
  /** What OpenSSH asks ("Enter passphrase for ..."). */
  prompt: string;
}

/** The console's side: questions from the helper, answers from the browser. */
export class Askpass {
  /** The token the helper must present (made for this console, never shown in a page). */
  readonly token: string = randomHex(32);
  private readonly waiting = new Map<string, (answer: string | undefined) => void>();
  /** Told about each new question (the running page shows it); unset when no page is running. */
  onAsk: ((q: Question) => void) | undefined;

  /** A question from the helper: the browser's answer, or undefined (cancelled, nobody, timed out). */
  ask(prompt: string, timeoutMs = ASK_TIMEOUT_MS): Promise<string | undefined> {
    if (!this.onAsk) return Promise.resolve(undefined);
    const id = randomHex(12);
    return new Promise((resolve) => {
      const t = setTimeout(() => this.answer(id, undefined), timeoutMs);
      this.waiting.set(id, (a) => {
        clearTimeout(t);
        resolve(a);
      });
      this.onAsk?.({ id, prompt: prompt.slice(0, 200) });
    });
  }

  /** The browser's answer to a question (undefined: cancelled); false when it is not waiting. */
  answer(id: string, answer: string | undefined): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    this.waiting.delete(id);
    w(answer);
    return true;
  }

  /** Cancel every waiting question (the run ended). */
  cancelAll(): void {
    for (const id of [...this.waiting.keys()]) this.answer(id, undefined);
  }
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Whether the helper's token is the console's (compared in constant time). */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Write the helper OpenSSH runs (a shell script, or on Windows a `.cmd`: OpenSSH for Windows
 * starts a batch file, not a script), and the environment a run needs to use it.
 */
export async function askpassEnv(
  dir: string,
  url: string,
  a: Askpass,
): Promise<Record<string, string>> {
  const { engineCommand } = await import("../install/bun.ts");
  const self = path.fromFileUrl(import.meta.url);
  const argv = [...engineCommand(), self];
  await fs.mkdir(dir, { recursive: true });
  let helper: string;
  if (proc.build.os === "windows") {
    helper = path.join(dir, "stolos-askpass.cmd");
    await fs.writeTextFile(helper, `@${argv.map((x) => `"${x}"`).join(" ")} %*\r\n`);
  } else {
    helper = path.join(dir, "stolos-askpass.sh");
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    await fs.writeTextFile(helper, `#!/bin/sh\nexec ${argv.map(q).join(" ")} "$@"\n`);
    await fs.chmod(helper, 0o700);
  }
  return {
    SSH_ASKPASS: helper,
    SSH_ASKPASS_REQUIRE: "force",
    // Older OpenSSH uses the helper only with a display set.
    DISPLAY: proc.env.get("DISPLAY") ?? ":0",
    STOLOS_ASKPASS_URL: `${url.replace(/\/$/, "")}/askpass`,
    STOLOS_ASKPASS_TOKEN: a.token,
  };
}

// The helper itself: OpenSSH runs it with the prompt as its argument and reads the answer.
if (import.meta.main) {
  const url = proc.env.get("STOLOS_ASKPASS_URL") ?? "";
  const token = proc.env.get("STOLOS_ASKPASS_TOKEN") ?? "";
  const prompt = proc.args.join(" ") || "Passphrase:";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "x-stolos-askpass": token, "content-type": "text/plain; charset=utf-8" },
      body: prompt,
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS + 30_000),
    });
    if (r.status !== 200) proc.exit(1);
    stdio.stdout.writeSync(`${await r.text()}\n`);
    proc.exit(0);
  } catch {
    proc.exit(1);
  }
}
