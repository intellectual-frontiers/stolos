/**
 * Spec 092: an evidence bundle (spec 072) as an in-toto Statement v1, and
 * the DSSE envelope that carries a signed one.
 *
 * - **subject**: the bundle file (its name and SHA-256), then each item in
 *   it, named by its path in the bundle (`objects/<sha256>`), with its kind,
 *   name, and time as annotations.
 * - **predicateType**: {@link EVIDENCE_BUNDLE_PREDICATE}. No predicate in
 *   the in-toto attestation framework's list fits a set of compliance
 *   evidence (SLSA Provenance describes a build, Test Result one test run,
 *   SCAI attributes of an artifact), so Stolos defines its own, below.
 * - **predicate**: the manifest's summary (an {@link EvidenceBundlePredicate}).
 *
 * The statement is unsigned. {@link dsseEnvelope} wraps it for a signer:
 * it computes DSSE's pre-authentication encoding (PAE) of the payload type
 * `application/vnd.in-toto+json` and the statement, hands the bytes to a
 * signature callback, and returns the envelope. Signing a bundle stays spec
 * 072's job (`ssh-keygen -Y sign` over the manifest).
 *
 * ```mermaid
 * flowchart LR
 *   zip["evidence bundle (ZIP)"] --> m["manifest.json"]
 *   zip -- "sha256" --> subj["subject: the bundle and each objects/&lt;sha256&gt;"]
 *   m --> pred["predicate: the manifest's summary"]
 *   subj & pred --> st["in-toto Statement v1"]
 *   st -- "PAE, then a signature callback" --> dsse["DSSE envelope"]
 * ```
 *
 * ## The Stolos evidence bundle predicate, v1
 *
 * `predicateType`: `https://github.com/intellectual-frontiers/stolos/attestation/evidence-bundle/v1`
 *
 * | Field | Meaning |
 * | --- | --- |
 * | `format` | the bundle format (`stolos-evidence/1`) |
 * | `fleet` | the fleet's id, name, and repository |
 * | `period` | the period's first and last day (`from`, `to`) |
 * | `created` | when the bundle was made |
 * | `stolos` | the Stolos version that made it |
 * | `signer` | who signed the manifest (a name in the fleet's signers) |
 * | `manifest` | `manifest.json`'s SHA-256, and its signature's file and namespace |
 * | `head` | the manifest's hash chain head |
 * | `items` | how many items, by kind |
 * | `omitted` | evidence that could not be included, and why |
 *
 * @module
 */

import { unzipSync } from "npm:fflate@0.8.2";
import { type Manifest, manifestText, NAMESPACE, sha256Hex } from "../evidence/bundle.ts";

/** The in-toto Statement type. */
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

/** The DSSE payload type of an in-toto statement. */
export const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** Stolos's predicate type for an evidence bundle's summary. */
export const EVIDENCE_BUNDLE_PREDICATE =
  "https://github.com/intellectual-frontiers/stolos/attestation/evidence-bundle/v1";

/** An in-toto ResourceDescriptor, as Stolos fills it. */
export interface ResourceDescriptor {
  /** Its name: the bundle's file name, or an item's path in the bundle. */
  name: string;
  /** Its digests. */
  digest: { sha256: string };
  /** Its media type, when known. */
  mediaType?: string;
  /** What it is (an item's kind, name, and time). */
  annotations?: Record<string, string>;
}

/** The predicate: the manifest's summary. */
export interface EvidenceBundlePredicate {
  /** The bundle format. */
  format: string;
  /** The fleet. */
  fleet: Manifest["fleet"];
  /** The period. */
  period: Manifest["period"];
  /** When the bundle was made. */
  created: string;
  /** The Stolos version that made it. */
  stolos: string;
  /** Who signed the manifest. */
  signer: string;
  /** The manifest, and where its signature is. */
  manifest: { name: string; digest: { sha256: string }; signature: string; namespace: string };
  /** The hash chain's head. */
  head: string;
  /** How many items, in all and by kind. */
  items: { total: number; by_kind: Record<string, number> };
  /** Evidence that could not be included, and why. */
  omitted: string[];
}

/** An in-toto Statement v1 about an evidence bundle. */
export interface EvidenceStatement {
  /** STATEMENT_TYPE. */
  _type: typeof STATEMENT_TYPE;
  /** The bundle, then its items. */
  subject: ResourceDescriptor[];
  /** EVIDENCE_BUNDLE_PREDICATE. */
  predicateType: typeof EVIDENCE_BUNDLE_PREDICATE;
  /** The manifest's summary. */
  predicate: EvidenceBundlePredicate;
}

