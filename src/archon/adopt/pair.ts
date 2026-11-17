/**
 * Spec 098: pairing with a short code. The way a person brings a machine into the fleet without
 * copying a key or a hash by hand, modeled on device login: the controller PC shows one short,
 * fixed command and a code that expires; the person runs the command on the machine and types
 * the code; the PC shows who asked and the person approves there.
 *
 * This module is the protocol, with no network or terminal of its own: {@link PairSession} answers
 * the machine's HTTP requests, with its state in a {@link PairStore} (spec 103-three-ports), so that
 * every door (the boot server's HTTP, the console's TLS, or the pair-only server `stolos pair` runs)
 * mounts the same handler over one record, and `stolos pair` (in pair-command.ts) asks the person.
 *
 * Every route lives under `/device/pair` (the ontology's device path, spec 103-three-ports FR-003),
 * here written relative to that base:
 *
 * | Request | What it is |
 * | --- | --- |
 * | `GET <base>` | the POSIX script: `bin/integrate.sh`, from this engine, with the pairing filled in |
 * | `GET <base>/w` | a Windows loader: saves `<base>/w.ps1` and runs it in a child PowerShell (so a stop never closes the person's window) |
 * | `GET <base>/w.ps1` | `bin/integrate.windows.ps1`, from this engine |
 * | `GET <base>/bin/stolos-probe.sh`, `<base>/bin/stolos-probe.ps1` | the probes, from this engine |
 * | `POST <base>/hello` | `nonce=`, `hostname=` and `os=` (posix or windows) lines, signed with the code: the answer is the machine's name and the fleet's probe key, signed back |
 * | `POST <base>/checkin` | the check-in text (the same as a `stolos1:` code, unencoded), signed with the code: the answer waits for the person's decision |
 *
 * While no pairing is waiting, every one of them answers `404`. Every other answer is `200` with
 * its first line `ok` or `no <reason>`, so the smallest HTTP client (a POSIX shell's curl or wget,
 * PowerShell 5.1) reads it the same way. A signature is HMAC-SHA256 under the code (normalized:
 * uppercase, no separators), in lowercase hex, sent in the `X-Stolos-Mac` header; the PC's answer to
 * `hello` is signed over `nonce`, `key`, `name` and `sha256` (the probe's, for the machine's OS),
 * one per line, so the machine knows the key came from the PC that showed the code and installs
 * only the probe that PC means.
 *
 * The code is 8 characters from an alphabet without look-alikes (about 39 bits), good for one
 * machine, for 10 minutes, and for 5 wrong signatures in all (counted in the store, so by every
 * door and every process together). Plain HTTP on the boot server's port is deliberate (the network
 * trust position in the networks guide): on a trusted LAN, or over a zero trust mesh network
 * (Tailscale, NetBird, ZeroTier, Nebula, WireGuard, or similar: see mesh.ts) for anything else,
 * never exposed to the internet; the console's TLS door adds a certificate where the fleet has one.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant PC as Controller PC (stolos pair)
 *   participant S as A door (boot HTTP or console TLS)
 *   participant M as The machine
 *   PC->>S: the pairing's record (a short-lived file)
 *   M->>S: GET /device/pair (the script, from this engine)
 *   M->>S: POST /device/pair/hello (nonce, hostname; HMAC under the code)
 *   S->>M: ok, name, probe key (HMAC under the code)
 *   M->>M: SSH on, the probe installed, only the key may run it
 *   M->>S: POST /device/pair/checkin (host keys, facts; HMAC under the code)
 *   S->>PC: the check-in, in the record
 *   PC->>PC: the person approves (name, OS, address, host key)
 *   PC->>S: the decision, in the record
 *   S->>M: ok: adopted
 * ```
 *
 * @module
 */
