/**
 * Spec 090: the estate graph's schema, declared once (spec 089's schema
 * language) and generated into the canonical SQL, the docs, and the views.
 * Physical tables follow the Universal Data Model (parties, people, roles,
 * contact mechanisms, fixed assets) and a property graph (tenant, node,
 * label, edge); views carry OCSF's and D3FEND's terms. Every name is cited.
 *
 * ```mermaid
 * flowchart LR
 *   tenant --> node --> node_label
 *   node --- edge
 *   party --> person & organization
 *   person --- party_contact_mechanism --- contact_mechanism
 *   person --- party_fixed_asset_assignment --- fixed_asset
 *   node --> user_account & code_repository
 *   person --> user_inventory
 *   fixed_asset --> device
 * ```
 *
 * @module
 */

import {
  type AnyTable,
  defineLabel,
  defineTable,
  defineView,
  type LabelView,
  schemaDoc,
  schemaSql,
  type ViewDef,
} from "../schema/define.ts";

const time = (doc: string, required = false) => ({ type: "text" as const, doc, required });

/** A connected account: an Okta org, a GitHub org, an AWS account, an HR system, the fleet. */
export const tenant: AnyTable = defineTable({
  name: "tenant",
  terms: [{ from: "iso22123", term: "tenant" }],
  doc:
    "One connected account: an Okta org, a GitHub org, an AWS account, the HR system, or the fleet itself.",
  columns: {
    tenant_uid: { type: "text", doc: 'Its uid: "<connector>:<account>".', required: true },
    connector: {
      type: "text",
      doc: "The connector (okta, github, aws, bamboohr, fleet, ...).",
      required: true,
    },
    name: { type: "text", doc: "Its name for people.", required: true },
    service_model: {
      type: "text",
      doc: "Its NIST SP 800-145 service model.",
      values: ["iaas", "paas", "saas"],
    },
    observed_at: time("When it was last observed (ISO time).", true),
    commit_sha: { type: "text", doc: "The Git commit that recorded that observation." },
  },
  key: ["tenant_uid"],
});

/** Every record from every source. */
export const node: AnyTable = defineTable({
  name: "node",
  terms: [{ from: "ocsf", term: "node" }],
  doc: "Every record from every source, keyed <connector>:<account>:<native id>.",
  columns: {
    node_uid: { type: "text", doc: "Its uid.", required: true },
    label: {
      type: "text",
      doc: "Its primary label (a view: user_account, code_repository, ...).",
      required: true,
      index: true,
    },
    tenant_uid: {
      type: "text",
      doc: "The tenant it belongs to.",
      required: true,
      references: "tenant",
      index: true,
    },
    native_id: { type: "text", doc: "Its id in the source system.", required: true },
    display_name: { type: "text", doc: "Its name for people." },
    ocsf_class_uid: {
      type: "integer",
      doc: "The OCSF class it is reported as (5003 user inventory, 5023 cloud resource, ...).",
    },
    first_seen: time("When an observation in Git first had it (ISO time).", true),
    last_seen: time("When an observation in Git last had it (ISO time).", true),
    stale: {
      type: "boolean",
      doc:
        "1: carried from an earlier observation, because the latest could not read it (see observation).",
      required: true,
    },
    props: {
      type: "json",
      doc: "Its declared properties (no more than a control needs).",
      required: true,
    },
  },
  key: ["node_uid"],
});

/** The labels a node carries beyond its own. */
export const nodeLabel: AnyTable = defineTable({
  name: "node_label",
  terms: [{ from: "ocsf", term: "node" }, { from: "gql", term: "label" }],
  doc: "Labels a node carries: its own (standard), and cross-provider ones (ontology).",
  columns: {
    node_uid: { type: "text", doc: "The node.", required: true, references: "node" },
    label: { type: "text", doc: "The label.", required: true, index: true },
    kind: {
      type: "text",
      doc: "standard or ontology.",
      required: true,
      values: ["standard", "ontology"],
    },
  },
  key: ["node_uid", "label"],
});

