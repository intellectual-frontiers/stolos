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
// Spec: 114-release-record FR-004
// Spec: 115-compatibility FR-001
// Spec: 116-kept-unaligned FR-001, FR-002, FR-003, FR-004, FR-005
// Spec: 110-network-assets FR-001
import {
  bases,
  Decision,
  MZ,
  MZID,
  OntologyTerm,
} from "@intellectual-frontiers/commons/ontology/mizan";
import * as rdf from "@intellectual-frontiers/rdf";
import { STOLOS, stolos } from "./vocabulary.ts";

const { en, RDFS, SKOS, term, XSD } = rdf;

/** The day the audit was made, from which the decision of each `unaligned` term is due (commons 0018-standards-first FR-005). */
export const AUDITED_ON = "2026-11-17";

/** The day of the owner's decision to keep the terms below unaligned (spec 116-kept-unaligned FR-002). */
export const KEPT_UNALIGNED_ON = "2026-11-17";

/** The day by which the terms kept unaligned are looked at again (spec 116-kept-unaligned FR-002). */
export const KEPT_UNALIGNED_REVIEW_BY = "2027-02-15";

/** The sentence a term kept unaligned carries in its justification in place of "Decision pending" (spec 116-kept-unaligned FR-003). */
export const KEPT_UNALIGNED_SENTENCE = `Kept unaligned by the owner's decision of ${KEPT_UNALIGNED_ON} (stolos issue #37); reviewed again by ${KEPT_UNALIGNED_REVIEW_BY}.`;

/** The identifier of the `mz:Decision` of a term kept unaligned, `decision-stolos-<local>`, for its audit record's `mz:decision` (spec 116-kept-unaligned FR-002). */
export function keptUnalignedDecisionId(local: string): ReturnType<typeof term<"mz:Decision">> {
  return term<"mz:Decision">(MZID, `decision-stolos-${local}`);
}

/**
 * The `mz:Decision` of a Stolos term kept unaligned, in the shape of commons' `keptUnalignedDecision` (which accepts only commons' own ontologies): it says of the term with
 * the record `term-stolos-<local>` that it stays unaligned, on the day of the decision, with where it is recorded. Who decided what and when is W3C PROV-O's question; commons'
 * `mz:Decision` answers it with `decidedOn` and `record` (spec 116-kept-unaligned FR-002).
 */