// Spec: 098-pair FR-002, FR-003, FR-004, FR-005, FR-006, FR-008
// Spec: 103-three-ports FR-003, FR-004, FR-005, FR-006, FR-007

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { PROBE_SCRIPT, PROBE_SCRIPT_WINDOWS } from "./probe.ts";
import { engineFile } from "../core/assets.ts";
import { DEVICE_PAIR_PATH } from "../ontology.auto.ts";
import {
  CODE_TTL_MS,
  type Hello,
  MemoryPairStore,
  type PairEnd,
  type PairRecord,
  type PairStore,
} from "./pair-store.ts";

export { CODE_TTL_MS, type Hello, type PairEnd };

/** The code's alphabet: uppercase letters and digits without look-alikes (no 0, O, 1, I, L). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** How many wrong signatures end a pairing. */
export const MAX_TRIES = 5;

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

/** What a door gives a pairing session. */
export interface PairOptions {
  /** Where the pairing's state is kept (the file `stolos pair` writes, or a memory store). */
  store: PairStore;
  /**
   * The machine's name and its probe key's public half, for a hostname (the record's `--name`, else the hostname's first label), or
   * why it cannot have one.
   */
  nameFor: (
    hostname: string,
    record: PairRecord,
  ) => Promise<{ name: string; key: string } | { refuse: string }>;
  /**
   * In this process, the person's decision on a signed check-in (the text a stolos1: code holds): `ok` and what to tell the machine,
   * or a refusal. Absent in a door that serves a pairing another process (`stolos pair`) decides: the check-in waits in the store.
   */
  approve?: (checkIn: string, hello: Hello) => Promise<{ ok: boolean; message: string }>;
  /** Now, in milliseconds (tests move it). */
  now?: () => number;
  /** How often a waiting check-in looks at the store for the decision (500 ms by default). */
  pollMs?: number;
}

const textResponse = (body: string, type = "text/plain; charset=utf-8"): Response =>
  new Response(body, {
    status: 200,
    headers: { "content-type": type, "cache-control": "no-store" },
  });

const no = (why: string): Response => textResponse(`no ${why}\n`);

const notFound = (): Response => new Response("not found\n", { status: 404 });

/** Whether a URL path is pairing's (`/device/pair` or under it). */
export function isPairPath(pathname: string): boolean {
  return pathname === DEVICE_PAIR_PATH || pathname.startsWith(`${DEVICE_PAIR_PATH}/`);
}

