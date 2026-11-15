/**
 * Spec 091: the labels connectors fill, declared once (spec 089). Each is a
 * term from MITRE D3FEND or OCSF, and each record a connector reads carries
 * one: `user_account`, `code_repository`, `person` (an HR roster), and
 * `hardware_device` become the estate's accounts, repositories, people, and
 * devices; the others become nodes of the estate graph as they are.
 *
 * @module
 */

import { defineLabel, type LabelView } from "../schema/define.ts";
import { codeRepository, userAccount } from "../estate/schema.ts";

/** An account in some system (D3FEND user account). */
export const USER_ACCOUNT: LabelView = userAccount;

/** A code repository (D3FEND code repository). */
export const CODE_REPOSITORY: LabelView = codeRepository;

/** A person on an HR system's roster (UDM person): the source of truth for people. */
export const PERSON: LabelView = defineLabel({
  name: "person",
  terms: [{ from: "udm", term: "person" }],
  doc:
    "A person on an HR system's roster: name, work email, status, dates, manager, and role only.",
  props: {
    email: { type: "text", doc: "Work email." },
    name: { type: "text", doc: "Their name." },
    status: { type: "text", doc: "active, terminated, leave, or unknown." },
    start_date: { type: "text", doc: "Start date (YYYY-MM-DD)." },
    end_date: { type: "text", doc: "End date (YYYY-MM-DD)." },
    manager: { type: "text", doc: "Their manager's work email." },
    role_type: { type: "text", doc: "Employee, contractor, ... (the source's own word)." },
  },
});

/** A device a connector knows (D3FEND hardware device): an MDM's or directory's machines. */
export const HARDWARE_DEVICE: LabelView = defineLabel({
  name: "hardware_device",
  terms: [{ from: "d3fend", term: "hardware_device" }],
  doc: "A machine a connector knows (a directory's, an MDM's, or an EDR's).",
  props: {
    owner: { type: "text", doc: "Its owner's work email." },
    os_name: { type: "text", doc: "Its operating system." },
    serial_number: { type: "text", doc: "Its serial number." },
    encrypted: { type: "boolean", doc: "Its disk is encrypted." },
    last_seen: { type: "text", doc: "When the source last saw it (its last check-in)." },
    hostname: { type: "text", doc: "Its hostname, as the source reports it." },
    managed_by: {
      type: "text",
      doc: "The MDM or EDR that reports it (intune, jamf, crowdstrike, ...).",
    },
    sensor_healthy: {
      type: "boolean",
      doc: "Its EDR sensor is installed, reporting, and fully working.",
    },
    compliant: { type: "boolean", doc: "It meets its MDM's compliance policy." },
  },
});

/** A DNS record (D3FEND DNS record). */
export const DNS_RECORD: LabelView = defineLabel({
  name: "dns_record",
  terms: [{ from: "d3fend", term: "dns_record" }],
  doc: "A DNS record.",
  props: {
    type: { type: "text", doc: "A, AAAA, CNAME, MX, TXT, ..." },
    content: { type: "text", doc: "What it points to." },
    proxied: { type: "boolean", doc: "Behind the provider's proxy." },
  },
});

/** A DNS zone (D3FEND domain name). */
export const DOMAIN_NAME: LabelView = defineLabel({
  name: "domain_name",
  terms: [{ from: "d3fend", term: "domain_name" }],
  doc: "A domain (a DNS zone) and its settings.",
  props: {
    status: { type: "text", doc: "Its status at the provider." },
    dnssec: { type: "boolean", doc: "DNSSEC is on." },
    ssl: {
      type: "text",
      doc: "How the provider's proxy reaches the origin (off, flexible, full, strict).",
    },
    always_use_https: { type: "text", doc: "HTTP is redirected to HTTPS (on or off)." },
    min_tls_version: { type: "text", doc: "The oldest TLS version accepted (1.0, 1.1, 1.2, 1.3)." },
  },
});

/** A server in a cloud (D3FEND server). */
export const SERVER: LabelView = defineLabel({
  name: "server",
  terms: [{ from: "d3fend", term: "server" }],
  doc: "A server (an instance) in a cloud.",
  props: {
    status: { type: "text", doc: "Its state." },
    type: { type: "text", doc: "Its size or instance type." },
    region: { type: "text", doc: "Where it is." },
    backups: { type: "boolean", doc: "Backups are on." },
    protected: { type: "boolean", doc: "Protected from deletion." },
    firewalled: { type: "boolean", doc: "A firewall applies to it." },
    imds_v2: { type: "boolean", doc: "Instance metadata requires tokens (IMDSv2)." },
  },
});

