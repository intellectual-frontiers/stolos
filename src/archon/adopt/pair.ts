/**
 * Specs 098 and 107-pairing-and-query: pairing with a short code. The way a person brings machines into the fleet without
 * copying a key or a hash by hand, modeled on device login: the controller PC shows one short,
 * fixed command and a code; the person runs the command on each machine and types the code; the PC shows who
 * asked, one machine after another, and the person approves each there. One session pairs many machines, at the same
 * time or one after another, and stays open until the person who started it stops it.
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
 * While no session is open, every one of them answers `404`. Every other answer is `200` with
 * its first line `ok` or `no <reason>`, so the smallest HTTP client (a POSIX shell's curl or wget,
 * PowerShell 5.1) reads it the same way. A signature is HMAC-SHA256 under the code (normalized:
 * uppercase, no separators), in lowercase hex, sent in the `X-Stolos-Mac` header; the PC's answer to
 * `hello` is signed over `nonce`, `key`, `name` and `sha256` (the probe's, for the machine's OS),
 * one per line, so the machine knows the key came from the PC that showed the code and installs
 * only the probe that PC means.
 *
 * The code is 8 characters from an alphabet without look-alikes (about 39 bits), the same for every machine of the session, and
 * it never expires: the session ends when the person closes it. Wrong signatures are counted per client address (in the store,
 * so by every door and every process together): after 5 that address is refused for the rest of the session, and other
 * addresses are not affected (spec 107-pairing-and-query FR-004). Plain HTTP on the boot server's port is deliberate (the network
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
// Spec: 107-pairing-and-query FR-001, FR-002, FR-003, FR-004, FR-006

import { proc } from "@intellectual-frontiers/system";
import { PROBE_SCRIPT, PROBE_SCRIPT_WINDOWS } from "./probe.ts";
import { engineFile } from "../core/assets.ts";
import { DEVICE_PAIR_PATH } from "../ontology.auto.ts";
import {
  type Hello,
  MAX_ADDRESSES,
  MAX_MACHINES,
  MAX_TRIES,
  MemoryPairStore,
  type PairEnd,
  type PairMachine,
  type PairRecord,
  type PairStore,
} from "./pair-store.ts";
import { nameFor as hostnameToName } from "./checkin.ts";

export { type Hello, MAX_ADDRESSES, MAX_MACHINES, MAX_TRIES, type PairEnd };

/** The code's alphabet: uppercase letters and digits without look-alikes (no 0, O, 1, I, L). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

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
  /** Where the session's state is kept (the file `stolos pair` writes, or a memory store). */
  store: PairStore;
  /**
   * The machine's name and its probe key's public half, for a hostname (the record's `--name` for the first machine, else the
   * hostname's first label), or why it cannot have one.
   */
  nameFor: (
    hostname: string,
    record: PairRecord,
  ) => Promise<{ name: string; key: string } | { refuse: string }>;
  /**
   * In this process, the person's decision on a machine's signed check-in (the text a stolos1: code holds): `ok` and what to tell
   * the machine, or a refusal. Absent in a door that serves a session another process (`stolos pair`) decides: the check-in waits
   * in the store.
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

/** A client address as the session counts it: IPv4-mapped IPv6 written as IPv4, lowercase; `unknown` where the door gave none. */
export function clientKey(from?: string): string {
  const a = (from ?? "")
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, "");
  return a || "unknown";
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

/** What queueing a check-in gave: the machine it is from (and what it said), or why none. */
type Queued = "hello" | "busy" | { id: string; hello: Hello };

/**
 * The session's answers, for any door. It holds no state of its own: every request reads the store, so each door and each process
 * that mounts one over the same store serves the same session, counts wrong signatures per address together, keeps every machine
 * that said hello, and holds a machine's check-in until whoever has the terminal (`stolos pair`) decides on it.
 */
export class PairSession {
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly o: PairOptions;
  private readonly deciding = new Set<string>();

  /** A session over a store. */
  constructor(o: PairOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? 500;
  }

  /** Why the session ended, or undefined while it is open. */
  async ended(): Promise<PairEnd | undefined> {
    return (await this.o.store.read())?.ended;
  }

  /** Resolves when the session ends (or its record is gone). */
  async done(): Promise<PairEnd> {
    for (;;) {
      const r = await this.o.store.read();
      if (!r) return "closed";
      if (r.ended) return r.ended;
      await proc.sleep(this.pollMs);
    }
  }

