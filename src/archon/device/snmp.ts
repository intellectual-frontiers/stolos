/**
 * Spec 069: a small SNMPv3 client, read-only by construction: it sends only
 * GET and GETNEXT, always with authentication and privacy (authPriv): HMAC-SHA-96
 * or HMAC-192-SHA-256 (RFC 3414, RFC 7860) and AES-128-CFB (RFC 3826), with the
 * user-based security model's engine discovery and time synchronization. No
 * SNMPv1 or v2c (community strings travel in the clear) and no SET.
 *
 * In TypeScript, so the PC needs no net-snmp tools (Windows included).
 *
 * @module
 */
// Spec: 069-integrate

import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import dgram from "node:dgram";

/** How to authenticate to a device. */
export interface SnmpCredentials {
  /** The SNMPv3 user. */
  user: string;
  /** The authentication protocol. */
  auth: "sha" | "sha256";
  /** The authentication passphrase. */
  authKey: string;
  /** The privacy passphrase (AES-128). */
  privKey: string;
}

/** A value from a device: a number, text, an OID, or null when it has none. */
export type SnmpValue = string | number | null;

// ---------------------------------------------------------------- BER

function len(n: number): number[] {
  if (n < 0x80) return [n];
  const b: number[] = [];
  while (n > 0) {
    b.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | b.length, ...b];
}
function tlv(tag: number, value: Uint8Array | number[]): Uint8Array {
  const v = value instanceof Uint8Array ? value : Uint8Array.from(value);
  const h = [tag, ...len(v.length)];
  const out = new Uint8Array(h.length + v.length);
  out.set(h);
  out.set(v, h.length);
  return out;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
function int(n: number): Uint8Array {
  const b: number[] = [];
  let x = n;
  do {
    b.unshift(x & 0xff);
    x = Math.floor(x / 256);
  } while (x > 0);
  if ((b[0] ?? 0) & 0x80) b.unshift(0);
  return tlv(0x02, b);
}
const octets = (b: Uint8Array | string): Uint8Array =>
  tlv(0x04, typeof b === "string" ? new TextEncoder().encode(b) : b);
const seq = (...p: Uint8Array[]): Uint8Array => tlv(0x30, cat(...p));

/** An OID's BER bytes. */
export function encodeOid(oid: string): Uint8Array {
  const a = oid.replace(/^\./, "").split(".").map(Number);
  const [first = -1, second = -1, ...rest] = a;
  if (a.length < 2 || a.some((x) => !Number.isInteger(x) || x < 0) || first > 2) {
    throw new Error(`not an OID: ${oid}`);
  }
  const b: number[] = [];
  // The first two arcs are one sub-identifier (40 * a + b), which can need more than a byte (2.999).
  for (const x of [first * 40 + second, ...rest]) {
    const s: number[] = [x & 0x7f];
    let y = Math.floor(x / 128);
    while (y > 0) {
      s.unshift((y & 0x7f) | 0x80);
      y = Math.floor(y / 128);
    }
    b.push(...s);
  }
  return tlv(0x06, b);
}

interface Node {
  tag: number;
  start: number;
  vstart: number;
  end: number;
}
function read(b: Uint8Array, at: number): Node {
  if (at + 2 > b.length) throw new Error("SNMP: message cut short");
  const tag = b[at] ?? 0;
  let l = b[at + 1] ?? 0;
  let v = at + 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    if (n > 4) throw new Error("SNMP: length too long");
    l = 0;
    for (let i = 0; i < n; i++) l = l * 256 + (b[at + 2 + i] ?? 0);
    v += n;
  }
  if (v + l > b.length) throw new Error("SNMP: message cut short");
  return { tag, start: at, vstart: v, end: v + l };
}
function children(b: Uint8Array, n: Node): Node[] {
  const out: Node[] = [];
  for (let at = n.vstart; at < n.end;) {
    const c = read(b, at);
    out.push(c);
    at = c.end;
  }
  return out;
}
/** The `i`th child of a node, or an Error: a message without it is not one this client reads. */
function nth(nodes: readonly Node[], i: number): Node {
  const n = nodes[i];
  if (n === undefined) throw new Error("SNMP: message cut short");
  return n;
}
const bytes = (b: Uint8Array, n: Node): Uint8Array => b.slice(n.vstart, n.end);
function uint(b: Uint8Array, n: Node): number {
  let x = 0;
  for (let i = n.vstart; i < n.end; i++) x = x * 256 + (b[i] ?? 0);
  return x;
}
function sint(b: Uint8Array, n: Node): number {
  let x = uint(b, n);
  const w = n.end - n.vstart;
  if (w && (b[n.vstart] ?? 0) & 0x80) x -= 2 ** (8 * w);
  return x;
}