/** A relationship, with an active verb, its source, and its basis. */
export const edge: AnyTable = defineTable({
  name: "edge",
  terms: [{ from: "ocsf", term: "edge" }],
  doc: "A relationship between two uids (nodes, parties, fixed assets), with an active verb.",
  columns: {
    src_uid: { type: "text", doc: "From.", required: true },
    verb: {
      type: "text",
      doc: "has_account, observed_as, member_of, administers, affects.",
      required: true,
      values: ["has_account", "observed_as", "member_of", "administers", "affects"],
    },
    dst_uid: { type: "text", doc: "To.", required: true, index: true },
    source: { type: "text", doc: "The connector or derive step that made it.", required: true },
    basis: {
      type: "text",
      doc: "What it rests on.",
      required: true,
      values: ["email", "upn", "saml_name_id", "serial", "hostname", "native", "manual"],
    },
    asserted_by: { type: "text", doc: "Who made a manual edge." },
    reason: { type: "text", doc: "Why, for a manual edge." },
    first_seen: time("When it was first seen.", true),
    last_seen: time("When it was last seen.", true),
  },
  key: ["src_uid", "verb", "dst_uid"],
});

/** Which source supplied each property of a node several sources describe. */
export const nodePropertyProvenance: AnyTable = defineTable({
  name: "node_property_provenance",
  terms: [
    { from: "ocsf", term: "node" },
    { from: "gql", term: "property" },
    { from: "prov", term: "provenance" },
  ],
  doc: "Which source supplied each property, where several describe the same thing.",
  columns: {
    node_uid: { type: "text", doc: "The node, person, or fixed asset.", required: true },
    property: { type: "text", doc: "The property.", required: true },
    source: { type: "text", doc: "The connector it came from.", required: true },
  },
  key: ["node_uid", "property"],
});

/** A person or an organization (UDM). */
export const party: AnyTable = defineTable({
  name: "party",
  terms: [{ from: "udm", term: "party" }],
  doc: "A person or an organization.",
  columns: {
    party_uid: {
      type: "text",
      doc: 'Its uid ("person:<work email>", "organization:<fleet>").',
      required: true,
    },
    party_type: {
      type: "text",
      doc: "person or organization.",
      required: true,
      values: ["person", "organization"],
    },
  },
  key: ["party_uid"],
});

/** A person, created by the first source in the source-of-truth order that knows them. */
export const person: AnyTable = defineTable({
  name: "person",
  terms: [{ from: "udm", term: "person" }],
  doc:
    "A person, created only by the source-of-truth order in fleet.ts (HR systems, then identity providers).",
  columns: {
    party_uid: { type: "text", doc: "The party.", required: true, references: "party" },
    name: { type: "text", doc: "Their name." },
    status: {
      type: "text",
      doc: "active, terminated, leave, or unknown.",
      required: true,
      values: ["active", "terminated", "leave", "unknown"],
    },
    start_date: { type: "text", doc: "Start date (YYYY-MM-DD)." },
    end_date: { type: "text", doc: "End date (YYYY-MM-DD), for a leaver." },
    source: { type: "text", doc: "The source of truth that created them.", required: true },
  },
  key: ["party_uid"],
});

/** An organization: the fleet's own, for now. */
export const organization: AnyTable = defineTable({
  name: "organization",
  terms: [{ from: "udm", term: "organization" }],
  doc: "An organization (the fleet's own).",
  columns: {
    party_uid: { type: "text", doc: "The party.", required: true, references: "party" },
    name: { type: "text", doc: "Its name.", required: true },
  },
  key: ["party_uid"],
});

/** The roles a party plays (UDM): employee, contractor, ... */
export const partyRole: AnyTable = defineTable({
  name: "party_role",
  terms: [{ from: "udm", term: "party_role" }],
  doc: "A role a party plays: employee, contractor, ...",
  columns: {
    party_uid: { type: "text", doc: "The party.", required: true, references: "party" },
    role_type: {
      type: "text",
      doc: "The role (the source's own word: employee, contractor, ...).",
      required: true,
    },
    from_date: { type: "text", doc: "From (YYYY-MM-DD)." },
    thru_date: { type: "text", doc: "Through (YYYY-MM-DD)." },
    source: { type: "text", doc: "Where it came from.", required: true },
  },
  key: ["party_uid", "role_type"],
});