  private async signed(
    req: Request,
    r: PairRecord,
    addr: string,
  ): Promise<{ ok: true; body: Uint8Array } | { ok: false; res: Response }> {
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > 256 * 1024) return { ok: false, res: no("the request is too large") };
    const given = (req.headers.get("x-stolos-mac") ?? "").trim().toLowerCase();
    if (sameMac(given, await mac(r.code, body))) return { ok: true, body };
    const u = await this.o.store.update((x) => {
      // A try after the session ended (a request that was already in flight) counts for nothing.
      if (x.ended) return MAX_TRIES;
      // A new address past the cap is refused without being counted: the record does not grow. An address already at the
      // limit is not counted further (requests already in flight when it was reached).
      if (!(addr in x.tries) && Object.keys(x.tries).length >= MAX_ADDRESSES) return 0;
      if ((x.tries[addr] ?? 0) >= MAX_TRIES) return 0;
      x.tries[addr] = (x.tries[addr] ?? 0) + 1;
      return MAX_TRIES - x.tries[addr];
    });
    if (!u) return { ok: false, res: notFound() };
    if (u.result <= 0) {
      return {
        ok: false,
        res: no("that code is wrong, and this address is refused for the rest of the session"),
      };
    }
    const left = u.result;
    return {
      ok: false,
      res: no(`that code is wrong (${left} ${left === 1 ? "try" : "tries"} left)`),
    };
  }

  /** Answer one request from the machine at `from` (any path: those outside `/device/pair` are 404). */
  async handle(req: Request, from?: string): Promise<Response> {
    const url = new URL(req.url);
    if (!isPairPath(url.pathname)) return notFound();
    const p = url.pathname.slice(DEVICE_PAIR_PATH.length) || "/";
    const r = await this.o.store.read();
    if (!r) return notFound();
    const addr = clientKey(from);
    const base = `${url.origin}${DEVICE_PAIR_PATH}`;
    const scriptArgs = { url: base, fleet: r.fleet, engine: r.engine };
    if (r.ended) {
      return req.method === "POST"
        ? no("this session has ended: ask for it again on the PC")
        : notFound();
    }
    // Five wrong signatures from an address: it is refused for the rest of the session, on every route.
    if ((r.tries[addr] ?? 0) >= MAX_TRIES) {
      return req.method === "GET"
        ? new Response("no this address is refused for the rest of the pairing session\n", {
            status: 403,
          })
        : no("this address is refused for the rest of the session: it sent 5 wrong codes");
    }
    if (req.method === "GET") {
      if (p === "/" || p === "/sh") {
        return textResponse(posixScript(scriptArgs), "text/x-shellscript");
      }
      if (p === "/w") return textResponse(windowsLoader(scriptArgs));
      if (p === "/w.ps1") return textResponse(engineFile("bin/integrate.windows.ps1"));
      if (p === "/bin/stolos-probe.sh" || p === "/bin/stolos-probe.ps1") {
        // A machine that said hello is fetching its probe: it is installing now.
        await this.o.store.update((x) => {
          for (const m of Object.values(x.machines)) {
            if (m.address === addr && m.stage === "hello") m.stage = "installing";
          }
        });
        return p.endsWith(".sh")
          ? textResponse(PROBE_SCRIPT, "text/x-shellscript")
          : textResponse(PROBE_SCRIPT_WINDOWS);
      }
      return notFound();
    }
    if (req.method !== "POST") return notFound();
    if (p === "/hello") return await this.onHello(req, r, addr);
    if (p === "/checkin") return await this.onCheckIn(req, r, addr);
    return notFound();
  }

  private async onHello(req: Request, r: PairRecord, addr: string): Promise<Response> {
    const s = await this.signed(req, r, addr);
    if (!s.ok) return s.res;
    const fields = lines(new TextDecoder().decode(s.body));
    const nonce = fields["nonce"] ?? "";
    const hostname = (fields["hostname"] ?? "").trim();
    if (!/^[0-9a-f]{16,128}$/.test(nonce)) return no("the request has no nonce");
    // `__proto__` and the like are no hostname of a machine (the record is keyed by hostname).
    if (!/^[A-Za-z0-9._-]{1,253}$/.test(hostname) || hostname.startsWith("__")) {
      return no("the request has no usable hostname");
    }
    const id = hostname.toLowerCase();
    // Claim the hostname in the store first, whatever door or process the machine came through. The same machine saying hello
    // again (a retry) keeps its place; another machine of the same hostname is refused while the first is pairing.
    const claim = await this.o.store.update((x): { busy?: string; full?: boolean } => {
      const m = Object.hasOwn(x.machines, id) ? x.machines[id] : undefined;
      if (m) {
        const going = m.stage === "hello" || m.stage === "installing" || m.stage === "waiting";
        if (going && m.address !== addr) return { busy: m.address };
        if (going) return {};
        delete x.machines[id];
      }
      if (Object.keys(x.machines).length >= MAX_MACHINES) return { full: true };
      x.machines[id] = {
        hostname,
        name: "",
        key: "",
        address: addr,
        stage: "hello",
        seq: x.next++,
        helloAt: this.now(),
      };
      return {};
    });
    if (!claim) return notFound();
    if (claim.result.busy !== undefined) {
      return no(
        `another machine called ${hostname} is pairing from ${claim.result.busy}: change one hostname, or pair them one after the other`,
      );
    }
    if (claim.result.full) {
      return no(
        `this session already has ${MAX_MACHINES} machines: close it on the PC and start another`,
      );
    }
    const n = await this.o.nameFor(hostname, claim.record);
    if ("refuse" in n) {
      await this.o.store.update((x) => {
        if (x.machines[id]?.name === "") delete x.machines[id];
      });
      return no(n.refuse);
    }
    const key = n.key.trim().split(/\s+/).slice(0, 2).join(" ");
    const named = await this.o.store.update((x) => {
      const other = Object.entries(x.machines).find(
        ([k, m]) => k !== id && m.name === n.name && m.stage !== "refused",
      );
      if (other) return other[1].hostname;
      const m = x.machines[id];
      if (!m) return undefined;
      m.name = n.name;
      m.key = key;
      if (x.name && !x.nameUsed && n.name === x.name) x.nameUsed = true;
      return undefined;
    });
    if (!named) return notFound();
    if (named.result !== undefined) {
      await this.o.store.update((x) => {
        if (x.machines[id]?.name === "") delete x.machines[id];
      });
      return no(
        `${n.name} is already the name of ${named.result} in this session: change this machine's hostname, or pair it alone with --name`,
      );
    }
    const probe = fields["os"] === "windows" ? PROBE_SCRIPT_WINDOWS : PROBE_SCRIPT;
    const sum = await sha256Hex(probe);
    const sig = await mac(r.code, `${nonce}\n${key}\n${n.name}\n${sum}`);
    return textResponse(`ok\nname=${n.name}\nkey=${key}\nsha256=${sum}\nmac=${sig}\n`);
  }

  /** The machine a check-in is from: by the hostname it carries, else the one machine at its address that is still pairing. */
  private whose(record: PairRecord, addr: string, text: string): PairMachine | undefined {
    const asked = /^hostname=(.+)$/m.exec(text)?.[1]?.replace(/\r$/, "").trim() ?? "";
    const here = Object.values(record.machines).filter(
      (m) => m.address === addr && m.stage !== "adopted" && m.stage !== "refused",
    );
    const same = (a: string, b: string) =>
      a.toLowerCase() === b.toLowerCase() || hostnameToName(a) === hostnameToName(b);
    return (
      here.find((m) => asked !== "" && same(m.hostname, asked)) ??
      (here.length === 1 ? here[0] : undefined)
    );
  }

  private async onCheckIn(req: Request, r: PairRecord, addr: string): Promise<Response> {
    const s = await this.signed(req, r, addr);
    if (!s.ok) return s.res;
    const text = new TextDecoder().decode(s.body);
    // Queue the check-in for the person (the same check-in again is the same machine asking once more).
    const put = await this.o.store.update((x): Queued => {
      const found = this.whose(x, addr, text);
      const mine = found ? x.machines[found.hostname.toLowerCase()] : undefined;
      if (!mine?.name) return "hello";
      if (mine.checkIn && mine.checkIn.text !== text) return "busy";
      mine.checkIn ??= { text, at: this.now() };
      if (mine.stage === "hello" || mine.stage === "installing") mine.stage = "waiting";
      return {
        id: mine.hostname.toLowerCase(),
        hello: { hostname: mine.hostname, name: mine.name, key: mine.key, address: mine.address },
      };
    });
    if (!put) return notFound();
    if (put.result === "hello") return no("say hello first (an older script?)");
    if (put.result === "busy") {
      return no("this check-in is already waiting for approval on the PC");
    }
    const { id, hello } = put.result;
    // In this process the decision may come from a function (tests, a single-process session).
    if (this.o.approve && !this.deciding.has(id)) {
      this.deciding.add(id);
      const approve = this.o.approve;
      void approve(text, hello)
        .catch((e: unknown) => ({ ok: false, message: `the PC could not decide: ${String(e)}` }))
        .then((d) =>
          this.o.store.update((x) => {
            const m = x.machines[id];
            if (!m || m.decision) return;
            m.decision = d;
            m.stage = d.ok ? "adopted" : "refused";
          }),
        )
        .finally(() => this.deciding.delete(id));
    }
    // Hold the request until the person decides on this machine or the session ends.
    for (;;) {
      const cur = await this.o.store.read();
      if (!cur) return no("this session has ended: ask for it again on the PC");
      const m = cur.machines[id];
      if (m?.decision) {
        const d = m.decision;
        await this.o.store.update((x) => {
          const mm = x.machines[id];
          if (mm) mm.delivered = true;
        });
        return textResponse(`${d.ok ? "ok" : "no"} ${d.message}\n`);
      }
      if (cur.ended || !m) return no("this session has ended: ask for it again on the PC");
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