/** A bundle as the exporters read it: its file name, SHA-256, and manifest. */
export interface BundleInfo {
  /** The bundle's file name (no directory). */
  fileName: string;
  /** The bundle's SHA-256. */
  sha256: string;
  /** Its manifest. */
  manifest: Manifest;
}

/** Read a bundle's SHA-256 and manifest (it is not verified here: `evidence verify` does that). */
export async function bundleInfo(fileName: string, bytes: Uint8Array): Promise<BundleInfo> {
  const files = unzipSync(bytes);
  const m = files["manifest.json"];
  if (!m) throw new Error(`${fileName}: no manifest.json (not an evidence bundle)`);
  const manifest: Manifest = JSON.parse(new TextDecoder().decode(m));
  return {
    fileName: fileName.split(/[\\/]/).pop() ?? fileName,
    sha256: await sha256Hex(bytes),
    manifest,
  };
}

/** The in-toto Statement for a bundle. */
export async function evidenceStatement(b: BundleInfo): Promise<EvidenceStatement> {
  const m = b.manifest;
  const seen = new Set<string>();
  const items: ResourceDescriptor[] = [];
  for (const i of m.items) {
    if (seen.has(i.sha256)) continue;
    seen.add(i.sha256);
    items.push({
      name: `objects/${i.sha256}`,
      digest: { sha256: i.sha256 },
      annotations: { kind: i.kind, name: i.name, at: i.at },
    });
  }
  const byKind: Record<string, number> = {};
  for (const i of m.items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  return {
    _type: STATEMENT_TYPE,
    subject: [
      { name: b.fileName, digest: { sha256: b.sha256 }, mediaType: "application/zip" },
      ...items,
    ],
    predicateType: EVIDENCE_BUNDLE_PREDICATE,
    predicate: {
      format: m.format,
      fleet: m.fleet,
      period: m.period,
      created: m.created,
      stolos: m.stolos,
      signer: m.signer,
      manifest: {
        name: "manifest.json",
        digest: { sha256: await sha256Hex(manifestText(m)) },
        signature: "manifest.json.sig",
        namespace: NAMESPACE,
      },
      head: m.head,
      items: { total: m.items.length, by_kind: byKind },
      omitted: m.omitted,
    },
  };
}

const enc = new TextEncoder();

/**
 * DSSE's pre-authentication encoding: `DSSEv1 <len(type)> <type> <len(body)> <body>`,
 * lengths in bytes, as ASCII decimal.
 *
 * @example
 * ```ts
 * import { pae } from "./intoto.ts";
 * new TextDecoder().decode(pae("http://example.com/HelloWorld", new TextEncoder().encode("hello world")));
 * // "DSSEv1 29 http://example.com/HelloWorld 11 hello world"
 * ```
 */
export function pae(payloadType: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const type = enc.encode(payloadType);
  const head = enc.encode(`DSSEv1 ${type.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head);
  out.set(payload, head.length);
  return out;
}

/** Bytes as standard base64. */
export function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** A DSSE envelope. */
export interface DsseEnvelope {
  /** The payload, base64. */
  payload: string;
  /** Its type. */
  payloadType: string;
  /** The signatures over PAE(payloadType, payload). */
  signatures: Array<{ keyid?: string; sig: string }>;
}

/** Signs PAE bytes: returns the raw signature and, optionally, the key's id. */
export type DsseSigner = (
  pae: Uint8Array<ArrayBuffer>,
) => Promise<{ sig: Uint8Array; keyid?: string }>;

/** A statement in a DSSE envelope, signed by each signer given. */
export async function dsseEnvelope(
  statement: unknown,
  signers: DsseSigner[],
  payloadType: string = INTOTO_PAYLOAD_TYPE,
): Promise<DsseEnvelope> {
  const body = enc.encode(JSON.stringify(statement));
  const toSign = pae(payloadType, body);
  const signatures = [];
  for (const s of signers) {
    const r = await s(toSign);
    signatures.push({ ...(r.keyid ? { keyid: r.keyid } : {}), sig: base64(r.sig) });
  }
  return { payload: base64(body), payloadType, signatures };
}