export function keptUnalignedDecision(local: string): ReturnType<typeof Decision.make> {
  return Decision.make(keptUnalignedDecisionId(local), {
    label: en(`Keep stolos:${local} unaligned`),
    decisionOf: term<"mz:OntologyTerm">(MZID, `term-stolos-${local}`),
    decidedOn: KEPT_UNALIGNED_ON,
    record: `owner decision of ${KEPT_UNALIGNED_ON} in stolos issue #37: keep the term unaligned; reviewed again by ${KEPT_UNALIGNED_REVIEW_BY}`,
  });
}

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
  Lease:
    "RFC 2131 and RFC 8415 (DHCP) define the lease in prose and no vocabulary; OCSF dhcp_activity is an event class, not a lease; D3FEND dhcp_service and DHCPServer are the service",
  PortForward:
    "none found as a vocabulary; RFC 4787 (NAT behavioral requirements) and RFC 6887 (PCP) name the mapping, OCSF has no port-forward object",
  Route:
    "RFC 1812 (router requirements) and RFC 8349 (YANG routing management) name routes; no RDF vocabulary found; OCSF has no route object",
  WifiNetwork:
    "IEEE 802.11 (an SSID and a BSS); D3FEND WirelessLink and WirelessAccessPoint are the link and the device, not the named network; NIST SP 800-153",
  RouterHealth:
    "none found; OpenTelemetry system and device semantic conventions for metrics, OCSF metric object, RFC 8343 (YANG interfaces state)",
  EmailSender:
    "RFC 5321 (SMTP) and RFC 7489 (DMARC) name sending domains and their authentication; schema:EmailMessage is a message; no vocabulary for a sending domain found",
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
  // Spec 112-machine-reported-tags: the two new code lists are concept schemes (W3C SKOS); a claim a machine makes about itself is a statement (RDF 1.1: rdf:Statement, a subject, a predicate and an object, with who made it).
  TagTrust: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  TagSource: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  TagClaim: "http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement",
  // Spec 115-compatibility: the seams and the compatibility statuses are code lists, which are concept schemes (W3C SKOS); the version of each seam is a Semantic Version 2.0.0 (commons' ifr:VersionScheme SemVer).
  Seam: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  CompatStatus: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  // Spec 109-integrations-api: the two code lists are concept schemes (W3C SKOS); an integration is a web API an account offers (schema.org WebAPI); the entities it reads are
  // OCSF 1.9.0 objects (documented at schema.ocsf.io, which publishes no RDF) or MITRE D3FEND classes, each narrower or as close as its relation says.
  ApiKind: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  ApiCapability: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  ApiIntegration: "https://schema.org/WebAPI",
  NetworkClient: "https://schema.ocsf.io/1.9.0/objects/network_endpoint",
  NetworkDevice: "http://d3fend.mitre.org/ontologies/d3fend.owl#ComputerNetworkNode",
  Vlan: "http://d3fend.mitre.org/ontologies/d3fend.owl#LocalAreaNetwork",
  SwitchPort: "https://schema.ocsf.io/1.9.0/objects/network_interface",
  FirewallRule: "https://schema.ocsf.io/1.9.0/objects/firewall_rule",
  DnsZone: "http://d3fend.mitre.org/ontologies/d3fend.owl#DomainName",
  DnsRecord: "http://d3fend.mitre.org/ontologies/d3fend.owl#DNSRecord",
  EmailDomain: "http://d3fend.mitre.org/ontologies/d3fend.owl#DomainName",
  EmailRoute: "http://d3fend.mitre.org/ontologies/d3fend.owl#EmailRule",
  // Spec 110-network-assets: the class of a network device and the facets a feature asks for are code lists, which are concept schemes (W3C SKOS). Their codes follow the OCSF device
  // object's types (Firewall, Switch, IOT, Other) and IEEE 802.1Q and 802.11, written in the code's own table (`network-class.ts`).
  DeviceClass: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  DeviceFacet: "http://www.w3.org/2004/02/skos/core#ConceptScheme",
  // Spec 114-release-record: an engine release is the release of one work of commons' IFR (0026-works-versioning), the annotated tag `stolos-v<version>`; it is narrower, because it is the release of the one work `stolos`.
  EngineRelease: "https://www.intellectualfrontiers.com/ontology/ifr#Release",
};

/** How a mapped term relates to the standard's term, where it is not `closeMatch`: the narrower terms and the broader standard term. */
const RELATION: Readonly<Record<string, "narrowMatch" | "broadMatch">> = {
  NetworkClient: "narrowMatch",
  NetworkDevice: "narrowMatch",
  Vlan: "narrowMatch",
  SwitchPort: "narrowMatch",
  EmailDomain: "broadMatch",
  EngineRelease: "narrowMatch",
  TagClaim: "narrowMatch",
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
      mappingRelation: RELATION[local] ?? "closeMatch",
    });
  }
  return OntologyTerm.make(term(MZID, `term-stolos-${local}`), {
    ...base,
    basis: bases.Unaligned,
    justification: `No standard adopted yet. Candidates to examine: ${CANDIDATES[local] ?? "none found"}. ${KEPT_UNALIGNED_SENTENCE}`,
    decision: keptUnalignedDecisionId(local),
    addedOn: AUDITED_ON,
  });
}

/** One record for every class and property of Stolos' vocabulary, in the order of the vocabulary. */
export const terms = Object.keys(stolos).map(record);

/** The decision of every term kept unaligned: one for each class and property with no mapping (spec 116-kept-unaligned FR-001). */
export const decisions = Object.keys(stolos)
  .filter((local) => MAPPED[local] === undefined)
  .map(keptUnalignedDecision);

/** The file this module states: its name, its prefixes and its individuals. */
export const file = {
  name: "audit",
  prefixes: [STOLOS, MZ, MZID, RDFS, SKOS, XSD],
  individuals: [...terms, ...decisions],
};