/** Object storage (D3FEND cloud storage). */
export const CLOUD_STORAGE: LabelView = defineLabel({
  name: "cloud_storage",
  terms: [{ from: "d3fend", term: "cloud_storage" }],
  doc: "An object storage bucket.",
  props: {
    region: { type: "text", doc: "Where it is." },
    public_access_blocked: { type: "boolean", doc: "Public access is blocked." },
    created: { type: "text", doc: "When it was created (ISO)." },
  },
});

/** A disk volume (D3FEND volume). */
export const VOLUME: LabelView = defineLabel({
  name: "volume",
  terms: [{ from: "d3fend", term: "volume" }],
  doc: "A block storage volume.",
  props: {
    size_gb: { type: "integer", doc: "Its size (GB)." },
    server: { type: "text", doc: "The server it is attached to." },
    protected: { type: "boolean", doc: "Protected from deletion." },
  },
});

/** A firewall (D3FEND firewall). */
export const FIREWALL: LabelView = defineLabel({
  name: "firewall",
  terms: [{ from: "d3fend", term: "firewall" }],
  doc: "A cloud firewall.",
  props: { rules: { type: "integer", doc: "How many rules it has." } },
});

/** A load balancer (OCSF load balancer). */
export const LOAD_BALANCER: LabelView = defineLabel({
  name: "load_balancer",
  terms: [{ from: "ocsf", term: "load_balancer" }],
  doc: "A load balancer.",
  props: { region: { type: "text", doc: "Where it is." } },
});

/** A public IP address (D3FEND IP address). */
export const IP_ADDRESS: LabelView = defineLabel({
  name: "ip_address",
  terms: [{ from: "d3fend", term: "ip_address" }],
  doc: "A public IP address a cloud assigns.",
  props: {
    address: { type: "text", doc: "The address." },
    type: { type: "text", doc: "ipv4 or ipv6." },
    assigned_to: { type: "text", doc: "What it is assigned to." },
  },
});

/** Software a provider runs for the fleet (D3FEND software): serverless functions, sites, tunnels. */
export const SOFTWARE: LabelView = defineLabel({
  name: "software",
  terms: [{ from: "d3fend", term: "software" }],
  doc: "Software a provider runs for the fleet: a serverless function, a static site, a tunnel.",
  props: {
    kind: { type: "text", doc: "worker, pages, tunnel, ..." },
    status: { type: "text", doc: "Its state (a tunnel's health)." },
    modified: { type: "text", doc: "When it last changed (ISO)." },
  },
});

/** A cloud or SaaS account itself (OCSF account): an AWS account, a Cloudflare account. */
export const ACCOUNT: LabelView = defineLabel({
  name: "account",
  terms: [{ from: "ocsf", term: "account" }],
  doc: "A cloud or SaaS account itself (an AWS account, a Cloudflare account) and its settings.",
  props: {
    caller: { type: "text", doc: "The identity that read it (an ARN)." },
    root_mfa: { type: "boolean", doc: "Its root user has MFA." },
    root_access_keys: { type: "boolean", doc: "Its root user has access keys." },
    public_access_blocked: {
      type: "boolean",
      doc: "Its object storage blocks public access account-wide.",
    },
    regions: { type: "integer", doc: "How many of its compute regions were listed." },
  },
});

/**
 * A cloud's own identity (D3FEND cloud user account): an AWS IAM user. Kept
 * as a record, not an estate account: it signs in to the cloud's API, not
 * as a person on the roster.
 */
export const CLOUD_USER_ACCOUNT: LabelView = defineLabel({
  name: "cloud_user_account",
  terms: [{ from: "d3fend", term: "cloud_user_account" }],
  doc: "A cloud's own user (an AWS IAM user).",
  props: {
    created: { type: "text", doc: "When it was created (ISO)." },
    password_last_used: { type: "text", doc: "When its password last signed in (ISO)." },
  },
});

/** An organization a connector reads (OCSF organization): a tenant, a code host's organization. */
export const ORGANIZATION: LabelView = defineLabel({
  name: "organization",
  terms: [{ from: "ocsf", term: "organization" }],
  doc: "An organization: an identity provider's tenant, a code host's organization.",
  props: {
    mfa_required: { type: "boolean", doc: "It requires a second factor of its members." },
  },
});

/** A role or group that grants access (D3FEND access control group), and who holds it. */
export const ACCESS_CONTROL_GROUP: LabelView = defineLabel({
  name: "access_control_group",
  terms: [{ from: "d3fend", term: "access_control_group" }],
  doc: "A role or group that grants access (an administrator role), and who holds it.",
  props: {
    members: { type: "integer", doc: "How many hold it." },
    member_names: { type: "text", doc: "Who holds it (their sign-in names)." },
  },
});