/** The POSIX script the machine runs: integrate.sh with the pairing's arguments in front (`url` is the pairing's base, `<origin>/device/pair`). */
export function posixScript(o: { url: string; fleet: string; engine: string }): string {
  const body = engineFile("bin/integrate.sh").replace(/^#![^\n]*\n/, "");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Served by stolos pair (spec 098) on the fleet's controller PC, from engine ${o.engine}.
set -- --adopt --pair ${q(o.url)} --fleet ${q(o.fleet)} --engine ${q(o.engine)} "$@"
${body}`;
}

/**
 * The Windows loader `irm <base>/w | iex` runs: it saves the integrate script and runs it in a child PowerShell, so the script's
 * `exit` ends that child, never the person's window.
 */
export function windowsLoader(o: { url: string; fleet: string; engine: string }): string {
  const a = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `# Served by stolos pair (spec 098) on the fleet's controller PC, from engine ${o.engine}.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$stolosPair = Join-Path $env:TEMP ('stolos-pair-' + $PID + '.ps1')
Invoke-WebRequest -UseBasicParsing ${a(`${o.url}/w.ps1`)} -OutFile $stolosPair
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stolosPair --adopt --pair ${a(o.url)} --fleet ${a(o.fleet)} --engine ${a(o.engine)}
Remove-Item -Force -ErrorAction SilentlyContinue $stolosPair
`;
}

/**
 * The pairing's answers, for any door. It holds no state of its own: every request reads the store, so each door and each process
 * that mounts one over the same store serves the same pairing, counts wrong signatures together, allows one machine per code, and
 * holds a check-in until whoever has the terminal (`stolos pair`) decides.
 */
export class PairSession {
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly o: PairOptions;
  private deciding = false;

  /** A session over a store. */
  constructor(o: PairOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? 500;
  }

  /** The pairing's state, with an expiry noticed: undefined where none is waiting. */
  private async live(): Promise<PairRecord | undefined> {
    const r = await this.o.store.read();
    if (!r) return undefined;
    if (!r.ended && this.now() > r.expiresAt) {
      const u = await this.o.store.update((x) => {
        if (!x.ended) x.ended = "expired";
      });
      return u?.record;
    }
    return r;
  }

  /** Why the pairing ended, or undefined while it waits. */
  async ended(): Promise<PairEnd | undefined> {
    return (await this.live())?.ended;
  }

  /** Resolves when the pairing ends (or its record is gone), with why. */
  async done(): Promise<PairEnd> {
    for (;;) {
      const r = await this.live();
      if (!r) return "refused";
      if (r.ended) return r.ended;
      await proc.sleep(Math.min(this.pollMs, Math.max(1, r.expiresAt - this.now() + 1)));
    }
  }

  private async signed(
    req: Request,
    r: PairRecord,
  ): Promise<{ ok: true; body: Uint8Array } | { ok: false; res: Response }> {
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > 256 * 1024) return { ok: false, res: no("the request is too large") };
    const given = (req.headers.get("x-stolos-mac") ?? "").trim().toLowerCase();
    if (sameMac(given, await mac(r.code, body))) return { ok: true, body };
    const u = await this.o.store.update((x) => {
      // A try after the pairing ended (a request that was already in flight) counts for nothing.
      if (x.ended) return 0;
      x.tries++;
      if (x.tries >= MAX_TRIES) x.ended = "tries";
      return MAX_TRIES - x.tries;
    });
    if (!u) return { ok: false, res: notFound() };
    const left = u.result;
    if (left <= 0) {
      return {
        ok: false,
        res: no("that code is wrong, and the pairing has ended: start it again on the PC"),
      };
    }
    return {
      ok: false,
      res: no(`that code is wrong (${left} ${left === 1 ? "try" : "tries"} left)`),
    };
  }

  /** Answer one request from the machine (any path: those outside `/device/pair` are 404). */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!isPairPath(url.pathname)) return notFound();
    const p = url.pathname.slice(DEVICE_PAIR_PATH.length) || "/";
    const r = await this.live();
    if (!r) return notFound();
    const base = `${url.origin}${DEVICE_PAIR_PATH}`;
    const scriptArgs = { url: base, fleet: r.fleet, engine: r.engine };
    if (req.method === "GET") {
      if (r.ended) return notFound();
      if (p === "/" || p === "/sh") {
        return textResponse(posixScript(scriptArgs), "text/x-shellscript");
      }
      if (p === "/w") return textResponse(windowsLoader(scriptArgs));
      if (p === "/w.ps1") return textResponse(engineFile("bin/integrate.windows.ps1"));
      if (p === "/bin/stolos-probe.sh") return textResponse(PROBE_SCRIPT, "text/x-shellscript");
      if (p === "/bin/stolos-probe.ps1") return textResponse(PROBE_SCRIPT_WINDOWS);
      return notFound();
    }
    if (req.method !== "POST") return notFound();
    if (r.ended) {
      return no(
        r.ended === "expired"
          ? "the code has expired: start the pairing again on the PC"
          : "this pairing has ended: start it again on the PC",
      );
    }
    if (p === "/hello") return await this.onHello(req, r);
    if (p === "/checkin") return await this.onCheckIn(req, r);
    return notFound();
  }

  private async onHello(req: Request, r: PairRecord): Promise<Response> {
    const s = await this.signed(req, r);
    if (!s.ok) return s.res;
    const fields = lines(new TextDecoder().decode(s.body));
    const nonce = fields["nonce"] ?? "";
    const hostname = (fields["hostname"] ?? "").trim();
    if (!/^[0-9a-f]{16,128}$/.test(nonce)) return no("the request has no nonce");
    if (!/^[A-Za-z0-9._-]{1,253}$/.test(hostname)) return no("the request has no usable hostname");
    // One machine per code, whatever door or process it comes through: claim the hostname in the store first.
    const claim = await this.o.store.update((x) => {
      const other = x.hello?.hostname ?? x.claimed;
      if (other !== undefined && other !== hostname) return other;
      if (!x.hello) x.claimed = hostname;
      return undefined;
    });
    if (!claim) return notFound();
    if (claim.result !== undefined) {
      return no(`this code is already in use by ${claim.result}: start another pairing on the PC`);
    }
    const n = await this.o.nameFor(hostname, claim.record);
    if ("refuse" in n) {
      await this.o.store.update((x) => {
        if (!x.hello && x.claimed === hostname) delete x.claimed;
      });
      return no(n.refuse);
    }
    const key = n.key.trim().split(/\s+/).slice(0, 2).join(" ");
    await this.o.store.update((x) => {
      x.hello = { hostname, name: n.name, key };
      delete x.claimed;
    });
    const probe = fields["os"] === "windows" ? PROBE_SCRIPT_WINDOWS : PROBE_SCRIPT;
    const sum = await sha256Hex(probe);
    const sig = await mac(r.code, `${nonce}\n${key}\n${n.name}\n${sum}`);
    return textResponse(`ok\nname=${n.name}\nkey=${key}\nsha256=${sum}\nmac=${sig}\n`);
  }

  private async onCheckIn(req: Request, r: PairRecord): Promise<Response> {
    const s = await this.signed(req, r);
    if (!s.ok) return s.res;
    const text = new TextDecoder().decode(s.body);
    // Store the check-in for the person (the same check-in again is the same machine asking once more).
    const put = await this.o.store.update((x) => {
      if (!x.hello) return "hello" as const;
      if (x.checkIn && x.checkIn.text !== text) return "busy" as const;
      x.checkIn ??= { text, at: this.now() };
      return { hello: x.hello };
    });
    if (!put) return notFound();
    if (put.result === "hello") return no("say hello first (an older script?)");
    if (put.result === "busy") {
      return no("this check-in is already waiting for approval on the PC");
    }
    const hello = put.result.hello;
    // In this process the decision may come from a function (tests, a single-process session).
    if (this.o.approve && !this.deciding) {
      this.deciding = true;
      const approve = this.o.approve;
      void approve(text, hello)
        .catch((e: unknown) => ({ ok: false, message: `the PC could not decide: ${String(e)}` }))
        .then((d) =>
          this.o.store.update((x) => {
            if (x.ended) return;
            x.decision = d;
            x.ended = d.ok ? "paired" : "refused";
          }),
        );
    }
    // Hold the request until the person decides, the code expires or the pairing ends.
    for (;;) {
      const cur = await this.live();
      if (!cur) return no("this pairing has ended: start it again on the PC");
      if (cur.decision) {
        await this.o.store.update((x) => {
          x.delivered = true;
        });
        return textResponse(`${cur.decision.ok ? "ok" : "no"} ${cur.decision.message}\n`);
      }
      if (cur.ended) {
        return no(
          cur.ended === "expired"
            ? "the code has expired: start the pairing again on the PC"
            : "this pairing has ended: start it again on the PC",
        );
      }
      await proc.sleep(this.pollMs);
    }
  }
}

/** A session over a memory store holding a fresh pairing, for a single process (tests). */
export function memorySession(
  record: PairRecord,
  o: Omit<PairOptions, "store">,
): { session: PairSession; store: MemoryPairStore } {
  const store = new MemoryPairStore(record);
  return { session: new PairSession({ ...o, store }), store };
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
