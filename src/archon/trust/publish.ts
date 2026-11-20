/**
 * Spec 081: what a Trust Center publishes next to its page, and what a public
 * one leaves out.
 *
 * | Shown | Public | Gated |
 * | --- | --- | --- |
 * | the company, the period, the signer, when it was signed | yes | yes |
 * | each framework requirement's status, and its SCF controls | yes | yes |
 * | each control's status, its counts of checks by result, stale counts | yes | yes |
 * | each control's evidence age (newest, oldest observation) | yes | yes |
 * | the SHA-256 of each full-bundle item behind a control, its kind and time | yes | yes |
 * | subjects (hostnames, accounts, the repository), check titles, what each check found | no | yes |
 * | item names (paths, commit ids), people's names and emails in commits | no | yes |
 * | the evidence itself (the full bundle) | no: a summary bundle, or on request | yes |
 *
 * A public build publishes a summary bundle it derives: the same format as
 * spec 072's (`stolos-evidence/1`, each item by its SHA-256, hash-chained),
 * signed by the same fleet signer as the full bundle through a signing
 * callback ({@link archon-evidence!Signer}, spec 072's `sshSigner`). Its items are one JSON
 * document per control and one index, holding only what the public column
 * above says, each bound to the full bundle by its manifest head and its own
 * items' SHA-256. A gated build publishes the full bundle as it is.
 *
 * ```mermaid
 * flowchart LR
 *   full["full bundle (verified)"] --> model["Trust Center model"]
 *   model -- "public" --> red["redact: no subjects, details, names"] --> sum["summary bundle: one item per control, signed"]
 *   model -- "gated" --> pub["the full bundle, as it is"]
 *   sum & pub --> site["evidence/ next to index.html: objects/&lt;sha256&gt;"]
 * ```
 *
 * @module
 */
// Spec: 081-trust-center

import { unzip } from "@intellectual-frontiers/formats";
import {
  forNamespace,
  type Item,
  type Manifest,
  manifestFor,
  manifestText,
  NAMESPACE,
  packBundle,
  type Signer,
  sshVerify,
  verifyBundle,
} from "../evidence/bundle.ts";
import type { TrustControl, TrustModel } from "./model.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The summary documents' format. */
export const SUMMARY_FORMAT = "stolos-trust/1";

/** What a public Trust Center says about one control (and nothing else: see the table above). */
export interface PublicControl {
  /** SUMMARY_FORMAT. */
  format: string;
  /** Its SCF id. */
  id: string;
  /** Its SCF name. */
  name: string;
  /** What Stolos looks at for it, in plain words (Stolos's text, the same for every fleet). */
  how: string;
  /** Its status. */
  status: TrustControl["status"];
  /** How many checks it has. */
  checks: number;
  /** How many have each result, and how many are stale. */
  counts: TrustControl["counts"];
  /** When its newest and oldest evidence was observed, and how many checks have no time. */
  observed: { newest?: string; oldest?: string; untimed: number };
  /** The full bundle's items behind it: SHA-256, kind, and time only. */
  backedBy: Array<{ sha256: string; kind: string; at: string }>;
}

/** The public index: the bundle it summarizes, and each framework's requirements. */
export interface PublicIndex {
  /** SUMMARY_FORMAT. */
  format: string;
  /** The company. */
  company: string;
  /** The period. */
  period: { from: string; to: string };
  /** The full bundle: its file's SHA-256, its manifest's head, its signer, when signed, how many items. */
  source: { sha256: string; head: string; signer: string; created: string; items: number };
  /** The SCF release the mappings are from. */
  scf: string;
  /** Each framework's requirements, with their status and SCF controls. */
  frameworks: Array<{
    id: string;
    title: string;
    requirements: Array<{ id: string; status: string; controls: string[] }>;
  }>;
}

/** One control, redacted for the public. */
export function publicControl(c: TrustControl): PublicControl {
  return {
    format: SUMMARY_FORMAT,
    id: c.id,
    name: c.name,
    how: c.how,
    status: c.status,
    checks: c.checks.length,
    counts: { ...c.counts },
    observed: {
      ...(c.freshness.newest ? { newest: c.freshness.newest } : {}),
      ...(c.freshness.oldest ? { oldest: c.freshness.oldest } : {}),
      untimed: c.freshness.untimed,
    },
    backedBy: c.items.map((i) => ({ sha256: i.sha256, kind: i.kind, at: i.at })),
  };
}