/** A relationship between parties (UDM): reporting lines. */
export const partyRelationship: AnyTable = defineTable({
  name: "party_relationship",
  terms: [{ from: "udm", term: "party_relationship" }],
  doc: "A relationship between two parties: who reports to whom.",
  columns: {
    from_party_uid: { type: "text", doc: "From.", required: true, references: "party" },
    to_party_uid: { type: "text", doc: "To.", required: true },
    party_relationship_type: {
      type: "text",
      doc: "reports_to.",
      required: true,
      values: ["reports_to"],
    },
    source: { type: "text", doc: "Where it came from.", required: true },
  },
  key: ["from_party_uid", "to_party_uid", "party_relationship_type"],
});

/** A way to reach a party (UDM): an electronic address. */
export const contactMechanism: AnyTable = defineTable({
  name: "contact_mechanism",
  terms: [{ from: "udm", term: "contact_mechanism" }],
  doc: "A way to reach a party: an electronic address (email), lowercase.",
  columns: {
    contact_mechanism_uid: { type: "text", doc: 'Its uid ("email:<address>").', required: true },
    contact_mechanism_type: {
      type: "text",
      doc: "electronic_address.",
      required: true,
      values: ["electronic_address"],
    },
    address: { type: "text", doc: "The address.", required: true, index: true },
  },
  key: ["contact_mechanism_uid"],
});

/** Which party uses which contact mechanism, for what (UDM). */
export const partyContactMechanism: AnyTable = defineTable({
  name: "party_contact_mechanism",
  terms: [{ from: "udm", term: "party_contact_mechanism" }],
  doc: "A party's contact mechanisms: their work email, and aliases (from links.ts).",
  columns: {
    party_uid: { type: "text", doc: "The party.", required: true, references: "party" },
    contact_mechanism_uid: {
      type: "text",
      doc: "The mechanism.",
      required: true,
      references: "contact_mechanism",
    },
    contact_purpose: {
      type: "text",
      doc: "work_email or alias.",
      required: true,
      values: ["work_email", "alias"],
    },
  },
  key: ["party_uid", "contact_mechanism_uid"],
});

/** A physical or virtual machine (UDM fixed asset), deduplicated across sources. */
export const fixedAsset: AnyTable = defineTable({
  name: "fixed_asset",
  terms: [{ from: "udm", term: "fixed_asset" }],
  doc:
    "A machine or device, deduplicated across sources by serial number, then hostname; links.ts overrides.",
  columns: {
    fixed_asset_uid: {
      type: "text",
      doc: 'Its uid ("serial:<n>" or "hostname:<name>").',
      required: true,
    },
    fixed_asset_type: {
      type: "text",
      doc: "server, workstation, network_device, or other.",
      required: true,
      values: ["server", "workstation", "network_device", "other"],
    },
    hostname: { type: "text", doc: "Its hostname.", index: true },
    serial_number: { type: "text", doc: "Its serial number.", index: true },
    model: { type: "text", doc: "Its model." },
    os_name: { type: "text", doc: "Its operating system." },
    encrypted: { type: "boolean", doc: "Its disk is encrypted (when known)." },
    managed: {
      type: "boolean",
      doc: "Managed by Stolos (installed and converged), not only observed.",
      required: true,
    },
    first_seen: time("When it was first seen.", true),
    last_seen: time("When it was last seen.", true),
  },
  key: ["fixed_asset_uid"],
});

/** Who a fixed asset is assigned to (UDM). */
export const partyFixedAssetAssignment: AnyTable = defineTable({
  name: "party_fixed_asset_assignment",
  terms: [{ from: "udm", term: "party_fixed_asset_assignment" }],
  doc: "Who a machine is assigned to.",
  columns: {
    party_uid: { type: "text", doc: "The party.", required: true, references: "party" },
    fixed_asset_uid: {
      type: "text",
      doc: "The machine.",
      required: true,
      references: "fixed_asset",
    },
    source: { type: "text", doc: "Where the assignment came from.", required: true },
  },
  key: ["party_uid", "fixed_asset_uid"],
});

