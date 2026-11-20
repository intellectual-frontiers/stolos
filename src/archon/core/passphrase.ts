/**
 * One passphrase per command (spec 106-one-passphrase-speed): the daily key's passphrase, asked
 * once and kept only in the memory of the command that signs, so that a run which signs twice (a
 * record, then an engine upgrade) or starts a child run does not ask twice.
 *
 * The passphrase is bytes in this process's memory from the first time it is asked until the
 * command ends, then zeroed. It reaches OpenSSH only through a per-run askpass helper (`SSH_ASKPASS`,
 * a `.cmd` on Windows) that asks this process over 127.0.0.1 with a token made for this run: never
 * through an environment variable, a file, a log, an argument, telemetry or MCP. A child process (a
 * nested run that needs a new engine) inherits the helper's address and token, not the passphrase,
 * and asks the same process. A passphrase is kept only after it unlocked the key.
 *
 * ```mermaid
 * flowchart LR
 *   K["ssh-keygen<br/>(git commit -S)"] -->|"SSH_ASKPASS"| H["askpass helper"]
 *   H -->|"POST /ask, token<br/>127.0.0.1"| B["broker"]
 *   B --> S["PassphraseSession<br/>(bytes in memory)"]
 *   S -->|"first time only"| P["the person: terminal,<br/>no echo, or the console's page"]
 *   C["a child run"] -->|"the same helper"| H
 * ```
 *
 * @module
 */
// Spec: 106-one-passphrase-speed FR-001 to FR-005

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fs, path, proc, stdio, tty } from "@intellectual-frontiers/system";
import { runtimeCommand } from "../install/bun.ts";
import { SIGNING_OUTCOMES, type SigningOutcome } from "../ontology.auto.ts";
import { ui } from "./ui.ts";

/** The header the helper presents (a token made for this run; it is not the passphrase). */
export const TOKEN_HEADER = "x-stolos-askpass";
/** Where a child run finds the broker (set only for the processes a command starts for signing). */
export const ENV_URL = "STOLOS_PASSPHRASE_URL";
/** The token a child run presents. */
export const ENV_TOKEN = "STOLOS_PASSPHRASE_TOKEN";
/** The helper program a child run points OpenSSH at. */
export const ENV_HELPER = "STOLOS_PASSPHRASE_HELPER";
/** Which key a signing attempt uses (its file), so two keys are two passphrases: set for one `git commit` only. */
export const ENV_SCOPE = "STOLOS_PASSPHRASE_SCOPE";
/** The header the helper carries the scope in. */
export const SCOPE_HEADER = "x-stolos-scope";

/** How long the person has to answer before OpenSSH is told no. */
export const ASK_TIMEOUT_MS = 5 * 60_000;

/** How long the end of a command waits for the broker to close (spec 106-one-passphrase-speed FR-002). */
export const WIPE_LIMIT_MS = 3_000;

/** Whether two strings are equal, compared in constant time. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** A random hexadecimal token. */
function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Read a secret byte by byte, as a terminal in raw mode gives it (no echo): Enter ends it, Backspace
 * takes one character back, Ctrl+U everything, Ctrl+C and Ctrl+D (on an empty line) cancel. `next`
 * gives each byte, or null at the end of the input. The bytes are never made into a string.
 */
export async function collectSecret(
  next: () => Promise<number | null>,
): Promise<Uint8Array | undefined> {
  const buf = new Uint8Array(1024);
  let n = 0;
  try {
    for (;;) {
      const b = await next();
      if (b === null) return n ? buf.slice(0, n) : undefined;
      if (b === 0x0d || b === 0x0a) return buf.slice(0, n);
      if (b === 0x03) return undefined;
      if (b === 0x04) {
        if (n === 0) return undefined;
        continue;
      }
      if (b === 0x15) {
        buf.fill(0, 0, n);
        n = 0;
        continue;
      }
      if (b === 0x7f || b === 0x08) {
        // A UTF-8 character is one to four bytes: take back its continuation bytes too.
        while (n > 0 && ((buf[n - 1] ?? 0) & 0xc0) === 0x80) buf[--n] = 0;
        if (n > 0) buf[--n] = 0;
        continue;
      }
      if (n < buf.length) buf[n++] = b;
    }
  } finally {
    buf.fill(0);
  }
}

/** Ask at the terminal with no echo (raw mode); undefined where it was cancelled. */
async function fromTerminal(prompt: string): Promise<Uint8Array | undefined> {
  ui.pause();
  const text = prompt.trim().replace(/:$/, "");
  stdio.stderr.writeSync(`${text} (kept in memory until this command ends): `);
  const one = new Uint8Array(1);
  tty.setRaw(true);
  try {
    return await collectSecret(async () => {
      const got = await stdio.stdin.read(one);
      return got === null || got === 0 ? null : (one[0] ?? null);
    });
  } finally {
    one.fill(0);
    tty.setRaw(false);
    stdio.stderr.writeSync("\n");
    ui.resume();
  }
}

