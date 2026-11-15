/**
 * S/MIME encryption for spec 092's emailed exports (RFC 8551), with WebCrypto
 * only. Each message is encrypted to each recipient's PUBLIC key, taken from
 * their X.509 certificate: there is no shared secret, and Stolos holds no
 * private key for this. Only the recipient's mail program (or
 * `openssl cms -decrypt`) can open it.
 *
 * The structure is CMS (RFC 5652) AuthEnvelopedData (RFC 5083):
 *
 * - the content (a whole MIME entity: the text and the attached files) is
 *   encrypted once with a fresh AES-256-GCM key (RFC 5084), 12-byte nonce,
 *   16-byte tag (the `mac`);
 * - that key is encrypted to each recipient with RSAES-OAEP, SHA-256 and MGF1
 *   with SHA-256 (RFC 8017, RFC 4055), in a KeyTransRecipientInfo naming the
 *   certificate by issuer and serial number;
 * - the DER (der.ts) goes out as `application/pkcs7-mime;
 *   smime-type=authEnveloped-data`, base64.
 *
 * ```mermaid
 * flowchart LR
 *   mime["MIME entity<br/>(text + files)"] -->|"AES-256-GCM, fresh key"| ct["encryptedContent + mac"]
 *   key["content key"] -->|"RSA-OAEP SHA-256<br/>to each certificate"| ri["RecipientInfos"]
 *   ct & ri --> aed["AuthEnvelopedData (DER)"] --> p7m["application/pkcs7-mime<br/>smime.p7m"]
 * ```
 *
 * Only RSA certificates are supported (by far the most common for S/MIME);
 * an EC certificate is refused with a clear message.
 *
 * @module
 */

import {
  algorithm,
  children,
  derNull,
  explicit,
  hex,
  implicit,
  integer,
  octetString,
  oid,
  readOid,
  readTlv,
  sequence,
  setOf,
  type Tlv,
} from "./der.ts";
import { base64 } from "../notify/mime.ts";

/** Object identifiers used here. */
export const OID = {
  /** id-data (RFC 5652). */
  data: "1.2.840.113549.1.7.1",
  /** id-ct-authEnvelopedData (RFC 5083). */
  authEnvelopedData: "1.2.840.113549.1.9.16.1.23",
  /** id-aes256-GCM (RFC 5084). */
  aes256gcm: "2.16.840.1.101.3.4.1.46",
  /** rsaEncryption (RFC 8017). */
  rsaEncryption: "1.2.840.113549.1.1.1",
  /** id-RSAES-OAEP (RFC 8017, RFC 4055). */
  rsaesOaep: "1.2.840.113549.1.1.7",
  /** id-mgf1. */
  mgf1: "1.2.840.113549.1.1.8",
  /** id-sha256. */
  sha256: "2.16.840.1.101.3.4.2.1",
  /** Common name. */
  commonName: "2.5.4.3",
  /** emailAddress in a subject (PKCS #9). */
  emailAddress: "1.2.840.113549.1.9.1",
  /** subjectAltName. */
  subjectAltName: "2.5.29.17",
  /** keyUsage. */
  keyUsage: "2.5.29.15",
} as const;

/** What encryption needs from a recipient's certificate. */
export interface RecipientCert {
  /** The issuer's Name, its DER as in the certificate. */
  issuer: Uint8Array;
  /** The serial number, the whole INTEGER element as in the certificate. */
  serial: Uint8Array;
  /** The SubjectPublicKeyInfo, DER (RSA). */
  spki: Uint8Array;
  /** The subject's common name, when it has one (for messages). */
  subject?: string;
  /** Email addresses the certificate names (subjectAltName rfc822Name, subject emailAddress). */
  emails: string[];
  /** The end of its validity. */
  notAfter?: Date;
  /** False when a keyUsage extension is present without keyEncipherment. */
  keyEncipherment: boolean;
  /** The serial number in hex (for messages). */
  serialHex: string;
}

/** The DER of the first certificate in PEM text (-----BEGIN CERTIFICATE-----). */
export function pemToDer(pem: string): Uint8Array {
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!m) throw new Error("no PEM certificate (-----BEGIN CERTIFICATE-----) found");
  return Uint8Array.from(atob(m[1].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

function readTime(t: Tlv): Date | undefined {
  const s = new TextDecoder().decode(t.content);
  const m = t.tag === 0x17
    ? s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
    : s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return undefined;
  let y = Number(m[1]);
  if (t.tag === 0x17) y += y >= 50 ? 1900 : 2000;
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]), +m[4], +m[5], +m[6]));
}

