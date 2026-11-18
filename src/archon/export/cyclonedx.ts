/**
 * Spec 092: the fleet's compliance as a CycloneDX 1.6 attestation (CDXA):
 * the standard, what the fleet claims for each requirement, the evidence
 * behind each claim, and how far each claim conforms.
 *
 * - `definitions.standards`: the Secure Controls Framework, by release,
 *   whose requirements are the SCF controls Stolos gives evidence for
 *   (`scf.ts`), with SCF's description when the catalog is on this PC.
 * - `declarations.claims`: one per control. The target is the fleet; the
 *   predicate is what Stolos looks at, in plain words (`scf.ts` `how`).
 * - `declarations.evidence`: each check's result (named by its OSCAL
 *   observation's UUID, `urn:uuid:...`, the same as in the assessment
 *   results made at the same time) and, when a spec 072 evidence bundle is
 *   given, each item in it by its path there (`objects/<sha256>`). Each
 *   claim names the bundle by its SHA-256.
 * - `declarations.attestations`: the fleet (a self-assessor) maps each
 *   requirement to its claim, with a conformance score: the share of the
 *   control's checks that pass (0 without evidence), and why.
 * - `declarations.affirmation`: the fleet signer who signed the bundle (or
 *   the one given), named, with no signature here: the signature is the
 *   bundle's (spec 072), which the signatory's external reference points to.
 *
 * ```mermaid
 * flowchart LR
 *   std["definitions.standards: SCF (release)"] --> req["requirements: SCF controls"]
 *   req --> map["attestation map: conformance score"]
 *   claim["claims: one per control (target: the fleet)"] --> map
 *   ev["evidence: check results (OSCAL observation UUIDs), bundle items (SHA-256)"] --> claim
 *   aff["affirmation: the fleet signer (signature: the bundle's)"]
 * ```
 *
 * The same input exports the same document: the serial number is a UUIDv5
 * of the fleet and the time.
 *
 * @module
 */
// Spec: 092-exporters
// Spec: 111-network-posture FR-014

import { SCF_SOURCE } from "../compliance/catalog.ts";
import { allEvidence, observationUuid, uuidFor } from "../compliance/oscal.ts";
import type { ComplianceView, ControlStatus, Evidence } from "../compliance/report.ts";
import type { ManifestItem } from "../evidence/bundle.ts";
import { VERSION } from "../version.ts";
import type { BundleInfo } from "./intoto.ts";

/** A CycloneDX hash. */
export interface CdxHash {
  /** The algorithm. */
  alg: "SHA-256";
  /** The hash, in hex. */
  content: string;
}

/** A CycloneDX external reference. */
export interface CdxExternalReference {
  /** Its type, from CycloneDX's list. */
  type: "vcs" | "website" | "evidence" | "digital-signature" | "other";
  /** Where it is (an IRI reference). */
  url: string;
  /** What it is. */
  comment?: string;
  /** Its hashes. */
  hashes?: CdxHash[];
}

/** A CycloneDX evidence entry. */
export interface CdxEvidence {
  /** Its reference. */
  "bom-ref": string;
  /** What it is. */
  description: string;
  /** Where its data is. */
  data: Array<{ name: string; contents: { url: string } }>;
  /** When it was made. */
  created: string;
}

/** A CycloneDX claim. */
export interface CdxClaim {
  /** Its reference. */
  "bom-ref": string;
  /** What it is about (the fleet). */
  target: string;
  /** The claim, in words. */
  predicate: string;
  /** Why the evidence supports it. */
  reasoning: string;
  /** The evidence for it. */
  evidence?: string[];
  /** The bundle that holds the evidence. */
  externalReferences?: CdxExternalReference[];
}