/** An OID from its BER value. */
export function decodeOid(v: Uint8Array): string {
  const subs: number[] = [];
  let x = 0;
  for (const byte of v) {
    x = x * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      subs.push(x);
      x = 0;
    }
  }
  const [s0] = subs;
  if (s0 === undefined) return "";
  const first = s0 < 80 ? [Math.floor(s0 / 40), s0 % 40] : [2, s0 - 80];
  return [...first, ...subs.slice(1)].join(".");
}

function value(b: Uint8Array, n: Node): SnmpValue {
  const v = bytes(b, n);
  switch (n.tag) {
    case 0x02:
      return sint(b, n);
    case 0x04: {
      const t = new TextDecoder("utf-8", { fatal: false }).decode(v);
      // Binary (a MAC address, say): hex, colon-separated.
      return v.some((x) => x < 9 || (x > 13 && x < 32))
        ? [...v].map((x) => x.toString(16).padStart(2, "0")).join(":")
        : t;
    }
    case 0x06:
      return decodeOid(v);
    case 0x40:
      return [...v].join(".");
    case 0x41:
    case 0x42:
    case 0x43:
    case 0x46:
      return uint(b, n);
    case 0x05:
    case 0x80:
    case 0x81:
    case 0x82:
      return null;
    default:
      return [...v].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
}

// ---------------------------------------------------------------- USM

const hashOf = (a: SnmpCredentials["auth"]): string => (a === "sha256" ? "sha256" : "sha1");
const macLen = (a: SnmpCredentials["auth"]): number => (a === "sha256" ? 24 : 12);

/** RFC 3414 A.2: a passphrase to a key, then localized to an engine. */
export function localizedKey(
  pass: string,
  engineId: Uint8Array,
  auth: SnmpCredentials["auth"],
): Uint8Array {
  if (pass.length < 8) throw new Error("SNMPv3 passphrases have at least 8 characters");
  const h = createHash(hashOf(auth));
  const p = new TextEncoder().encode(pass);
  const chunk = new Uint8Array(64);
  for (let count = 0; count < 1048576; count += 64) {
    for (let i = 0; i < 64; i++) chunk[i] = p[(count + i) % p.length] ?? 0;
    h.update(chunk);
  }
  const ku = new Uint8Array(h.digest());
  return new Uint8Array(
    createHash(hashOf(auth))
      .update(cat(ku, engineId, ku))
      .digest(),
  );
}

/** AES-128-CFB (RFC 3826), from AES-ECB: each keystream block is the cipher of the previous ciphertext. */
export function aesCfb(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
  decrypt: boolean,
): Uint8Array {
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    const c = createCipheriv("aes-128-ecb", key.slice(0, 16), null);
    c.setAutoPadding(false);
    const ks = new Uint8Array(c.update(prev));
    const block = data.slice(i, i + 16);
    const o = block.map((x, j) => x ^ (ks[j] ?? 0));
    out.set(o, i);
    prev = decrypt
      ? Uint8Array.from([...block, ...new Uint8Array(16 - block.length)])
      : Uint8Array.from([...o, ...new Uint8Array(16 - o.length)]);
  }
  return out;
}

interface Engine {
  id: Uint8Array;
  boots: number;
  time: number;
  at: number;
}

const USM_REPORTS: Record<string, string> = {
  "1.3.6.1.6.3.15.1.1.1.0": "the device does not allow this security level (it needs authPriv)",
  "1.3.6.1.6.3.15.1.1.2.0": "not in the time window",
  "1.3.6.1.6.3.15.1.1.3.0": "the device does not know this SNMPv3 user",
  "1.3.6.1.6.3.15.1.1.4.0": "unknown engine",
  "1.3.6.1.6.3.15.1.1.5.0": "wrong authentication passphrase (or protocol)",
  "1.3.6.1.6.3.15.1.1.6.0": "wrong privacy passphrase (or protocol)",
};

/** A read-only SNMPv3 session with one device. */
export class SnmpSession {
  #host: string;
  #port: number;
  #cred: SnmpCredentials;
  #timeoutMs: number;
  #engine?: Engine;
  #keys?: { auth: Uint8Array; priv: Uint8Array };
  #id = Math.floor(Math.random() * 1e9);