/** Attribute values of this type in a Name (SEQUENCE OF SET OF AttributeTypeAndValue). */
function nameValues(name: Tlv, type: string): string[] {
  const out: string[] = [];
  for (const rdn of children(name.content)) {
    for (const atv of children(rdn.content)) {
      const [t, v] = children(atv.content);
      if (t && v && readOid(t.content) === type) out.push(new TextDecoder().decode(v.content));
    }
  }
  return out;
}

/**
 * Read a recipient's certificate (PEM or DER): its issuer and serial number,
 * its RSA public key, the addresses it names, and its validity. Throws with
 * a plain message when it is not an RSA X.509 certificate.
 */
export function parseCertificate(input: string | Uint8Array): RecipientCert {
  const der = typeof input === "string" ? pemToDer(input) : input;
  const cert = readTlv(der);
  const [tbs] = children(cert.content);
  if (!tbs || tbs.tag !== 0x30) throw new Error("not an X.509 certificate");
  const f = children(tbs.content);
  let i = f[0]?.tag === 0xa0 ? 1 : 0; // [0] version
  const serial = f[i++];
  i++; // signature algorithm
  const issuer = f[i++];
  const validity = f[i++];
  const subject = f[i++];
  const spki = f[i++];
  if (!serial || serial.tag !== 0x02 || !issuer || !spki || !subject || !validity) {
    throw new Error("not an X.509 certificate (its fields are not where RFC 5280 puts them)");
  }
  const [alg] = children(spki.content);
  const algOid = readOid(children(alg.content)[0].content);
  if (algOid !== OID.rsaEncryption) {
    throw new Error(
      `the certificate's key is not RSA (algorithm ${algOid}); ask the recipient for an RSA S/MIME certificate`,
    );
  }
  const emails = nameValues(subject, OID.emailAddress);
  let keyEncipherment = true;
  const ext = f.slice(i).find((x) => x.tag === 0xa3);
  if (ext) {
    for (const e of children(children(ext.content)[0].content)) {
      const parts = children(e.content);
      const id = readOid(parts[0].content);
      const value = parts[parts.length - 1].content; // OCTET STRING holding the extension's DER
      if (id === OID.subjectAltName) {
        for (const gn of children(readTlv(value).content)) {
          if (gn.tag === 0x81) emails.push(new TextDecoder().decode(gn.content)); // rfc822Name
        }
      } else if (id === OID.keyUsage) {
        const bits = readTlv(value).content; // BIT STRING: unused-bits byte, then the bits
        keyEncipherment = ((bits[1] ?? 0) & 0x20) !== 0; // bit 2: keyEncipherment
      }
    }
  }
  const notAfter = children(validity.content)[1];
  const cn = nameValues(subject, OID.commonName)[0];
  return {
    issuer: issuer.raw,
    serial: serial.raw,
    spki: spki.raw,
    ...(cn ? { subject: cn } : {}),
    emails: [...new Set(emails.map((e) => e.toLowerCase()))],
    ...(notAfter && readTime(notAfter) ? { notAfter: readTime(notAfter)! } : {}),
    keyEncipherment,
    serialHex: hex(serial.content),
  };
}

/**
 * Why this certificate cannot be used for this address now, or undefined
 * when it can: expired, not for key encipherment, or naming other addresses.
 */
export function certificateProblem(
  c: RecipientCert,
  address: string,
  now: Date = new Date(),
): string | undefined {
  if (c.notAfter && c.notAfter.getTime() < now.getTime()) {
    return `the certificate for ${address} expired on ${c.notAfter.toISOString().slice(0, 10)}`;
  }
  if (!c.keyEncipherment) {
    return `the certificate for ${address} does not allow key encipherment (it is for signing only)`;
  }
  if (c.emails.length && !c.emails.includes(address.toLowerCase())) {
    return `the certificate for ${address} names ${c.emails.join(", ")}, not ${address}`;
  }
  return undefined;
}