/** One policy result (OSCAL and OCSF: a finding). */
export const finding: AnyTable = defineTable({
  name: "finding",
  terms: [{ from: "ocsf", term: "finding" }],
  doc:
    "One policy result about one subject, with its SCF control (reported as OCSF compliance findings).",
  columns: {
    finding_uid: { type: "text", doc: "Its uid.", required: true },
    policy_id: { type: "text", doc: "The policy.", required: true },
    subject_uid: {
      type: "text",
      doc: "What it is about (a node, a party, a fixed asset, a tenant).",
    },
    scf_control: { type: "text", doc: "The SCF control.", required: true },
    status: {
      type: "text",
      doc: "pass, fail, warn, unknown, or accepted.",
      required: true,
      values: ["pass", "fail", "warn", "unknown", "accepted"],
    },
    detail: { type: "text", doc: "What was found." },
    fix: { type: "text", doc: "How to make it pass." },
    observed_at: time("When.", true),
  },
  key: ["finding_uid"],
});

/** What a source could, and could not, read (OSCAL and OCSF: an observation). */
export const observation: AnyTable = defineTable({
  name: "observation",
  terms: [{ from: "ocsf", term: "observation" }],
  doc:
    "What a connector could not read in its latest observation, and why (nothing behind it is dropped).",
  columns: {
    tenant_uid: { type: "text", doc: "The tenant.", required: true, references: "tenant" },
    resource: { type: "text", doc: "What could not be read.", required: true },
    reason: { type: "text", doc: "Why.", required: true },
    observed_at: time("When.", true),
  },
  key: ["tenant_uid", "resource"],
});

/** Accounts in every system (D3FEND user account). */
export const userAccount: LabelView = defineLabel({
  name: "user_account",
  terms: [{ from: "d3fend", term: "user_account" }],
  doc: "An account in some system: an identity provider, a code host, a cloud, a SaaS.",
  props: {
    email: { type: "text", doc: "The person's work email, when the system knows it (lowercase)." },
    active: { type: "boolean", doc: "It can sign in." },
    admin: { type: "boolean", doc: "An administrator there." },
    mfa: { type: "boolean", doc: "It has a second factor." },
    mfa_enforced: { type: "boolean", doc: "A second factor is enforced for it." },
    last_login: { type: "text", doc: "When it last signed in (ISO)." },
    service: { type: "boolean", doc: "A service or bot account, not a person." },
  },
});

/** Code repositories (D3FEND code repository). */
export const codeRepository: LabelView = defineLabel({
  name: "code_repository",
  terms: [{ from: "d3fend", term: "code_repository" }],
  doc: "A code repository on a code host.",
  props: {
    private: { type: "boolean", doc: "It is private." },
    protected: { type: "boolean", doc: "Its default branch is protected." },
    reviews: { type: "integer", doc: "Approving reviews a change needs." },
    secret_scanning: { type: "boolean", doc: "Secret scanning is on." },
    dependency_alerts: { type: "boolean", doc: "Dependency alerts are on." },
  },
});

/** People as OCSF's user inventory (class 5003) shows them. */
export const userInventory: ViewDef = defineView({
  name: "user_inventory",
  terms: [{ from: "ocsf", term: "user_inventory" }],
  doc: "Each person, with OCSF's user attribute names (OCSF class 5003, User Inventory Info).",
  columns: {
    uid: { type: "text", doc: "The person's uid (the party).", required: true },
    name: "Their name.",
    email_addr: "Their work email.",
    status: {
      type: "text",
      doc: "active, terminated, leave, or unknown.",
      required: true,
      values: ["active", "terminated", "leave", "unknown"],
    },
    type: "Their role (employee, contractor, ...).",
    start_date: "Start date.",
    end_date: "End date.",
  },
  select: `SELECT p.party_uid AS uid, p.name, cm.address AS email_addr, p.status,
  (SELECT r.role_type FROM party_role r WHERE r.party_uid = p.party_uid ORDER BY r.role_type LIMIT 1) AS type,
  p.start_date, p.end_date
FROM person p
LEFT JOIN party_contact_mechanism pcm ON pcm.party_uid = p.party_uid AND pcm.contact_purpose = 'work_email'
LEFT JOIN contact_mechanism cm ON cm.contact_mechanism_uid = pcm.contact_mechanism_uid`,
  reads: ["person", "party_role", "party_contact_mechanism", "contact_mechanism"],
});

