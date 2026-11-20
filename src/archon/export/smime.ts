/**
 * S/MIME for spec 092's emailed exports (RFC 8551): the message around IFC
 * TypeScript's CMS encryption (kernel `cms.authEnveloped`). Each message is
 * encrypted to each recipient's PUBLIC key, taken from their X.509
 * certificate: there is no shared secret, and Stolos holds no private key
 * for this. Only the recipient's mail program (or `openssl cms -decrypt`)
 * can open it.
 *
 * The kernel writes CMS (RFC 5652) AuthEnvelopedData (RFC 5083): the content
 * (a whole MIME entity: the text and the attached files) encrypted once with
 * a fresh AES-256-GCM key, that key encrypted to each recipient with
 * RSAES-OAEP SHA-256. This module wraps the DER as
 * `application/pkcs7-mime; smime-type=authEnveloped-data`, base64, in a whole
 * RFC 5322 message.
 *
 * ```mermaid
 * flowchart LR
 *   mime["MIME entity<br/>(text + files)"] -->|"cms.authEnveloped"| aed["AuthEnvelopedData (DER)"]
 *   aed --> p7m["application/pkcs7-mime<br/>smime.p7m"]
 * ```
 *
 * Only RSA certificates are supported (by far the most common for S/MIME);
 * an EC certificate is refused with a clear message.
 *
 * @module
 */
// Spec: 092-exporters

import { absurd } from "@intellectual-frontiers/core";
import { cms, toBase64 } from "@intellectual-frontiers/commons/ts/kernel";

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

/** Fresh secrets for one message, from the platform's random source. */
export function freshKeys(): cms.CmsKeys {
  return cms.cmsKeys((n) => crypto.getRandomValues(new Uint8Array(n)));
}

/** A certificate problem in words. */
export function describeCertificateProblem(p: cms.CertificateProblem): string {
  switch (p.kind) {
    case "not-rsa":
      return `its key is not RSA (${p.algorithm}); Stolos encrypts to RSA certificates only`;
    case "not-yet-valid":
      return `it is valid only from ${p.from.toISOString().slice(0, 10)}`;
    case "expired":
      return `it expired on ${p.on.toISOString().slice(0, 10)}`;
    case "signing-only":
      return "it is for signing only (its key usage has no keyEncipherment)";
    case "other-address":
      return `it is for ${p.names.join(", ")}`;
    default:
      return absurd(p);
  }
}

/** A PEM (or DER) certificate, read; throws saying why it is not one. */
export function parseCertificate(input: string | Uint8Array): cms.Certificate {
  let der: Uint8Array;
  if (typeof input === "string") {
    const pem = cms.readPem(input, "CERTIFICATE");
    if (pem.kind === "err") throw new Error(cms.formatCmsError(pem.error));
    const [first] = pem.value;
    if (first === undefined) throw new Error("no CERTIFICATE in the PEM text");
    der = first;
  } else der = input;
  const c = cms.readCertificate(der);
  if (c.kind === "err") throw new Error(cms.formatCmsError(c.error));
  return c.value;
}

/**
 * A whole RFC 5322 message (CRLF line ends) whose body is the encrypted
 * MIME entity: `application/pkcs7-mime; smime-type=authEnveloped-data`
 * (RFC 8551 section 3.3), base64 in 76-column lines.
 */
export async function smimeMessage(
  h: SmimeHeaders,
  innerEntity: string,
  recipients: readonly cms.Certificate[],
  keys: cms.CmsKeys = freshKeys(),
): Promise<string> {
  const der = await cms.authEnveloped(new TextEncoder().encode(innerEntity), recipients, keys);
  if (der.kind === "err") throw new Error(cms.formatCmsError(der.error));
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
  return [...head, "", toBase64(der.value).replace(/.{1,76}/g, "$&\r\n")].join("\r\n");
}
