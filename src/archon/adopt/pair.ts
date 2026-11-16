/**
 * Spec 098: pairing with a short code. The way a person brings a machine into the fleet without
 * copying a key or a hash by hand, modeled on device login: the controller PC shows one short,
 * fixed command and a code that expires; the person runs the command on the machine and types
 * the code; the PC shows who asked and the person approves there.
 *
 * This module is the protocol, with no network or terminal of its own: {@link PairSession} answers
 * the machine's HTTP requests, and the command (`stolos pair`, in commands.ts) serves it and asks
 * the person.
 *
 * | Request | What it is |
 * | --- | --- |
 * | `GET /` | the POSIX script: `bin/integrate.sh`, from this engine, with the pairing filled in |
 * | `GET /w` | a Windows loader: saves `/w.ps1` and runs it in a child PowerShell (so a stop never closes the person's window) |
 * | `GET /w.ps1` | `bin/integrate.windows.ps1`, from this engine |
 * | `GET /bin/stolos-probe.sh`, `/bin/stolos-probe.ps1` | the probes, from this engine |
 * | `POST /hello` | `nonce=`, `hostname=` and `os=` (posix or windows) lines, signed with the code: the answer is the machine's name and the fleet's probe key, signed back |
 * | `POST /checkin` | the check-in text (the same as a `stolos1:` code, unencoded), signed with the code: the answer waits for the person's approval |
 *
 * Every answer is `200` with its first line `ok` or `no <reason>`, so the smallest HTTP client (a
 * POSIX shell's curl or wget, PowerShell 5.1) reads it the same way. A signature is HMAC-SHA256
 * under the code (normalized: uppercase, no separators), in lowercase hex, sent in the
 * `X-Stolos-Mac` header; the PC's answer to `/hello` is signed over `nonce`, `key`, `name` and
 * `sha256` (the probe's, for the machine's OS), one per line, so the machine knows the key came
 * from the PC that showed the code and installs only the probe that PC means.
 *
 * The code is 8 characters from an alphabet without look-alikes (about 39 bits), good for one
 * machine, for 10 minutes, and for 5 wrong signatures in all. Plain HTTP is deliberate (the
 * network trust position in the networks guide): on a trusted LAN, or over a zero trust mesh
 * network (Tailscale, NetBird, ZeroTier, Nebula, WireGuard, or similar: see mesh.ts) for anything else, never exposed to the internet.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant PC as Controller PC (stolos pair)
 *   participant M as The machine
 *   PC->>PC: shows the line and the code
 *   M->>PC: GET / (the script, from this engine)
 *   M->>PC: POST /hello (nonce, hostname; HMAC under the code)
 *   PC->>M: ok, name, probe key (HMAC under the code)
 *   M->>M: SSH on, the probe installed, only the key may run it
 *   M->>PC: POST /checkin (host keys, facts; HMAC under the code)
 *   PC->>PC: the person approves (name, OS, address, host key)
 *   PC->>M: ok: adopted
 * ```
 *
 * @module
 */
// Spec: 098-pair FR-002, FR-003, FR-004, FR-005, FR-006, FR-008

import { PROBE_SCRIPT, PROBE_SCRIPT_WINDOWS } from "./probe.ts";
import { engineFile } from "../core/assets.ts";

/** The code's alphabet: uppercase letters and digits without look-alikes (no 0, O, 1, I, L). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** How long a code is good for. */
export const CODE_TTL_MS = 10 * 60_000;

/** How many wrong signatures end a pairing. */
export const MAX_TRIES = 5;

/** The port `stolos pair` listens on unless told another. */
export const PAIR_PORT = 7457;

/** A new code: 8 characters, shown as two groups of four (WDJB-MJHT). */
export function newCode(random: (n: number) => Uint8Array = randomBytes): string {
  const out: string[] = [];
  // Rejection sampling: no character is likelier than another.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < 8) {
    for (const b of random(16)) {
      if (b < limit && out.length < 8) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length] ?? "");
    }
  }
  return `${out.slice(0, 4).join("")}-${out.slice(4).join("")}`;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A code as typed (any case, spaces or dashes) in the form both sides sign with. */
