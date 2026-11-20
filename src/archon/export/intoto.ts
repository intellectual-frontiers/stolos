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
 * The statement is unsigned. It is IFC TypeScript's (kernel `dsse.statement`);
 * a signer wraps it in a DSSE envelope with kernel `dsse.signStatement`, and
 * a verifier checks it with `dsse.verifyStatement`. Signing a bundle stays
 * spec 072's job (`ssh-keygen -Y sign` over the manifest).
 *
 * ```mermaid
 * flowchart LR
 *   zip["evidence bundle (ZIP)"] --> m["manifest.json"]
 *   zip -- "sha256" --> subj["subject: the bundle and each objects/&lt;sha256&gt;"]
 *   m --> pred["predicate: the manifest's summary"]
 *   subj & pred --> st["in-toto Statement v1"]
 *   st -- "dsse.signStatement" --> dsse["DSSE envelope"]
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
// Spec: 092-exporters

import { dsse, sha256 } from "@intellectual-frontiers/crypto";
import { unzip } from "@intellectual-frontiers/formats";
import { type Manifest, manifestText, NAMESPACE, parseManifest } from "../evidence/bundle.ts";

/** Stolos's predicate type for an evidence bundle's summary. */
export const EVIDENCE_BUNDLE_PREDICATE =
  "https://github.com/intellectual-frontiers/stolos/attestation/evidence-bundle/v1";

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
export type EvidenceStatement = dsse.Statement<EvidenceBundlePredicate> & {
  /** EVIDENCE_BUNDLE_PREDICATE. */
  readonly predicateType: typeof EVIDENCE_BUNDLE_PREDICATE;
};

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
  const files = await unzip(bytes);
  if (files.kind === "err") throw new Error(`${fileName}: not a ZIP (${files.error.kind})`);
  const m = files.value.get("manifest.json");
  if (!m) throw new Error(`${fileName}: no manifest.json (not an evidence bundle)`);
  const manifest = parseManifest(new TextDecoder().decode(m));
  if (manifest.kind === "err") throw new Error(`${fileName}: ${manifest.error}`);
  return {
    fileName: fileName.split(/[\\/]/).pop() ?? fileName,
    sha256: await sha256(bytes),
    manifest: manifest.value,
  };
}

/** The in-toto Statement for a bundle. */
export async function evidenceStatement(b: BundleInfo): Promise<EvidenceStatement> {
  const m = b.manifest;
  const seen = new Set<string>();
  const items: dsse.ResourceDescriptor[] = [];
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
  const predicate: EvidenceBundlePredicate = {
    format: m.format,
    fleet: m.fleet,
    period: m.period,
    created: m.created,
    stolos: m.stolos,
    signer: m.signer,
    manifest: {
      name: "manifest.json",
      digest: { sha256: await sha256(manifestText(m)) },
      signature: "manifest.json.sig",
      namespace: NAMESPACE,
    },
    head: m.head,
    items: { total: m.items.length, by_kind: byKind },
    omitted: m.omitted,
  };
  return {
    ...dsse.statement(
      [{ name: b.fileName, digest: { sha256: b.sha256 }, mediaType: "application/zip" }, ...items],
      EVIDENCE_BUNDLE_PREDICATE,
      predicate,
    ),
    predicateType: EVIDENCE_BUNDLE_PREDICATE,
  };
}
