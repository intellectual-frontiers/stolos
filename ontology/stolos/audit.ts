/**
 * The basis of every term of Stolos' vocabulary (commons 0018-standards-first FR-003 to FR-005, 0012-ontology FR-014; spec 104-mizan FR-003): which standard each class and property
 * rests on, or that none is adopted yet. It is the first audit of this ontology as data and the baseline of its drift: one property maps to a Dublin Core term, and the rest are
 * `unaligned`, each with the candidates still to examine and the day of the audit, from which its decision is due within 90 days.
 *
 * @remarks
 * The vocabulary itself is unchanged: this file describes its terms, and `bun run check:mizan` fails where a class or a property has no record here.
 * A candidate is a place to look, not a verdict: an `unaligned` term may still be right. `stolos:Decision` is not the commons `mz:Decision` (which records why a term is
 * `unaligned`): it is what a person decided about the fleet, so it waits for commons to generalize `mz:Decision` (issue 10 of the commons repository) and is not mapped to it.
 *
 * @module
 */
// Spec: 104-mizan FR-003
import { bases, MZ, MZID, OntologyTerm } from "@intellectual-frontiers/commons/ontology/mizan";
import { rdf } from "@intellectual-frontiers/commons/ts/kernel";
import { STOLOS, stolos } from "./vocabulary.ts";

const { en, RDFS, SKOS, term, XSD } = rdf;

/** The day the audit was made, from which the decision of each `unaligned` term is due (commons 0018-standards-first FR-005). */
export const AUDITED_ON = "2026-11-17";

/** What is still to examine for a term, by its local name; a term not listed has no candidate found yet. */
const CANDIDATES: Readonly<Record<string, string>> = {
  Fleet:
    "none found in schema.org; NIST SP 800-53 CM-8 (system component inventory) for the set of components",
  Host: "NIST SP 800-53 CM-8 (component), OCSF device object, CycloneDX or SPDX component, schema:Product",
  AdoptedMachine: "as Host",
  Controller: "as Host",
  Device: "OCSF device object, NIST SP 800-53 CM-8",
  Signer: "OpenPGP and SSH signature key terms, Sigstore identities; none found as a vocabulary",
  ConsoleDevice: "W3C WebAuthn credential terms (PublicKeyCredential)",
  Capability: "schema:SoftwareApplication, commons' mz:Capability once CCM is pulled up",
  Check: "NIST SP 800-53 control assessment (OSCAL assessment-results), OCSF compliance finding",
  Finding: "OCSF finding classes (already written as OCSF), OSCAL finding",
  Record: "W3C PROV-O prov:Entity",
  Decision: "commons' mz:Decision once generalized (see the module note); W3C PROV-O prov:Activity",
  PairingCode: "none found",
  TrustedNetwork: "none found",
  EngineRelease: "schema:SoftwareApplication with schema:softwareVersion, SPDX 3 software package",
  ConsoleName: "none found",
  OutcomeLevel: "OpenTelemetry severity numbers, OCSF severity_id",
  MachineKind: "none found",
  SignerRole: "none found",
  CommandTier: "none found",
  DataClass: "NIST SP 800-60 information types, FIPS 199 categories",
  IntegrationKind: "none found",
  TagRule:
    "none found as a vocabulary; NIST SP 800-128 configuration management for rules over component facts",
  TagSelection: "none found; a boolean expression over concepts (SKOS has no query language)",
  Listener: "IANA service names and port numbers (RFC 6335)",
  Door: "none found",
  DevicePath: "none found",
  FileKind: "none found",
  protocol: "IANA protocol numbers and service names",
  port: "IANA service names and port numbers (RFC 6335)",
  onListener: "none found",
  pathPrefix: "none found",
  emoji: "none found",
  ascii: "none found",
};

/** The terms of Stolos' vocabulary that rest on a Dublin Core term. */
const MAPPED: Readonly<Record<string, string>> = {
  spec: "http://purl.org/dc/terms/source",
  // Spec 108-tags: a tag is a concept, a dimension is the scheme it belongs to, a group is a collection of them, and the three code lists are schemes (W3C SKOS).
  Tag: "http://www.w3.org/2004/02/skos/core#Concept",
  TagDimension: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  TagGroup: "http://www.w3.org/2004/02/skos/core#Collection",
  TagColour: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  TagCardinality: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  TagOrigin: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
};

function record(local: string) {
  const iri = (stolos as Readonly<Record<string, { readonly iri: string }>>)[local]?.iri ?? "";
  const base = { label: en(`stolos:${local}`), termIri: iri, definedBy: ["101-ladder"] };
  const std = MAPPED[local];
  if (std !== undefined) {
    return OntologyTerm.make(term(MZID, `term-stolos-${local}`), {
      ...base,
      basis: bases.Maps,
      standardTerm: std,
      mappingRelation: "closeMatch",
    });
  }
  return OntologyTerm.make(term(MZID, `term-stolos-${local}`), {
    ...base,
    basis: bases.Unaligned,
    justification: `No standard adopted yet. Candidates to examine: ${CANDIDATES[local] ?? "none found"}. Decision pending (commons 0018-standards-first FR-005).`,
    addedOn: AUDITED_ON,
  });
}

/** One record for every class and property of Stolos' vocabulary, in the order of the vocabulary. */
export const terms = Object.keys(stolos).map(record);

/** The file this module states: its name, its prefixes and its individuals. */
export const file = {
  name: "audit",
  prefixes: [STOLOS, MZ, MZID, RDFS, SKOS, XSD],
  individuals: terms,
};