export function normalizeCode(typed: string): string {
  return typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** HMAC-SHA256 of `message` under the (normalized) code, in lowercase hex. */
export async function mac(code: string, message: string | Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(normalizeCode(code)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof message === "string" ? enc.encode(message) : message;
  const sig = await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Equal strings, compared in time that does not depend on where they differ. */
export function sameMac(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The machine that said hello: its hostname, and the name and probe key the PC gave it. */
export interface Hello {
  /** Its hostname, as it said. */
  hostname: string;
  /** Its name in the fleet. */
  name: string;
  /** The probe key's public half the PC sent it. */
  key: string;
}

/** What the command gives a pairing session. */
export interface PairOptions {
  /** The fleet's id. */
  fleet: string;
  /** This engine's tag (v1.2.3), for the scripts' messages. */
  engine: string;
  /** Where the machine reaches this PC: http://address:port. */
  url: string;
  /** The code (as shown). */
  code: string;
  /** Now, in milliseconds (tests move it). */
  now?: () => number;
  /**
   * The machine's name and its probe key's public half, for a hostname (`--name` or the
   * hostname's first label), or why it cannot have one.
   */
  nameFor: (hostname: string) => Promise<{ name: string; key: string } | { refuse: string }>;
  /**
   * The person's decision on a signed check-in (the text a stolos1: code holds): `ok` and what to
   * tell the machine, or a refusal.
   */
  approve: (checkIn: string, hello: Hello) => Promise<{ ok: boolean; message: string }>;
}

/** Why a pairing session ended. */
export type PairEnd = "paired" | "refused" | "expired" | "tries";

const textResponse = (body: string, type = "text/plain; charset=utf-8"): Response =>
  new Response(body, {
    status: 200,
    headers: { "content-type": type, "cache-control": "no-store" },
  });

const no = (why: string): Response => textResponse(`no ${why}\n`);

/** The POSIX script the machine runs: integrate.sh with the pairing's arguments in front. */
export function posixScript(o: { url: string; fleet: string; engine: string }): string {
  const body = engineFile("bin/integrate.sh").replace(/^#![^\n]*\n/, "");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Served by stolos pair (spec 098) on the fleet's controller PC, from engine ${o.engine}.
set -- --adopt --pair ${q(o.url)} --fleet ${q(o.fleet)} --engine ${q(o.engine)} "$@"
${body}`;
}

/**
 * The Windows loader `irm <url>/w | iex` runs: it saves the integrate script and runs it in a
 * child PowerShell, so the script's `exit` ends that child, never the person's window.
 */
export function windowsLoader(o: { url: string; fleet: string; engine: string }): string {
  const a = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `# Served by stolos pair (spec 098) on the fleet's controller PC, from engine ${o.engine}.
$stolosPair = Join-Path $env:TEMP ('stolos-pair-' + $PID + '.ps1')
Invoke-WebRequest -UseBasicParsing ${a(`${o.url}/w.ps1`)} -OutFile $stolosPair
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stolosPair --adopt --pair ${a(o.url)} --fleet ${a(o.fleet)} --engine ${a(o.engine)}
Remove-Item -Force -ErrorAction SilentlyContinue $stolosPair
`;
}

/**
 * One pairing: one code, one machine. It answers the machine's requests, counts wrong signatures,
 * expires, and ends once a check-in is approved or refused.
 */
export class PairSession {
  private readonly started: number;
  private readonly now: () => number;
  private wrong = 0;
  private hello: Hello | undefined;
  private busy = false;
  /** Set once the session is over. */
  ended: PairEnd | undefined;
  private readonly waiters: Array<(e: PairEnd) => void> = [];

  private readonly o: PairOptions;

  /** A session for one code. */
  constructor(o: PairOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.started = this.now();
  }

  /** Wrong signatures left. */
  get triesLeft(): number {
    return MAX_TRIES - this.wrong;
  }

  /** When the code expires (milliseconds). */
  get expiresAt(): number {
    return this.started + CODE_TTL_MS;
  }

  /** Resolves when the session ends, with why. */
  done(): Promise<PairEnd> {
    return this.ended
      ? Promise.resolve(this.ended)
      : new Promise((resolve) => this.waiters.push(resolve));
  }

  /** End the session (the code expired, or the command is stopping). */
  end(why: PairEnd): void {
    if (this.ended) return;
    this.ended = why;
    for (const w of this.waiters.splice(0)) w(why);
  }

  private expired(): boolean {
    if (!this.ended && this.now() > this.expiresAt) this.end("expired");
    return this.ended !== undefined;
  }

  private async signed(
    req: Request,
  ): Promise<{ ok: true; body: Uint8Array } | { ok: false; res: Response }> {
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > 256 * 1024) return { ok: false, res: no("the request is too large") };
    const given = (req.headers.get("x-stolos-mac") ?? "").trim().toLowerCase();
    if (sameMac(given, await mac(this.o.code, body))) return { ok: true, body };
    this.wrong++;
    if (this.wrong >= MAX_TRIES) {
      this.end("tries");
      return {
        ok: false,
        res: no("that code is wrong, and the pairing has ended: start it again on the PC"),
      };
    }
    return {
      ok: false,
      res: no(
        `that code is wrong (${this.triesLeft} ${this.triesLeft === 1 ? "try" : "tries"} left)`,
      ),
    };
  }

  /** Answer one request from the machine. */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const scriptArgs = { url: this.o.url, fleet: this.o.fleet, engine: this.o.engine };
    if (req.method === "GET") {
      if (p === "/" || p === "/sh")
        return textResponse(posixScript(scriptArgs), "text/x-shellscript");
      if (p === "/w") return textResponse(windowsLoader(scriptArgs));
      if (p === "/w.ps1") return textResponse(engineFile("bin/integrate.windows.ps1"));
      if (p === "/bin/stolos-probe.sh") return textResponse(PROBE_SCRIPT, "text/x-shellscript");
      if (p === "/bin/stolos-probe.ps1") return textResponse(PROBE_SCRIPT_WINDOWS);
      return new Response("not found\n", { status: 404 });
    }
    if (req.method !== "POST") return new Response("not allowed\n", { status: 404 });
    if (this.expired()) {
      return no(
        this.ended === "expired"
          ? "the code has expired: start the pairing again on the PC"
          : "this pairing has ended: start it again on the PC",
      );
    }
    if (p === "/hello") return await this.onHello(req);
    if (p === "/checkin") return await this.onCheckIn(req);
    return new Response("not found\n", { status: 404 });
  }

  private async onHello(req: Request): Promise<Response> {
    const s = await this.signed(req);
    if (!s.ok) return s.res;
    const fields = lines(new TextDecoder().decode(s.body));
    const nonce = fields["nonce"] ?? "";
    const hostname = (fields["hostname"] ?? "").trim();
    if (!/^[0-9a-f]{16,128}$/.test(nonce)) return no("the request has no nonce");
    if (!/^[A-Za-z0-9._-]{1,253}$/.test(hostname)) return no("the request has no usable hostname");
    if (this.hello && this.hello.hostname !== hostname) {
      return no(
        `this code is already in use by ${this.hello.hostname}: start another pairing on the PC`,
      );
    }
    const n = await this.o.nameFor(hostname);
    if ("refuse" in n) return no(n.refuse);
    const key = n.key.trim().split(/\s+/).slice(0, 2).join(" ");
    this.hello = { hostname, name: n.name, key };
    const probe = fields["os"] === "windows" ? PROBE_SCRIPT_WINDOWS : PROBE_SCRIPT;
    const sum = await sha256Hex(probe);
    const sig = await mac(this.o.code, `${nonce}\n${key}\n${n.name}\n${sum}`);
    return textResponse(`ok\nname=${n.name}\nkey=${key}\nsha256=${sum}\nmac=${sig}\n`);
  }

  private async onCheckIn(req: Request): Promise<Response> {
    const s = await this.signed(req);
    if (!s.ok) return s.res;
    if (!this.hello) return no("say hello first (an older script?)");
    if (this.busy) return no("this check-in is already waiting for approval on the PC");
    this.busy = true;
    try {
      const r = await this.o.approve(new TextDecoder().decode(s.body), this.hello);
      this.end(r.ok ? "paired" : "refused");
      return textResponse(`${r.ok ? "ok" : "no"} ${r.message}\n`);
    } finally {
      this.busy = false;
    }
  }
}

/** The SHA-256 of a text (UTF-8), lowercase hex: what the machine checks the probe it downloads against. */
export async function sha256Hex(text: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** `key=value` lines as a record. */
function lines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of text.split("\n")) {
    const i = l.indexOf("=");
    if (i > 0)
      out[l.slice(0, i).trim()] = l
        .slice(i + 1)
        .replace(/\r$/, "")
        .trim();
  }
  return out;
}