/** Ask the askpass program the environment names (the console's page, a desktop's, a test's). */
async function fromAskpass(
  program: string,
  prompt: string,
  limitMs: number,
): Promise<Uint8Array | undefined> {
  // A program that never answers is stopped at the limit, and the race below lets go of it even
  // where stopping it leaves a child holding its pipes (Windows): nothing waits forever on it.
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(undefined);
    }, limitMs);
  });
  const asked = proc.output([program, prompt], {
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
    signal: stop.signal,
    killAfterMs: 1000,
  });
  asked.catch(() => undefined);
  let r: Awaited<typeof asked> | undefined;
  try {
    r = await Promise.race([asked, cut]);
  } catch {
    r = undefined;
  } finally {
    clearTimeout(timer);
  }
  if (!r?.success) return undefined;
  let end = r.stdout.length;
  while (end > 0 && (r.stdout[end - 1] === 0x0a || r.stdout[end - 1] === 0x0d)) end--;
  const answer = r.stdout.slice(0, end);
  r.stdout.fill(0);
  return answer.length ? answer : undefined;
}

/**
 * Where the person is asked, once (spec 106-one-passphrase-speed FR-004): at the terminal, by this
 * program, with no echo; else through the askpass the environment names (`SSH_ASKPASS`, when it is
 * forced or there is no terminal); else nowhere.
 */
export function askThePerson(
  prompt: string,
  limitMs = ASK_TIMEOUT_MS,
): Promise<Uint8Array | undefined> {
  const askpass = proc.env.get("SSH_ASKPASS") || undefined;
  const terminal = tty.isTerminal("stdin");
  const forced = proc.env.get("SSH_ASKPASS_REQUIRE") === "force";
  if (askpass && (forced || !terminal)) return fromAskpass(askpass, prompt, limitMs);
  if (terminal) return fromTerminal(prompt);
  return Promise.resolve(undefined);
}

/** What a command's signing steps use: the session of this process, or the one a parent process holds. */
export interface Passphrases {
  /** What a child run needs to ask this command's session (the address, the token, the helper): never the passphrase. */
  childEnv(): Promise<Record<string, string>>;
  /** The environment for one signing `git commit` with the key in `scope`: the helper as `SSH_ASKPASS`, forced, plus `childEnv`. */
  signingEnv(scope?: string): Promise<Record<string, string>>;
  /** How the attempt that just ended came out: the passphrase it used is kept, or thrown away. */
  settle(outcome: SigningOutcome): Promise<void>;
  /** Zero what is held and stop answering (the end of the command). */
  wipe(): Promise<void>;
}

/** What a session is made from (tests replace the person and the folder). */
export interface SessionOptions {
  /** Ask the person for a passphrase (default: {@link askThePerson}). */
  ask?: (prompt: string) => Promise<Uint8Array | undefined>;
  /** Where the helper's script goes (default: a new temporary folder). */
  folder?: () => Promise<string>;
}

/**
 * The passphrase of one command, in memory (spec 106-one-passphrase-speed FR-001 to FR-003).
 * `answer(prompt)` gives what is kept for that prompt (OpenSSH's prompt names the key's file, so
 * two keys are two values), else asks the person once; `settle` keeps what was just used only after
 * the key unlocked.
 */
export class PassphraseSession implements Passphrases {
  /** How many times the person (or the askpass program) was asked: one per key in a good run. */
  asks = 0;
  private readonly kept = new Map<string, Uint8Array>();
  private readonly candidate = new Map<string, Uint8Array>();
  private readonly again = new Set<string>();
  private readonly served = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private server: Server | undefined;
  private token = "";
  private dir: string | undefined;
  private helper: string | undefined;
  private starting: Promise<void> | undefined;
  private readonly source: (prompt: string) => Promise<Uint8Array | undefined>;
  private readonly folder: () => Promise<string>;

  /** A session; the person is asked by `o.ask`, else at the terminal or the named askpass. */
  constructor(o: SessionOptions = {}) {
    this.source = o.ask ?? askThePerson;
    this.folder = o.folder ?? (() => fs.makeTempDir({ prefix: "stolos-askpass-" }));
  }

  /** How many passphrases are held now (kept and waiting to be confirmed). */
  get held(): number {
    return this.kept.size + this.candidate.size;
  }

