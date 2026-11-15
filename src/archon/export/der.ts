/**
 * A small ASN.1 DER encoder and reader (ITU-T X.690), just enough for spec
 * 092's S/MIME: build CMS structures (RFC 5652) and read the few fields of an
 * X.509 certificate (RFC 5280) that encryption needs. No dependency: every
 * value is a tag, a length, and its content, as bytes.
 *
 * ```mermaid
 * flowchart LR
 *   v["value (OID, INTEGER, bytes)"] --> tlv["tag, length, content"]
 *   tlv --> seq["SEQUENCE / SET / [n]"]
 *   der["DER bytes"] --> read["readTlv: tag, content, raw"] --> kids["children"]
 * ```
 *
 * @example Encode an OID and read it back
 * ```ts
 * import { oid, readOid, readTlv } from "@stolos/archon/export/der.ts";
 *
 * const bytes = oid("1.2.840.113549.1.7.1");
 * console.log(readOid(readTlv(bytes).content)); // 1.2.840.113549.1.7.1
 * ```
 *
 * @module
 */

/** Universal tag numbers used here (class universal, with the constructed bit where it applies). */
export const TAG = {
  /** INTEGER */
  integer: 0x02,
  /** BIT STRING */
  bitString: 0x03,
  /** OCTET STRING */
  octetString: 0x04,
  /** NULL */
  null: 0x05,
  /** OBJECT IDENTIFIER */
  oid: 0x06,
  /** UTF8String */
  utf8String: 0x0c,
  /** SEQUENCE (constructed) */
  sequence: 0x30,
  /** SET (constructed) */
  set: 0x31,
} as const;

/** Join byte arrays into one. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

/** A DER length: short form below 128, else 0x80 | the number of length bytes, then them. */
export function encodeLength(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`DER: bad length ${n}`);
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** One TLV: this tag byte, the content's length, the content. */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), encodeLength(content.length), content);
}

/** A SEQUENCE of these encodings, in order. */
export const sequence = (...items: Uint8Array[]): Uint8Array => tlv(TAG.sequence, concat(...items));

/**
 * A SET OF these encodings, sorted as DER requires (X.690 11.6: by their
 * encodings, compared as octet strings, a shorter prefix first).
 */
export function setOf(...items: Uint8Array[]): Uint8Array {
  const sorted = [...items].sort(compareBytes);
  return tlv(TAG.set, concat(...sorted));
}

/** Compare two byte strings (lexicographic; a prefix sorts first). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** An OCTET STRING. */
export const octetString = (b: Uint8Array): Uint8Array => tlv(TAG.octetString, b);

/** NULL. */
export const derNull = (): Uint8Array => Uint8Array.of(TAG.null, 0);

/**
 * An INTEGER: a non-negative number (a JavaScript integer or a bigint), or
 * big-endian unsigned magnitude bytes. The minimal two's complement form: a
 * leading 0x00 when the top bit is set, no redundant leading zeros.
 */
export function integer(v: number | bigint | Uint8Array): Uint8Array {
  let bytes: number[];
  if (v instanceof Uint8Array) {
    bytes = [...v];
  } else {
    let x = BigInt(v);
    if (x < 0n) throw new Error("DER: negative integers are not needed here");
    bytes = [];
    do {
      bytes.unshift(Number(x & 0xffn));
      x >>= 8n;
    } while (x > 0n);
  }
  while (bytes.length > 1 && bytes[0] === 0 && bytes[1] < 0x80) bytes.shift();
  if (!bytes.length) bytes = [0];
  if (bytes[0] >= 0x80) bytes.unshift(0);
  return tlv(TAG.integer, Uint8Array.from(bytes));
}

/** An OBJECT IDENTIFIER from its dotted form ("1.2.840.113549"). */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map((s) => {
    if (!/^\d+$/.test(s)) throw new Error(`DER: bad OID ${dotted}`);
    return BigInt(s);
  });
  if (arcs.length < 2 || arcs[0] > 2n) throw new Error(`DER: bad OID ${dotted}`);
  const out: number[] = [];
  const base128 = (n: bigint) => {
    const g: number[] = [Number(n & 0x7fn)];
    for (n >>= 7n; n > 0n; n >>= 7n) g.unshift(Number(n & 0x7fn) | 0x80);
    out.push(...g);
  };
  base128(arcs[0] * 40n + arcs[1]);
  for (const a of arcs.slice(2)) base128(a);
  return tlv(TAG.oid, Uint8Array.from(out));
}

/** A context-specific EXPLICIT tag [n] around one encoding (constructed). */
export const explicit = (n: number, inner: Uint8Array): Uint8Array => tlv(0xa0 | n, inner);

/**
 * A context-specific IMPLICIT tag [n]: this content under the tag, constructed
 * when the underlying type is (a SEQUENCE or SET), primitive otherwise.
 */
export const implicit = (n: number, content: Uint8Array, constructed: boolean): Uint8Array =>
  tlv((constructed ? 0xa0 : 0x80) | n, content);

/** An AlgorithmIdentifier: SEQUENCE { algorithm OID, parameters ANY OPTIONAL }. */
export const algorithm = (id: string, params?: Uint8Array): Uint8Array =>
  params ? sequence(oid(id), params) : sequence(oid(id));

// ---------------------------------------------------------------- reading

/** One element read from DER: its tag byte, its content, and its whole encoding. */
export interface Tlv {
  /** The identifier octet (tags above 30 are not needed here and are refused). */
  tag: number;
  /** The content octets. */
  content: Uint8Array;
  /** The whole element: tag, length, and content (to copy it into another structure). */
  raw: Uint8Array;
}

/** Read the element that starts at `offset`; throws on anything that is not DER this reader knows. */
export function readTlv(bytes: Uint8Array, offset = 0): Tlv {
  const tag = bytes[offset];
  if (tag === undefined) throw new Error("DER: truncated (no tag)");
  if ((tag & 0x1f) === 0x1f) throw new Error("DER: high tag numbers are not supported");
  let i = offset + 1;
  const first = bytes[i++];
  if (first === undefined) throw new Error("DER: truncated (no length)");
  let len = first;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: indefinite or oversized length");
    len = 0;
    for (let k = 0; k < n; k++) {
      const b = bytes[i++];
      if (b === undefined) throw new Error("DER: truncated length");
      len = len * 256 + b;
    }
  }
  if (i + len > bytes.length) throw new Error("DER: truncated content");
  return { tag, content: bytes.subarray(i, i + len), raw: bytes.subarray(offset, i + len) };
}

/** The elements inside a constructed element's content, in order. */
export function children(content: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let i = 0; i < content.length;) {
    const t = readTlv(content, i);
    out.push(t);
    i += t.raw.length;
  }
  return out;
}

/** The dotted form of an OBJECT IDENTIFIER's content octets. */
export function readOid(content: Uint8Array): string {
  const arcs: bigint[] = [];
  let v = 0n;
  for (const b of content) {
    v = (v << 7n) | BigInt(b & 0x7f);
    if (!(b & 0x80)) {
      arcs.push(v);
      v = 0n;
    }
  }
  if (!arcs.length) throw new Error("DER: empty OID");
  const first = arcs[0] < 80n ? arcs[0] / 40n : 2n;
  return [first, arcs[0] - first * 40n, ...arcs.slice(1)].join(".");
}

/** Lower-case hex of these bytes. */
export const hex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Bytes from hex (white space ignored). */
export function fromHex(h: string): Uint8Array {
  const s = h.replace(/\s+/g, "");
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("not hex");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
