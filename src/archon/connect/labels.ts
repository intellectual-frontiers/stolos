/**
 * Spec 091: the labels connectors fill, declared once (spec 089). Each is a
 * term from MITRE D3FEND or OCSF, and each record a connector reads carries
 * one: `user_account`, `code_repository`, `person` (an HR roster), and
 * `hardware_device` become the estate's accounts, repositories, people, and
 * devices; the others become nodes of the estate graph as they are.
 *
 * @module
 */
// Spec: 091-connectors
// Spec: 109-integrations-api FR-003, FR-015

import { defineLabel, type LabelView } from "../schema/define.ts";
import { codeRepository, userAccount } from "../estate/schema.ts";
import { PERSON_RECORD } from "../people/records.ts";

/** An account in some system (D3FEND user account). */
export const USER_ACCOUNT: LabelView = userAccount;

/** A code repository (D3FEND code repository). */
export const CODE_REPOSITORY: LabelView = codeRepository;

/** A person on an HR system's roster (UDM person): the source of truth for people. */
export const PERSON: LabelView = defineLabel({
  name: "person",
  terms: [{ from: "udm", term: "person" }],
  doc: "A person on an HR system's roster: name, work email, status, dates, manager, and role only.",
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
    access_keys: {
      type: "integer",
      doc: "How many long-lived keys it has (a service account's user-managed keys).",
    },
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
  doc: "A ticket in a service management or work-tracking system (a change, an incident, other work) and the development work it links.",
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

/**
 * An application people sign in to through an identity provider (OCSF
 * application): an Okta app integration, an Entra enterprise application.
 * Spec 080 reads them to discover the fleet's vendors.
 */
export const APPLICATION: LabelView = defineLabel({
  name: "application",
  terms: [{ from: "ocsf", term: "application" }],
  doc: "An application people sign in to through the identity provider (single sign-on): its name and how it signs in.",
  props: {
    catalog_name: {
      type: "text",
      doc: "The identity provider's catalog name for it (Okta's app name), when it has one.",
    },
    sign_on_mode: {
      type: "text",
      doc: "How it signs in (SAML_2_0, OPENID_CONNECT, saml, oidc, ...).",
    },
    active: { type: "boolean", doc: "People can sign in to it." },
    url: { type: "text", doc: "Its home page, when the identity provider knows it." },
    publisher: { type: "text", doc: "Who publishes it, when the identity provider says." },
  },
});

/**
 * A vulnerability a scanner reports on one asset (OCSF vulnerability; emitted
 * as OCSF Vulnerability Finding, 2002): spec 088. Open ones go in the OSCAL
 * POA&M with their CVE, severity, and asset.
 */
export const VULNERABILITY: LabelView = defineLabel({
  name: "vulnerability",
  terms: [{ from: "ocsf", term: "vulnerability" }],
  doc: "A vulnerability a scanner reports on one asset: its CVE, severity, status, the asset, and when it was first seen.",
  props: {
    cve: { type: "text", doc: "Its CVE id (CVE-2024-3094), when it has one." },
    title: { type: "text", doc: "Its title, as the scanner names it." },
    severity: {
      type: "text",
      doc: "critical, high, medium, low, or info (the scanner's, normalized).",
      values: ["critical", "high", "medium", "low", "info"],
    },
    status: {
      type: "text",
      doc: "open, fixed, or dismissed (accepted or ignored in the scanner).",
      values: ["open", "fixed", "dismissed"],
    },
    asset: { type: "text", doc: "What it affects: a host, a repository, a project, an image." },
    package: { type: "text", doc: "The affected package and version, when the scanner says." },
    first_seen: { type: "text", doc: "When the scanner first found it (ISO)." },
    fix_available: { type: "boolean", doc: "A fix (an upgrade, a patch) is available." },
    src_url: { type: "text", doc: "Where it is in the scanner (its URL)." },
  },
});

/** An audit log a cloud keeps (D3FEND event log): a CloudTrail trail, an exported activity log, a log sink. */
export const EVENT_LOG: LabelView = defineLabel({
  name: "event_log",
  terms: [{ from: "d3fend", term: "event_log" }],
  doc: "An audit log a cloud keeps or sends somewhere: a CloudTrail trail, Azure's exported activity log, a Google Cloud log sink.",
  props: {
    kind: { type: "text", doc: "cloudtrail, activity-log, log-sink, ..." },
    logging: { type: "boolean", doc: "It is recording now." },
    multi_region: { type: "boolean", doc: "It records every region." },
    retention_days: { type: "integer", doc: "How long it is kept (days), when the source says." },
    destination: { type: "text", doc: "Where it goes (a bucket, a workspace, a sink's target)." },
    region: { type: "text", doc: "Its home region." },
  },
});

/** A cloud's threat detection (D3FEND intrusion detection system): GuardDuty, a Defender for Cloud plan. */
export const INTRUSION_DETECTION_SYSTEM: LabelView = defineLabel({
  name: "intrusion_detection_system",
  terms: [{ from: "d3fend", term: "intrusion_detection_system" }],
  doc: "A cloud's threat detection: a GuardDuty detector in a region, a Defender for Cloud plan on a subscription.",
  props: {
    kind: { type: "text", doc: "guardduty, defender-plan, ..." },
    enabled: { type: "boolean", doc: "It is on (a paid Defender plan: Standard)." },
    region: { type: "text", doc: "Its region, or the subscription it covers." },
  },
});

/** A cloud's record of its resources' configuration history (D3FEND configuration management database): AWS Config. */
export const CONFIGURATION_MANAGEMENT_DATABASE: LabelView = defineLabel({
  name: "configuration_management_database",
  terms: [{ from: "d3fend", term: "configuration_management_database" }],
  doc: "A cloud's record of its resources' configuration history (an AWS Config recorder).",
  props: {
    recording: { type: "boolean", doc: "It is recording now." },
    all_resources: { type: "boolean", doc: "It records every supported resource type." },
    region: { type: "text", doc: "Its region." },
  },
});

/**
 * A device connected to a network, as its router sees it (OCSF network endpoint): spec 109. Records of this label are the
 * clients of a router; the adopted devices of a controller are `hardware_device` records' sisters, `computer_network_node`.
 */
export const NETWORK_ENDPOINT: LabelView = defineLabel({
  name: "network_endpoint",
  terms: [{ from: "ocsf", term: "network_endpoint" }],
  doc: "A client connected to a network, as its router sees it: its name, kind of connection, MAC and IP address, and the device it connects through.",
  props: {
    kind: { type: "text", doc: "wired, wireless, vpn, or teleport." },
    mac: { type: "text", doc: "Its MAC address." },
    ip: { type: "text", doc: "Its IP address." },
    site: { type: "text", doc: "The site of the controller it is on." },
    uplink: { type: "text", doc: "The id of the network device it connects through." },
    guest: { type: "boolean", doc: "It is a guest of the network." },
    connected_at: { type: "text", doc: "When it connected (ISO)." },
  },
});

/** A network of a router (D3FEND local area network): a VLAN with its id. */
export const LOCAL_AREA_NETWORK: LabelView = defineLabel({
  name: "local_area_network",
  terms: [{ from: "d3fend", term: "local_area_network" }],
  doc: "A network of a router, with its VLAN id.",
  props: {
    vlan_id: { type: "integer", doc: "Its VLAN id (IEEE 802.1Q); 1 is the default network." },
    enabled: { type: "boolean", doc: "It is on." },
    is_default: { type: "boolean", doc: "It is the default network." },
    management: { type: "text", doc: "Who manages it (gateway, switch, or unmanaged)." },
    site: { type: "text", doc: "The site of the controller it is on." },
    zone: { type: "text", doc: "The id of the firewall zone it belongs to." },
    isolated: {
      type: "boolean",
      doc: "Spec 111-network-posture: the network details say it is isolated from all other networks.",
    },
  },
});

/** A device a network is made of (D3FEND computer network node): a gateway, a switch, an access point. */
export const COMPUTER_NETWORK_NODE: LabelView = defineLabel({
  name: "computer_network_node",
  terms: [{ from: "d3fend", term: "computer_network_node" }],
  doc: "A device a network is made of and a controller has adopted: a gateway, a switch, an access point.",
  props: {
    kind: { type: "text", doc: "gateway, switch, access-point, or other." },
    model: { type: "text", doc: "Its model." },
    mac: { type: "text", doc: "Its MAC address." },
    ip: { type: "text", doc: "Its IP address." },
    state: { type: "text", doc: "Its state at the controller (ONLINE, OFFLINE, UPDATING, ...)." },
    firmware: { type: "text", doc: "Its firmware version." },
    firmware_updatable: { type: "boolean", doc: "A firmware update is waiting for it." },
    site: { type: "text", doc: "The site of the controller it is on." },
  },
});

/** A port of a switch (OCSF network interface): its state, speed and power over Ethernet. */
export const NETWORK_INTERFACE: LabelView = defineLabel({
  name: "network_interface",
  terms: [{ from: "ocsf", term: "network_interface" }],
  doc: "A port of a switch or gateway: its state, speed, connector and power over Ethernet.",
  props: {
    device: { type: "text", doc: "The id of the device it is on." },
    device_name: { type: "text", doc: "The name of the device it is on." },
    port: { type: "integer", doc: "Its index on the device." },
    state: { type: "text", doc: "UP, DOWN, or UNKNOWN." },
    speed_mbps: { type: "integer", doc: "Its speed now (Mbps)." },
    max_speed_mbps: { type: "integer", doc: "Its highest speed (Mbps)." },
    connector: { type: "text", doc: "RJ45, SFP, ..." },
    poe_state: { type: "text", doc: "Whether it supplies power (UP, DOWN, LIMITED), when it can." },
    poe_enabled: {
      type: "boolean",
      doc: "Spec 111-network-posture: power over Ethernet is enabled on it (the port's own setting).",
    },
  },
});

/** A rule of a router's firewall (OCSF firewall rule). */
export const FIREWALL_RULE: LabelView = defineLabel({
  name: "firewall_rule",
  terms: [{ from: "ocsf", term: "firewall_rule" }],
  doc: "A rule of a router's firewall: its action, the zones it applies between, and whether it is on.",
  props: {
    enabled: { type: "boolean", doc: "It is on." },
    rule_action: { type: "text", doc: "allow, block, or reject." },
    source_zone: { type: "text", doc: "The name of the zone traffic comes from." },
    destination_zone: { type: "text", doc: "The name of the zone traffic goes to." },
    position: { type: "integer", doc: "Its place in the order of the rules." },
    logging: { type: "boolean", doc: "It writes a log entry when it matches." },
    origin: { type: "text", doc: "system, user, or derived: who made it." },
    site: { type: "text", doc: "The site of the controller it is on." },
  },
});

/** A network that is not a VLAN of a router: a Wi-Fi network an access point broadcasts (D3FEND network). */
export const NETWORK: LabelView = defineLabel({
  name: "network",
  terms: [{ from: "d3fend", term: "network" }],
  doc: "A Wi-Fi network an access point broadcasts: its name, whether it is on, how it is secured.",
  props: {
    kind: { type: "text", doc: "wifi." },
    enabled: { type: "boolean", doc: "It is on." },
    security: {
      type: "text",
      doc: "OPEN, WPA2_PERSONAL, WPA3_PERSONAL, ... (the controller's word).",
    },
    frequencies_ghz: { type: "text", doc: "The frequencies it uses (GHz), comma separated." },
    guest: { type: "boolean", doc: "It is a guest network (a hotspot)." },
    client_isolation: {
      type: "boolean",
      doc: "Spec 111-network-posture: the broadcast's details say its clients are isolated from each other.",
    },
    site: { type: "text", doc: "The site of the controller it is on." },
  },
});

/** A domain's email service (D3FEND mail service): its MX records and what it publishes to be trusted. */
export const MAIL_SERVICE: LabelView = defineLabel({
  name: "mail_service",
  terms: [{ from: "d3fend", term: "mail_service" }],
  doc: "A domain as its email depends on it: its MX records, and whether it publishes SPF, DKIM and DMARC records.",
  props: {
    domain: { type: "text", doc: "The domain." },
    mx: { type: "text", doc: "Its MX hosts, comma separated." },
    spf: { type: "boolean", doc: "It publishes an SPF record." },
    dkim: { type: "boolean", doc: "It publishes at least one DKIM key." },
    dmarc: { type: "boolean", doc: "It publishes a DMARC record." },
    dmarc_policy: {
      type: "text",
      doc: "Its DMARC policy (none, quarantine, reject), when it has one.",
    },
    routing: { type: "boolean", doc: "Email routing is on at the provider." },
  },
});

/** A rule of an email service (D3FEND email rule): an address and what happens to its mail. */
export const EMAIL_RULE: LabelView = defineLabel({
  name: "email_rule",
  terms: [{ from: "d3fend", term: "email_rule" }],
  doc: "A rule of an email routing service: the address it matches, whether it is on, and what it does with a message.",
  props: {
    zone: { type: "text", doc: "The domain it belongs to." },
    enabled: { type: "boolean", doc: "It is on." },
    priority: { type: "integer", doc: "Its priority (lower runs first)." },
    matches: { type: "text", doc: "The addresses it matches, comma separated." },
    actions: { type: "text", doc: "What it does (forward, worker, drop), comma separated." },
    destinations: { type: "integer", doc: "How many addresses it forwards to (never which)." },
    catch_all: { type: "boolean", doc: "It is the rule for every other address." },
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
  APPLICATION,
  VULNERABILITY,
  EVENT_LOG,
  INTRUSION_DETECTION_SYSTEM,
  CONFIGURATION_MANAGEMENT_DATABASE,
  PERSON_RECORD,
  NETWORK_ENDPOINT,
  LOCAL_AREA_NETWORK,
  COMPUTER_NETWORK_NODE,
  NETWORK_INTERFACE,
  FIREWALL_RULE,
  NETWORK,
  MAIL_SERVICE,
  EMAIL_RULE,
];