/** RSAES-OAEP with SHA-256 and MGF1-SHA-256 as an AlgorithmIdentifier (RFC 4055 section 4.1). */
export function oaepSha256(): Uint8Array {
  const sha256 = algorithm(OID.sha256, derNull());
  return algorithm(
    OID.rsaesOaep,
    sequence(explicit(0, sha256), explicit(1, algorithm(OID.mgf1, sha256))),
  );
}

/** Fixed randomness for tests (the content key and the nonce); random when absent. */
export interface CmsRandom {
  /** The 32-byte AES-256 content key. */
  key?: Uint8Array;
  /** The 12-byte GCM nonce. */
  iv?: Uint8Array;
}

/**
 * CMS ContentInfo holding AuthEnvelopedData: `content` encrypted with
 * AES-256-GCM, its key encrypted to every recipient with RSA-OAEP SHA-256.
 * Returns the DER.
 */
export async function authEnveloped(
  content: Uint8Array,
  recipients: RecipientCert[],
  random: CmsRandom = {},
): Promise<Uint8Array> {
  if (!recipients.length) throw new Error("S/MIME: no recipient to encrypt to");
  const rawKey = random.key ?? crypto.getRandomValues(new Uint8Array(32));
  const iv = random.iv ?? crypto.getRandomValues(new Uint8Array(12));
  if (rawKey.length !== 32 || iv.length !== 12) throw new Error("S/MIME: bad key or nonce size");
  const aes = await crypto.subtle.importKey("raw", new Uint8Array(rawKey), "AES-GCM", false, [
    "encrypt",
  ]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv), tagLength: 128 },
      aes,
      new Uint8Array(content),
    ),
  );
  const encrypted = sealed.subarray(0, sealed.length - 16);
  const mac = sealed.subarray(sealed.length - 16);
  const infos: Uint8Array[] = [];
  for (const r of recipients) {
    const pub = await crypto.subtle.importKey(
      "spki",
      new Uint8Array(r.spki),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const ek = new Uint8Array(
      await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, new Uint8Array(rawKey)),
    );
    // KeyTransRecipientInfo, version 0: rid is IssuerAndSerialNumber.
    infos.push(sequence(integer(0), sequence(r.issuer, r.serial), oaepSha256(), octetString(ek)));
  }
  const gcmParams = sequence(octetString(iv), integer(16));
  const eci = sequence(
    oid(OID.data),
    algorithm(OID.aes256gcm, gcmParams),
    implicit(0, encrypted, false),
  );
  // AuthEnvelopedData: version 0, recipientInfos, authEncryptedContentInfo, mac.
  const aed = sequence(integer(0), setOf(...infos), eci, octetString(mac));
  return sequence(oid(OID.authEnvelopedData), explicit(0, aed));
}

/** Headers of the outer (unencrypted) message: who, the subject, and nothing else. */
export interface SmimeHeaders {
  /** The sender's address, or `Name <address>` already formatted. */
  from: string;
  /** The recipient's address. */
  to: string;
  /** The subject, already header-encoded; it is not encrypted, so it should say little. */
  subject: string;
  /** Extra headers (already encoded). */
  extra?: Record<string, string>;
}

/**
 * A whole RFC 5322 message (CRLF line ends) whose body is the encrypted
 * MIME entity: `application/pkcs7-mime; smime-type=authEnveloped-data`
 * (RFC 8551 section 3.3), base64 in 76-column lines.
 */
export async function smimeMessage(
  h: SmimeHeaders,
  innerEntity: string,
  recipients: RecipientCert[],
  random: CmsRandom = {},
): Promise<string> {
  const der = await authEnveloped(new TextEncoder().encode(innerEntity), recipients, random);
  const head = [
    `From: ${h.from}`,
    `To: ${h.to}`,
    `Subject: ${h.subject}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@stolos>`,
    "MIME-Version: 1.0",
    ...Object.entries(h.extra ?? {}).map(([k, v]) => `${k}: ${v}`),
    'Content-Type: application/pkcs7-mime; smime-type=authEnveloped-data; name="smime.p7m"',
    'Content-Disposition: attachment; filename="smime.p7m"',
    "Content-Transfer-Encoding: base64",
  ];
  return [...head, "", base64(der).replace(/.{1,76}/g, "$&\r\n")].join("\r\n");
}