/** An assessment a source reports (OCSF assessment): who has registered a second factor. */
export const ASSESSMENT: LabelView = defineLabel({
  name: "assessment",
  terms: [{ from: "ocsf", term: "assessment" }],
  doc: "An assessment a source reports about its users (who has registered a second factor).",
  props: {
    registered: { type: "integer", doc: "How many pass it." },
    unregistered: { type: "json", doc: "Who does not (their sign-in names, in order)." },
  },
});

/** A security policy (OCSF policy): security defaults, a Conditional Access policy. */
export const POLICY: LabelView = defineLabel({
  name: "policy",
  terms: [{ from: "ocsf", term: "policy" }],
  doc: "A security policy a provider applies (security defaults, a Conditional Access policy).",
  props: {
    type: { type: "text", doc: "What kind of policy (the source's own words)." },
    enabled: { type: "boolean", doc: "It is on." },
  },
});

/** A product an account holds (OCSF product): a license. */
export const PRODUCT: LabelView = defineLabel({
  name: "product",
  terms: [{ from: "ocsf", term: "product" }],
  doc: "A product an account subscribes to (a license), and how much of it is used.",
  props: {
    used: { type: "integer", doc: "Units in use." },
    bought: { type: "integer", doc: "Units bought." },
  },
});

/** A cloud resource (D3FEND resource): an Azure subscription or anything in one. */
export const RESOURCE: LabelView = defineLabel({
  name: "resource",
  terms: [{ from: "d3fend", term: "resource" }],
  doc: "A resource in a cloud (a subscription, or anything in one).",
  props: {
    type: { type: "text", doc: "Its type (the provider's own name)." },
    region: { type: "text", doc: "Where it is." },
    state: { type: "text", doc: "Its state." },
    subscription: { type: "text", doc: "The subscription it is in." },
  },
});

/**
 * A ticket in an IT service management or work-tracking system (OCSF ticket):
 * a change, an incident, or other work, and the commits or pull requests it
 * links (spec 087).
 */
export const TICKET: LabelView = defineLabel({
  name: "ticket",
  terms: [{ from: "ocsf", term: "ticket" }],
  doc:
    "A ticket in a service management or work-tracking system (a change, an incident, other work) and the development work it links.",
  props: {
    title: { type: "text", doc: "Its title." },
    type: {
      type: "text",
      doc: "change, incident, or other (from its issue type, project, or labels).",
      values: ["change", "incident", "other"],
    },
    status: { type: "text", doc: "Its status (the source's own word)." },
    project: { type: "text", doc: "Its project or team." },
    created: { type: "text", doc: "When it was opened (ISO)." },
    resolved: { type: "text", doc: "When it was resolved or closed (ISO)." },
    links: { type: "json", doc: "The commit SHAs and pull request URLs it links." },
    commits: { type: "integer", doc: "How many commits it links (as the source counts them)." },
    pull_requests: {
      type: "integer",
      doc: "How many pull requests it links (as the source counts them).",
    },
    src_url: { type: "text", doc: "Where it is (its URL)." },
  },
});

/** A shared vault or collection in a password manager (D3FEND password store), and who can open it. */
export const PASSWORD_STORE: LabelView = defineLabel({
  name: "password_store",
  terms: [{ from: "d3fend", term: "password_store" }],
  doc: "A shared vault or collection in a password manager, and who has access to it.",
  props: {
    members: { type: "integer", doc: "How many people can open it (directly or through a group)." },
    member_names: { type: "text", doc: "Who can open it (their email addresses)." },
    granting_groups: { type: "integer", doc: "How many groups grant access to it." },
  },
});

/** Every connector label. */
export const CONNECTOR_LABELS: readonly LabelView[] = [
  USER_ACCOUNT,
  CODE_REPOSITORY,
  PERSON,
  HARDWARE_DEVICE,
  DNS_RECORD,
  DOMAIN_NAME,
  SERVER,
  CLOUD_STORAGE,
  VOLUME,
  FIREWALL,
  LOAD_BALANCER,
  IP_ADDRESS,
  SOFTWARE,
  ACCOUNT,
  CLOUD_USER_ACCOUNT,
  ORGANIZATION,
  ACCESS_CONTROL_GROUP,
  ASSESSMENT,
  POLICY,
  PRODUCT,
  RESOURCE,
  TICKET,
  PASSWORD_STORE,
];