  /** The passphrase for this prompt of the key in `scope`: kept, or asked of the person (once at a time). */
  answer(prompt: string, scope = ""): Promise<Uint8Array | undefined> {
    const run = this.queue.then(() => this.serveOne(prompt, scope));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async serveOne(prompt: string, scope: string): Promise<Uint8Array | undefined> {
    // OpenSSH's own prompt does not always name the key: the scope does, and tells two keys apart.
    const key = `${scope}\u0000${prompt.trim()}`;
    const have = this.kept.get(key);
    if (have && !this.again.has(key)) {
      this.served.add(key);
      return have;
    }
    this.asks++;
    ui.log(`   passphrase: asked (${this.asks})`);
    // A key written out in Git's settings (`ssh-ed25519 AAAA...`) is not a name to show.
    const file = scope && !/^(key::|ssh-|ecdsa-|sk-)/.test(scope) ? scope : "";
    const named = file && !/\bfor\b/i.test(prompt) ? `Enter passphrase for "${file}":` : prompt;
    const typed = await this.source(named);
    if (!typed) return undefined;
    this.candidate.get(key)?.fill(0);
    this.candidate.set(key, typed);
    this.served.add(key);
    return typed;
  }

  /**
   * An attempt to sign ended (spec 106-one-passphrase-speed FR-003): what it used is kept if the key
   * unlocked; if the key refused it, it is thrown away and the key is asked again (a value kept
   * before stays until a new one unlocks); for another failure what was typed is thrown away.
   */
  settle(outcome: SigningOutcome): Promise<void> {
    for (const key of this.served) {
      const typed = this.candidate.get(key);
      if (outcome === "unlocked") {
        if (typed) {
          this.kept.get(key)?.fill(0);
          this.kept.set(key, typed);
          this.candidate.delete(key);
        }
        this.again.delete(key);
      } else {
        typed?.fill(0);
        this.candidate.delete(key);
        if (outcome === "refused") this.again.add(key);
      }
    }
    this.served.clear();
    return Promise.resolve();
  }

  /** Start the broker and write the helper, once. */
  private start(): Promise<void> {
    this.starting ??= (async () => {
      this.token = randomHex(32);
      // Its own server, which never keeps the process alive: a command run from code (a test, a
      // console) that ends without wiping must still be able to exit.
      const server = createServer((req, res) => {
        void this.adapt(req).then(async (r) => {
          res.statusCode = r.status;
          res.end(new Uint8Array(await r.arrayBuffer()));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      server.unref();
      this.server = server;
      const dir = await this.folder();
      this.dir = dir;
      this.helper = await writeHelper(dir);
    })();
    return this.starting;
  }

  /** A request from the helper, as the web `Request` the broker answers. */
  private async adapt(req: IncomingMessage): Promise<Response> {
    const chunks: Uint8Array[] = [];
    for await (const c of req) chunks.push(c as Uint8Array);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = new Blob(chunks as BlobPart[]);
    return await this.handle(
      new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(req.method === "POST" ? { body } : {}),
      }),
    );
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const given = req.headers.get(TOKEN_HEADER) ?? "";
    if (req.method !== "POST" || !sameToken(given, this.token)) {
      return new Response("no", { status: 403 });
    }
    const body = await req.text();
    if (url.pathname === "/ask") {
      // Only passphrase prompts: a host key question or anything else is OpenSSH's to ask.
      if (!/passphrase/i.test(body)) return new Response("no", { status: 403 });
      const timeout = new Promise<undefined>((r) =>
        setTimeout(() => r(undefined), ASK_TIMEOUT_MS).unref?.(),
      );
      const scope = decodeURIComponent(req.headers.get(SCOPE_HEADER) ?? "");
      const typed = await Promise.race([this.answer(body, scope), timeout]);
      return typed ? new Response(typed.slice()) : new Response("no", { status: 403 });
    }
    if (url.pathname === "/settle") {
      const outcome = SIGNING_OUTCOMES.find((o) => o === body);
      if (!outcome) return new Response("no", { status: 400 });
      await this.settle(outcome);
      return new Response(null, { status: 204 });
    }
    return new Response("no", { status: 404 });
  }

  async childEnv(): Promise<Record<string, string>> {
    await this.start();
    return {
      [ENV_URL]: `http://127.0.0.1:${(this.server?.address() as AddressInfo | null)?.port ?? 0}`,
      [ENV_TOKEN]: this.token,
      [ENV_HELPER]: this.helper ?? "",
    };
  }

  async signingEnv(scope = ""): Promise<Record<string, string>> {
    return { ...(await this.childEnv()), ...askpassVariables(this.helper ?? "", scope) };
  }

  async wipe(): Promise<void> {
    for (const m of [this.kept, this.candidate]) {
      for (const v of m.values()) v.fill(0);
      m.clear();
    }
    this.again.clear();
    this.served.clear();
    const server = this.server;
    const dir = this.dir;
    this.server = undefined;
    this.dir = undefined;
    this.helper = undefined;
    this.starting = undefined;
    this.token = "";
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      // Never waits on the server's own close: where it does not come, the command still ends.
      const giveUp = setTimeout(resolve, WIPE_LIMIT_MS);
      server.close(() => {
        clearTimeout(giveUp);
        resolve();
      });
      server.closeAllConnections();
    });
    if (dir) await fs.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

/** The variables that make OpenSSH ask the helper: forced, with a display set for older versions. */
function askpassVariables(helper: string, scope: string): Record<string, string> {
  return {
    ...(scope ? { [ENV_SCOPE]: scope } : {}),
    SSH_ASKPASS: helper,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: proc.env.get("DISPLAY") || ":0",
  };
}

/** The helper program OpenSSH runs: a script (a `.cmd` on Windows) holding no secret, that runs `askpass-helper.ts`. */
async function writeHelper(dir: string): Promise<string> {
  const argv = [
    ...runtimeCommand(),
    path.fromFileUrl(new URL("./askpass-helper.ts", import.meta.url)),
  ];
  await fs.mkdir(dir, { recursive: true });
  if (proc.build.os === "windows") {
    const file = path.join(dir, "stolos-askpass.cmd");
    await fs.writeTextFile(file, `@${argv.map((x) => `"${x}"`).join(" ")} %*\r\n`);
    return file;
  }
  const file = path.join(dir, "stolos-askpass.sh");
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  await fs.writeTextFile(file, `#!/bin/sh\nexec ${argv.map(q).join(" ")} "$@"\n`);
  await fs.chmod(file, 0o700);
  return file;
}

/** A child run's view of its parent's session: it holds nothing, asks the parent's broker and tells it the outcome. */
export class InheritedSession implements Passphrases {
  private readonly url: string;
  private readonly token: string;
  private readonly helper: string;

  /** The parent's address, token and helper (from the environment this process was started with). */
  constructor(url: string, token: string, helper: string) {
    this.url = url;
    this.token = token;
    this.helper = helper;
  }

  childEnv(): Promise<Record<string, string>> {
    return Promise.resolve({
      [ENV_URL]: this.url,
      [ENV_TOKEN]: this.token,
      [ENV_HELPER]: this.helper,
    });
  }

  async signingEnv(scope = ""): Promise<Record<string, string>> {
    return { ...(await this.childEnv()), ...askpassVariables(this.helper, scope) };
  }

  async settle(outcome: SigningOutcome): Promise<void> {
    try {
      await fetch(`${this.url}/settle`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: this.token },
        body: outcome,
      });
    } catch {
      /* the parent is gone: nothing to tell */
    }
  }

  wipe(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * What a command holds where there is no broker (Windows, until the broker has had a real Windows
 * test, spec 106-one-passphrase-speed FR-002): nothing. Each signing is OpenSSH's own, as in spec
 * 105-calm-output (the person's `SSH_ASKPASS`, or the terminal), so a command that signs twice asks
 * twice. No server, no helper script, no child process of ours is involved in signing.
 */
export class PerSigningSession implements Passphrases {
  childEnv(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  signingEnv(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  settle(): Promise<void> {
    return Promise.resolve();
  }

  wipe(): Promise<void> {
    return Promise.resolve();
  }
}

/** Whether this system keeps the passphrase in a broker (every system but Windows). */
export function brokerHere(os: string = proc.build.os): boolean {
  return os !== "windows";
}

/** This process's passphrases: its parent's where it was started to sign for one, else its own. */
function make(os: string = proc.build.os): Passphrases {
  if (!brokerHere(os)) return new PerSigningSession();
  const url = proc.env.get(ENV_URL);
  const token = proc.env.get(ENV_TOKEN);
  const helper = proc.env.get(ENV_HELPER);
  return url && token && helper
    ? new InheritedSession(url, token, helper)
    : new PassphraseSession();
}

/** The passphrases a command on the system named `os` would make (a test's way to see Windows' from anywhere). */
export function passphrasesFor(os: string): Passphrases {
  return make(os);
}

let current: Passphrases | undefined;

/** The passphrases of this command (made on first use; see {@link wipePassphrases}). */
export function passphrases(): Passphrases {
  current ??= make();
  return current;
}

/** Replace this process's passphrases (a test's own session); returns the one it replaced. */
export function usePassphrases(p: Passphrases | undefined): Passphrases | undefined {
  const old = current;
  current = p;
  return old;
}

/** The end of a command: zero what is held, stop answering (spec 106-one-passphrase-speed FR-002). */
export async function wipePassphrases(): Promise<void> {
  const p = current;
  current = undefined;
  await p?.wipe();
}