/** A CycloneDX 1.6 attestation document, as Stolos fills it. */
export interface CdxAttestation {
  /** CycloneDX. */
  bomFormat: "CycloneDX";
  /** 1.6. */
  specVersion: "1.6";
  /** urn:uuid:<UUIDv5 of the fleet and time>. */
  serialNumber: string;
  /** 1. */
  version: 1;
  /** When, and the tool that made it. */
  metadata: {
    timestamp: string;
    tools: {
      components: Array<{
        type: "application";
        name: string;
        version: string;
        supplier: { name: string };
      }>;
    };
  };
  /** The standard. */
  definitions: {
    standards: Array<{
      "bom-ref": string;
      name: string;
      version: string;
      description: string;
      owner: string;
      requirements: Array<{ "bom-ref": string; identifier: string; title: string; text?: string }>;
      externalReferences: CdxExternalReference[];
    }>;
  };
  /** The claims, their evidence, the attestation, and the affirmation. */
  declarations: {
    assessors: Array<{ "bom-ref": string; thirdParty: false; organization: { name: string } }>;
    attestations: Array<{
      summary: string;
      assessor: string;
      map: Array<{
        requirement: string;
        claims: string[];
        conformance: { score: number; rationale: string };
      }>;
    }>;
    claims: CdxClaim[];
    evidence: CdxEvidence[];
    targets: {
      components: Array<{
        "bom-ref": string;
        type: "platform";
        name: string;
        externalReferences: CdxExternalReference[];
      }>;
    };
    affirmation: {
      statement: string;
      signatories?: Array<{
        name: string;
        role: string;
        organization: { name: string };
        externalReference: CdxExternalReference;
      }>;
    };
  };
}