/** The public index of a model. */
export function publicIndex(m: TrustModel): PublicIndex {
  return {
    format: SUMMARY_FORMAT,
    company: m.company,
    period: m.period,
    source: {
      sha256: m.bundle.sha256,
      head: m.bundle.head,
      signer: m.signer,
      created: m.created,
      items: m.bundle.items,
    },
    scf: m.scf.version,
    frameworks: m.frameworks.map((f) => ({
      id: f.id,
      title: f.title,
      requirements: f.requirements.map((r) => ({
        id: r.id,
        status: r.status,
        controls: r.controls,
      })),
    })),
  };
}

/** The item name of a control's summary in the summary bundle. */
export const controlItemName = (id: string): string => `trust/controls/${id}.json`;

/** The item name of the summary bundle's index. */
export const INDEX_ITEM = "trust/index.json";

/** The summary bundle's items: the index, then each control with evidence. */
export function summaryItems(m: TrustModel): Item[] {
  const json = (x: unknown) => enc.encode(JSON.stringify(x, null, 2) + "\n");
  return [
    { kind: "summary", name: INDEX_ITEM, at: m.created, content: json(publicIndex(m)) },
    ...m.controls
      .filter((c) => c.checks.length)
      .map((c) => ({
        kind: "summary" as const,
        name: controlItemName(c.id),
        at: c.freshness.newest ?? m.created,
        content: json(publicControl(c)),
      })),
  ];
}

/**
 * The full bundle's allowed signers, reduced to the one who signed it: its
 * principal and key only (a key's comment is often an email address), for
 * the namespace bundles are signed in.
 */
export function signerLines(allowed: string, signer: string): string {
  const lines = forNamespace(allowed, NAMESPACE)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.split(/\s+/)[0] === signer)
    .map((l) => {
      const p = l.split(/\s+/);
      const k = p.findIndex((x, i) => i > 0 && /^(ssh-|sk-|ecdsa-)/.test(x));
      return [p[0], p[1], p[k], p[k + 1]].join(" ");
    });
  return lines.join("\n") + "\n";
}

/** A summary bundle, made and checked. */
export interface SummaryBundle {
  /** Its bytes (a ZIP). */
  zip: Uint8Array;
  /** Its manifest. */
  manifest: Manifest;
}

/**
 * The public summary bundle: the redacted items, in a spec 072 bundle signed
 * through `sign`. Refused unless it verifies and its signer is the full
 * bundle's (by the full bundle's own allowed signers).
 */
export async function summaryBundle(
  m: TrustModel,
  full: Uint8Array,
  sign: Signer,
  o: { stolos: string; now: Date },
): Promise<SummaryBundle> {
  const files = await unpacked(full);
  const allowed = dec.decode(files["allowed_signers"] ?? new Uint8Array());
  const items = summaryItems(m);
  const manifest = await manifestFor(items, {
    fleet: { id: m.fleetId, title: m.company, repo: "" },
    period: m.period,
    created: o.now.toISOString().replace(/\.\d+Z$/, "Z"),
    stolos: o.stolos,
    signer: m.signer,
    omitted: [
      `a public summary of ${m.bundle.fileName} (SHA-256 ${m.bundle.sha256}): subjects, hostnames, people, what each check found, and the evidence itself are left out, and are available on request`,
    ],
  });
  const text = manifestText(manifest);
  const sig = await sign(text);
  const who = await sshVerify(text, sig, forNamespace(allowed, NAMESPACE), NAMESPACE);
  if (who.signer !== m.signer) {
    throw new Error(
      `the summary must be signed by ${m.signer}, who signed the full bundle: ${
        who.signer ? `it was signed by ${who.signer}` : who.reason
      }`,
    );
  }
  const zip = await packBundle(items, manifest, sig, signerLines(allowed, m.signer));
  const v = await verifyBundle(zip);
  if (!v.ok) throw new Error(`the summary bundle does not verify: ${v.problems.join("; ")}`);
  return { zip, manifest };
}

/** A bundle's files, to publish unzipped beside it (so each item is a link: objects/<sha256>). */
export async function unpacked(zip: Uint8Array): Promise<Record<string, Uint8Array>> {
  const files = await unzip(zip);
  if (files.kind === "err") throw new Error(`not a ZIP (${files.error.kind})`);
  return Object.fromEntries(files.value);
}