  /** A session; nothing is sent until the first request. */
  constructor(host: string, cred: SnmpCredentials, o: { port?: number; timeoutMs?: number } = {}) {
    this.#host = host;
    this.#port = o.port ?? 161;
    this.#cred = cred;
    this.#timeoutMs = o.timeoutMs ?? 3000;
  }

  async #send(msg: Uint8Array): Promise<Uint8Array> {
    const sock = dgram.createSocket(this.#host.includes(":") ? "udp6" : "udp4");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const got = new Promise<Uint8Array | undefined>((ok) => {
          const t = setTimeout(() => ok(undefined), this.#timeoutMs);
          sock.once("message", (m: Uint8Array) => {
            clearTimeout(t);
            ok(new Uint8Array(m));
          });
        });
        sock.send(msg, this.#port, this.#host);
        const r = await got;
        if (r) return r;
      }
      throw new Error(
        `no answer from ${this.#host}:${this.#port} (UDP; is SNMP on, and does the firewall let this PC in?)`,
      );
    } finally {
      sock.close();
    }
  }

  /** The localized keys, known once the engine is discovered. */
  #keysNow(): { auth: Uint8Array; priv: Uint8Array } {
    if (!this.#keys) throw new Error("SNMPv3: no keys before the engine is discovered");
    return this.#keys;
  }

  /** Build a message: the PDU, authenticated and encrypted unless discovering. */
  #message(pdu: Uint8Array, secure: boolean): Uint8Array {
    const id = ++this.#id % 2147483647;
    const e = this.#engine;
    const flags = secure ? 0x07 : 0x04;
    const global = seq(int(id), int(65507), octets(Uint8Array.of(flags)), int(3));
    const boots = e?.boots ?? 0;
    const time = e ? e.time + Math.floor((Date.now() - e.at) / 1000) : 0;
    const salt = secure ? new Uint8Array(randomBytes(8)) : new Uint8Array();
    const scoped = seq(octets(e?.id ?? new Uint8Array()), octets(""), pdu);
    let data = scoped;
    if (secure) {
      const iv = cat(
        Uint8Array.of(boots >>> 24, (boots >>> 16) & 255, (boots >>> 8) & 255, boots & 255),
        Uint8Array.of(time >>> 24, (time >>> 16) & 255, (time >>> 8) & 255, time & 255),
        salt,
      );
      data = octets(aesCfb(this.#keysNow().priv, iv, scoped, false));
    }
    const mac = new Uint8Array(secure ? macLen(this.#cred.auth) : 0);
    const userBits = cat(
      octets(e?.id ?? new Uint8Array()),
      int(boots),
      int(time),
      octets(secure ? this.#cred.user : ""),
    );
    const secInner = cat(userBits, octets(mac), octets(salt));
    const sec = seq(secInner);
    const macOffsetInSec = sec.length - secInner.length + userBits.length + 2; // the MAC octet string's value
    const secOctets = octets(sec);
    const body = cat(int(3), global, secOctets, data);
    const msg = tlv(0x30, body);
    if (secure) {
      const at =
        msg.length -
        body.length +
        int(3).length +
        global.length +
        (secOctets.length - sec.length) +
        macOffsetInSec;
      const h = createHmac(hashOf(this.#cred.auth), this.#keysNow().auth).update(msg).digest();
      msg.set(new Uint8Array(h).slice(0, mac.length), at);
    }
    return msg;
  }

  /** Read a response: check its MAC, decrypt it, and return its PDU's varbinds (or why not). */
  #open(
    m: Uint8Array,
    secure: boolean,
  ): { pdu: number; vars: Array<[string, SnmpValue]>; error: number; engine?: Engine } {
    const top = children(m, read(m, 0));
    const global = nth(top, 1);
    const secN = nth(top, 2);
    const dataN = nth(top, 3);
    const flags = bytes(m, nth(children(m, global), 2))[0] ?? 0;
    const sec = children(m, read(m, secN.vstart));
    const eid = nth(sec, 0);
    const boots = nth(sec, 1);
    const time = nth(sec, 2);
    const macN = nth(sec, 4);
    const saltN = nth(sec, 5);
    const engine: Engine = {
      id: bytes(m, eid),
      boots: uint(m, boots),
      time: uint(m, time),
      at: Date.now(),
    };
    let scopedBytes: Uint8Array;
    let scoped: Node;
    if (flags & 0x01 && secure) {
      const got = bytes(m, macN);
      const zeroed = m.slice();
      zeroed.fill(0, macN.vstart, macN.end);
      const want = new Uint8Array(
        createHmac(hashOf(this.#cred.auth), this.#keysNow().auth).update(zeroed).digest(),
      ).slice(0, got.length);
      if (got.length !== macLen(this.#cred.auth) || !got.every((x, i) => x === want[i])) {
        throw new Error(
          "the device's answer failed authentication (wrong passphrase, or not this device)",
        );
      }
    }
    if (flags & 0x02) {
      if (!secure) throw new Error("an encrypted answer to a discovery");
      const iv = cat(
        Uint8Array.of(
          engine.boots >>> 24,
          (engine.boots >>> 16) & 255,
          (engine.boots >>> 8) & 255,
          engine.boots & 255,
        ),
        Uint8Array.of(
          engine.time >>> 24,
          (engine.time >>> 16) & 255,
          (engine.time >>> 8) & 255,
          engine.time & 255,
        ),
        bytes(m, saltN),
      );
      scopedBytes = aesCfb(this.#keysNow().priv, iv, bytes(m, dataN), true);
      scoped = read(scopedBytes, 0);
    } else {
      scopedBytes = m;
      scoped = dataN;
    }
    const pduN = nth(children(scopedBytes, scoped), 2);
    const pduParts = children(scopedBytes, pduN);
    const errS = nth(pduParts, 1);
    const vbl = nth(pduParts, 3);
    const vars = children(scopedBytes, vbl).map((vb): [string, SnmpValue] => {
      const pair = children(scopedBytes, vb);
      return [decodeOid(bytes(scopedBytes, nth(pair, 0))), value(scopedBytes, nth(pair, 1))];
    });
    return { pdu: pduN.tag, vars, error: sint(scopedBytes, errS), engine };
  }

  async #discover(): Promise<void> {
    const pdu = tlv(0xa0, cat(int(this.#id), int(0), int(0), seq()));
    const r = this.#open(await this.#send(this.#message(pdu, false)), false);
    if (!r.engine?.id.length) {
      throw new Error("the device did not say its SNMPv3 engine (is it SNMPv3?)");
    }
    this.#engine = r.engine;
    const auth = localizedKey(this.#cred.authKey, r.engine.id, this.#cred.auth);
    const priv = localizedKey(this.#cred.privKey, r.engine.id, this.#cred.auth);
    this.#keys = { auth, priv };
  }

  async #request(tag: 0xa0 | 0xa1, oids: string[]): Promise<Array<[string, SnmpValue]>> {
    if (!this.#engine) await this.#discover();
    for (let attempt = 0; attempt < 2; attempt++) {
      const vbl = seq(...oids.map((o) => seq(encodeOid(o), tlv(0x05, []))));
      const pdu = tlv(tag, cat(int(this.#id + 1), int(0), int(0), vbl));
      const r = this.#open(await this.#send(this.#message(pdu, true)), true);
      if (r.pdu === 0xa8) {
        const reported = r.vars[0]?.[0] ?? "";
        const why = USM_REPORTS[reported] ?? `report ${reported}`;
        const known = this.#engine;
        if (why === "not in the time window" && attempt === 0 && r.engine && known) {
          this.#engine = { ...known, boots: r.engine.boots, time: r.engine.time, at: Date.now() };
          continue;
        }
        throw new Error(`SNMPv3: ${why}`);
      }
      if (r.error) throw new Error(`SNMP error ${r.error}`);
      return r.vars;
    }
    throw new Error("SNMPv3: the device's clock and ours disagree");
  }

  /** GET: each OID's value (null when the device has none). */
  async get(oids: string[]): Promise<Record<string, SnmpValue>> {
    return Object.fromEntries(await this.#request(0xa0, oids));
  }

  /** Every value under `base` (GETNEXT), at most `max`. */
  async walk(base: string, max = 200): Promise<Array<[string, SnmpValue]>> {
    const out: Array<[string, SnmpValue]> = [];
    let at = base;
    while (out.length < max) {
      const [next] = await this.#request(0xa1, [at]);
      if (next === undefined) break;
      const [oid, v] = next;
      if (!oid.startsWith(base + ".") || v === null) break;
      out.push([oid, v]);
      at = oid;
    }
    return out;
  }
}