/** What the attestation describes. */
export interface CdxInput {
  /** The compliance view. */
  view: ComplianceView;
  /** The fleet. */
  fleet: { id: string; title: string; repo: string };
  /** When (the same time as the OSCAL assessment results it names). */
  now: Date;
  /** The fleet signer to name as the signatory (default: the bundle's). */
  signer?: string;
  /** A spec 072 evidence bundle whose items are the evidence. */
  bundle?: BundleInfo;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");

/** A control's conformance: the share of its checks that pass. */
export function conformance(c: ControlStatus): { score: number; rationale: string } {
  const n = c.evidence.length;
  if (!n) return { score: 0, rationale: "no evidence yet" };
  const pass = c.evidence.filter((e) => e.status === "pass").length;
  return {
    score: Math.round((pass / n) * 1000) / 1000,
    rationale: `${pass} of ${n} check(s) pass; the control is ${c.status}`,
  };
}

/** The bundle items that bear on a piece of evidence (always the OSCAL results it is part of). */
export function bundleItemsFor(e: Evidence, items: readonly ManifestItem[]): ManifestItem[] {
  return items.filter((i) => {
    if (i.kind === "oscal") return true;
    switch (e.source) {
      case "managed":
        return i.kind === "verify" && i.name.startsWith(`${e.subject} `);
      case "adopted":
      case "device":
        return i.kind === "observation" && i.name.includes(`/${e.subject}/`);
      case "estate":
      case "cloud":
      case "network":
        // Spec 111-network-posture FR-014: the network's evidence is a router's observation file.
        return i.kind === "observation" && i.name.includes("/estate/");
      case "repository":
        return i.kind === "commit" || i.kind === "signers";
      case "control pack":
        // Spec 078: the pack's code is in the fleet repository's commits.
        return i.kind === "commit";
    }
  });
}

const itemRef = (sha: string) => `evidence:sha256:${sha}`;

/** The CycloneDX 1.6 attestation for the fleet's compliance view. */
export async function cdxAttestation(i: CdxInput): Promise<CdxAttestation> {
  const version = i.view.catalog?.version ?? SCF_SOURCE.version;
  const at = iso(i.now);
  const bundle = i.bundle;
  const items = bundle?.manifest.items ?? [];
  const signer = i.signer ?? bundle?.manifest.signer;
  const target = "target:fleet";
  const assessor = "assessor:fleet";

  // Evidence: each check's result, then each bundle item (once per SHA-256).
  const checks = allEvidence(i.view);
  const checkRef = new Map<Evidence, string>();
  const evidence: CdxEvidence[] = [];
  const oscal = items.find((x) => x.kind === "oscal");
  for (const e of checks) {
    const uuid = await observationUuid(i.fleet.id, i.now, e);
    checkRef.set(e, `evidence:${uuid}`);
    // Two results of the same check on the same subject are one OSCAL observation.
    if (evidence.some((x) => x["bom-ref"] === `evidence:${uuid}`)) continue;
    evidence.push({
      "bom-ref": `evidence:${uuid}`,
      description: `${e.subject}: ${e.check}: ${e.status}${e.detail ? `: ${e.detail}` : ""}`,
      data: [
        { name: "OSCAL observation", contents: { url: `urn:uuid:${uuid}` } },
        ...(oscal ? [{ name: oscal.name, contents: { url: `objects/${oscal.sha256}` } }] : []),
      ],
      created: at,
    });
  }
  const seen = new Set<string>();
  for (const it of bundle ? items : []) {
    if (seen.has(it.sha256)) continue;
    seen.add(it.sha256);
    evidence.push({
      "bom-ref": itemRef(it.sha256),
      description: `${it.kind} ${it.name}, recorded ${it.at}, in ${bundle?.fileName ?? "the bundle"}`,
      data: [{ name: it.name, contents: { url: `objects/${it.sha256}` } }],
      created: it.at,
    });
  }
  const bundleRef: CdxExternalReference[] = bundle
    ? [
        {
          type: "evidence",
          url: bundle.fileName,
          comment: `the evidence bundle (spec 072), ${bundle.manifest.period.from} to ${bundle.manifest.period.to}`,
          hashes: [{ alg: "SHA-256", content: bundle.sha256 }],
        },
      ]
    : [];

  const claims: CdxClaim[] = i.view.controls.map((c) => {
    const refs = new Set<string>();
    for (const e of c.evidence) {
      const ref = checkRef.get(e);
      if (ref !== undefined) refs.add(ref);
      for (const it of bundleItemsFor(e, items)) refs.add(itemRef(it.sha256));
    }
    return {
      "bom-ref": `claim:${c.control.id}`,
      target,
      predicate: `${c.control.id} ${c.control.name}: ${c.control.how}`,
      reasoning: c.evidence.length
        ? `${c.evidence.length} check(s) by Stolos; together they are ${c.status}`
        : "Stolos has no evidence for this control yet",
      ...(refs.size ? { evidence: [...refs] } : {}),
      ...(refs.size && bundleRef.length ? { externalReferences: bundleRef } : {}),
    };
  });

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${await uuidFor(i.fleet.id, "cyclonedx-attestation", at)}`,
    version: 1,
    metadata: {
      timestamp: at,
      tools: {
        components: [
          {
            type: "application",
            name: "Stolos",
            version: VERSION,
            supplier: { name: "Intellectual Frontiers LLC" },
          },
        ],
      },
    },
    definitions: {
      standards: [
        {
          "bom-ref": "standard:scf",
          name: SCF_SOURCE.title,
          version,
          description:
            "The SCF controls Stolos gives evidence for; their mappings to other frameworks are the SCF Council's own (STRM).",
          owner: "SCF Council",
          requirements: i.view.controls.map((c) => ({
            "bom-ref": `requirement:${c.control.id}`,
            identifier: c.control.id,
            title: c.control.name,
            ...(c.control.description ? { text: c.control.description } : {}),
          })),
          externalReferences: [
            {
              type: "website",
              url: SCF_SOURCE.url,
              comment: `${SCF_SOURCE.title} ${SCF_SOURCE.version}`,
              hashes: [{ alg: "SHA-256", content: SCF_SOURCE.sha256 }],
            },
          ],
        },
      ],
    },
    declarations: {
      assessors: [
        {
          "bom-ref": assessor,
          thirdParty: false,
          organization: { name: i.fleet.title },
        },
      ],
      attestations: [
        {
          summary: `${i.fleet.title}: what Stolos observed, as of ${at}, for each SCF control it gives evidence for`,
          assessor,
          map: i.view.controls.map((c) => ({
            requirement: `requirement:${c.control.id}`,
            claims: [`claim:${c.control.id}`],
            conformance: conformance(c),
          })),
        },
      ],
      claims,
      evidence,
      targets: {
        components: [
          {
            "bom-ref": target,
            type: "platform",
            name: i.fleet.title,
            externalReferences: [{ type: "vcs", url: `https://github.com/${i.fleet.repo}` }],
          },
        ],
      },
      affirmation: {
        statement: `${i.fleet.title} affirms these claims, made by Stolos from its evidence${
          bundle ? ` in ${bundle.fileName}` : ""
        }; the signature is the evidence bundle's own (spec 072).`,
        ...(signer
          ? {
              signatories: [
                {
                  name: signer,
                  role: "fleet signer",
                  organization: { name: i.fleet.title },
                  externalReference: bundle
                    ? {
                        type: "digital-signature",
                        url: `${bundle.fileName}#manifest.json.sig`,
                        comment:
                          "the bundle manifest's SSH signature (ssh-keygen -Y, namespace stolos-evidence)",
                      }
                    : {
                        type: "vcs",
                        url: `https://github.com/${i.fleet.repo}`,
                        comment: "a fleet signer: signs the fleet repository's commits",
                      },
                },
              ],
            }
          : {}),
      },
    },
  };
}