/** Machines as OCSF's device object names them. */
export const device: ViewDef = defineView({
  name: "device",
  terms: [{ from: "ocsf", term: "device" }],
  doc: "Each machine, with OCSF's device attribute names, and its owner's work email.",
  columns: {
    uid: { type: "text", doc: "The fixed asset's uid.", required: true },
    hostname: "Its hostname.",
    type: {
      type: "text",
      doc: "server, workstation, network_device, or other.",
      required: true,
      values: ["server", "workstation", "network_device", "other"],
    },
    serial_number: "Its serial number.",
    model: "Its model.",
    os_name: "Its operating system.",
    is_encrypted: { type: "boolean", doc: "Its disk is encrypted (null when unknown)." },
    is_managed: { type: "boolean", doc: "Managed by Stolos.", required: true },
    owner_email_addr: "Its owner's work email.",
    first_seen_time_dt: "When it was first seen.",
    last_seen_time_dt: "When it was last seen.",
  },
  select: `SELECT f.fixed_asset_uid AS uid, f.hostname, f.fixed_asset_type AS type, f.serial_number,
  f.model, f.os_name, f.encrypted AS is_encrypted, f.managed AS is_managed,
  (SELECT cm.address FROM party_fixed_asset_assignment a
     JOIN party_contact_mechanism pcm ON pcm.party_uid = a.party_uid AND pcm.contact_purpose = 'work_email'
     JOIN contact_mechanism cm ON cm.contact_mechanism_uid = pcm.contact_mechanism_uid
     WHERE a.fixed_asset_uid = f.fixed_asset_uid LIMIT 1) AS owner_email_addr,
  f.first_seen AS first_seen_time_dt, f.last_seen AS last_seen_time_dt
FROM fixed_asset f`,
  reads: [
    "fixed_asset",
    "party_fixed_asset_assignment",
    "party_contact_mechanism",
    "contact_mechanism",
  ],
});

/** Findings as OCSF compliance findings name them. */
export const complianceFinding: ViewDef = defineView({
  name: "compliance_finding",
  terms: [{ from: "ocsf", term: "compliance_finding" }],
  doc: "Each finding, with OCSF's compliance finding names (class 2003).",
  columns: {
    finding_uid: { type: "text", doc: "The finding's uid.", required: true },
    title: "The policy.",
    control: "The SCF control.",
    status: {
      type: "text",
      doc: "Pass, Warning, Fail, or Unknown.",
      required: true,
      values: ["Pass", "Warning", "Fail", "Unknown"],
    },
    status_detail: "What was found.",
    resource_uid: "What it is about.",
    remediation: "How to make it pass.",
    time_dt: "When.",
  },
  select: `SELECT finding_uid, policy_id AS title, scf_control AS control,
  CASE status WHEN 'pass' THEN 'Pass' WHEN 'warn' THEN 'Warning' WHEN 'fail' THEN 'Fail'
    WHEN 'accepted' THEN 'Fail' ELSE 'Unknown' END AS status,
  detail AS status_detail, subject_uid AS resource_uid, fix AS remediation, observed_at AS time_dt
FROM finding`,
  reads: ["finding"],
});

/** The whole schema, in declaration order. */
export const ESTATE_SCHEMA: ReadonlyArray<AnyTable | ViewDef> = [
  tenant,
  node,
  nodeLabel,
  edge,
  nodePropertyProvenance,
  party,
  person,
  organization,
  partyRole,
  partyRelationship,
  contactMechanism,
  partyContactMechanism,
  fixedAsset,
  partyFixedAssetAssignment,
  finding,
  observation,
  userAccount,
  codeRepository,
  userInventory,
  device,
  complianceFinding,
];

/** The canonical schema SQL. */
export function estateSchemaSql(): string {
  return schemaSql("the estate graph (spec 090)", ESTATE_SCHEMA);
}

/** The schema's documentation, with its ER diagram. */
export function estateSchemaDoc(): string {
  return schemaDoc("The estate graph", ESTATE_SCHEMA);
}
