/**
 * Spec 092: the estate and the compliance view as OCSF 1.9.0 events, one
 * JSON object per line (JSON Lines), for a SIEM or a data lake to read
 * without a parser of its own. Every event is typed by the generated OCSF
 * types, so a missing required attribute does not compile.
 *
 * | What | OCSF class | One event per |
 * | --- | --- | --- |
 * | a person (the source of truth) | 5003 User Inventory Info | person |
 * | an account in some system | 5003 User Inventory Info | account (after its person) |
 * | a machine (fixed asset) | 5001 Device Inventory Info | fixed asset |
 * | a scanner's vulnerability (spec 088) | 2002 Vulnerability Finding | node |
 * | any other record (repositories, ...) | 5023 Cloud Resources Inventory Info | node |
 * | a check's result | 2003 Compliance Finding | evidence and SCF control (`finding.ts`) |
 *
 * ```mermaid
 * flowchart LR
 *   estate[("estate graph")] --> people["5003 per person, then their accounts"]
 *   estate --> devices["5001 per fixed asset"]
 *   estate --> nodes["5023 per other node"]
 *   view["compliance view"] --> findings["2003 per evidence and SCF control"]
 *   people & devices & nodes & findings --> jsonl["ocsf.jsonl"]
 * ```
 *
 * Only what the estate already holds goes out: a person's name, work email,
 * status, role, dates, and manager; an account's name, email, and flags; a
 * machine's names, serial number, operating system, and owner's work email.
 * An account is tied to its person by `metadata.correlation_uid` (the
 * person's uid). Activity is 2 (Collect): Stolos collected it from the
 * sources; severity is 1 (Informational) for inventory.
 *
 * @module
 */

import type { ScfCatalog } from "../compliance/catalog.ts";
import { allEvidence } from "../compliance/oscal.ts";
import type { ComplianceView } from "../compliance/report.ts";
import type { Estate } from "../estate/graph.ts";
import { complianceFindings } from "../ocsf/finding.ts";
import {
  OCSF_VERSION,
  type OcsfAccount,
  type OcsfCloudResourcesInventoryInfo,
  type OcsfComplianceFinding,
  type OcsfDevice,
  type OcsfDeviceInventoryInfo,
  type OcsfLdapPerson,
  type OcsfMetadata,
  type OcsfOs,
  type OcsfUser,
  type OcsfUserInventoryInfo,
  type OcsfVulnerabilityFinding,
} from "../ocsf/types.auto.ts";
import { VERSION } from "../version.ts";

/** One OCSF event Stolos exports. */
export type OcsfEvent =
  | OcsfUserInventoryInfo
  | OcsfDeviceInventoryInfo
  | OcsfCloudResourcesInventoryInfo
  | OcsfComplianceFinding
  | OcsfVulnerabilityFinding;

/** What every event's metadata names: the product, and the fleet as the tenant. */
export function ocsfMetadata(fleet: string, extra: Partial<OcsfMetadata> = {}): OcsfMetadata {
  return {
    version: OCSF_VERSION,
    product: { name: "Stolos", vendor_name: "Intellectual Frontiers LLC", version: VERSION },
    tenant_uid: fleet,
    ...extra,
  };
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  v === null || v === undefined || v === "" ? undefined : String(v);
const bool = (v: unknown): boolean | undefined =>
  v === null || v === undefined ? undefined : v === true || v === 1 || v === "1" || v === "true";
const ms = (iso: unknown): number | undefined => {
  const s = str(iso);
  const t = s === undefined ? NaN : Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};
/**
 * An ISO date or time as OCSF's timestamp (milliseconds). The `_dt` twins
 * belong to OCSF's datetime profile, which these events do not use.
 */
function at(iso: unknown): { t: number } | undefined {
  const t = ms(iso);
  return t === undefined ? undefined : { t };
}

/** OCSF's operating system type, from its name (0 Unknown when Stolos cannot tell). */
export function osTypeId(name: string): OcsfOs["type_id"] {
  const n = name.toLowerCase();
  if (/windows/.test(n)) return 100;
  if (/android/.test(n)) return 201;
  if (/mac ?os|os x|darwin/.test(n)) return 300;
  if (/ios\b/.test(n)) return 301;
  if (/ubuntu|debian|linux|fedora|red hat|rhel|centos|suse|alpine/.test(n)) return 200;
  return 0;
}

const DEVICE_TYPE: Record<string, { type_id: OcsfDevice["type_id"]; type: string }> = {
  server: { type_id: 1, type: "Server" },
  workstation: { type_id: 99, type: "Workstation" },
  network_device: { type_id: 99, type: "Network Device" },
  other: { type_id: 0, type: "Unknown" },
};

/** OCSF's account type for a connector's tenant (99 Other, named by the connector, otherwise). */
const ACCOUNT_TYPE: Record<string, { type_id: OcsfAccount["type_id"]; type: string }> = {
  aws: { type_id: 10, type: "AWS Account" },
  google: { type_id: 15, type: "Google Workspace" },
  microsoft: { type_id: 17, type: "M365 Tenant" },
};

const rows = (e: Estate, sql: string): Row[] =>
  (e.db.prepare(sql).all() as Row[]).map((r) => ({ ...r }));

const props = (r: Row): Row => {
  try {
    const p: unknown = JSON.parse(String(r.props ?? "{}"));
    return p && typeof p === "object" && !Array.isArray(p) ? { ...p } : {};
  } catch {
    return {};
  }
};

/** What the export needs to know besides the data. */
export interface OcsfOptions {
  /** The fleet's id (metadata.tenant_uid). */
  fleet: string;
  /** The fleet's name, for user.org. */
  fleetTitle?: string;
  /** The time every event is stamped with. */
  now: Date;
}

/** The person's User Inventory Info event. */
function personEvent(p: Row, manager: Row | undefined, o: OcsfOptions): OcsfUserInventoryInfo {
  const hire = at(p.start_date);
  const leave = at(p.end_date);
  const ldap: OcsfLdapPerson = {
    ...(str(p.name) ? { display_name: str(p.name) } : {}),
    ...(str(p.type) ? { labels: [String(p.type)] } : {}),
    ...(hire ? { hire_time: hire.t } : {}),
    ...(leave ? { leave_time: leave.t } : {}),
    ...(manager
      ? {
        manager: {
          uid: String(manager.uid),
          ...(str(manager.email_addr) ? { email_addr: str(manager.email_addr) } : {}),
        },
      }
      : {}),
  };
  const user: OcsfUser = {
    uid: String(p.uid),
    type_id: 1,
    type: "User",
    ...(str(p.name) ? { full_name: str(p.name) } : {}),
    ...(str(p.email_addr) ? { email_addr: str(p.email_addr) } : {}),
    org: { uid: o.fleet, ...(o.fleetTitle ? { name: o.fleetTitle } : {}) },
    ...(Object.keys(ldap).length ? { ldap_person: ldap } : {}),
  };
  return {
    class_uid: 5003,
    category_uid: 5,
    activity_id: 2,
    type_uid: 500302,
    severity_id: 1,
    time: o.now.getTime(),
    metadata: ocsfMetadata(o.fleet, { uid: String(p.uid), labels: ["person"] }),
    user,
    unmapped: { status: String(p.status) },
  };
}

/** An account's User Inventory Info event, tied to its person when it has one. */
function accountEvent(a: Row, person: string | undefined, o: OcsfOptions): OcsfUserInventoryInfo {
  const pr = props(a);
  const connector = String(a.connector);
  const acct = ACCOUNT_TYPE[connector] ?? { type_id: 99 as const, type: connector };
  const account: OcsfAccount = {
    uid: String(a.tenant_uid),
    name: String(a.tenant_name),
    ...acct,
    ...(bool(pr.active) !== undefined ? { is_disabled: !bool(pr.active) } : {}),
  };
  const service = bool(pr.service) === true;
  const admin = bool(pr.admin) === true;
  const login = at(pr.last_login);
  const user: OcsfUser = {
    uid: String(a.node_uid),
    name: String(a.display_name ?? a.native_id),
    type_id: service ? 4 : admin ? 2 : 1,
    type: service ? "Service" : admin ? "Admin" : "User",
    ...(str(pr.email) ? { email_addr: str(pr.email) } : {}),
    ...(bool(pr.mfa) !== undefined ? { has_mfa: bool(pr.mfa) } : {}),
    account,
    ...(login ? { ldap_person: { last_login_time: login.t } } : {}),
  };
  return {
    class_uid: 5003,
    category_uid: 5,
    activity_id: 2,
    type_uid: 500302,
    severity_id: 1,
    time: o.now.getTime(),
    metadata: ocsfMetadata(o.fleet, {
      uid: String(a.node_uid),
      labels: ["user_account", ...(bool(a.stale) ? ["stale"] : [])],
      ...(person ? { correlation_uid: person } : {}),
    }),
    user,
  };
}

/** A machine's Device Inventory Info event. */
function deviceEvent(d: Row, o: OcsfOptions): OcsfDeviceInventoryInfo {
  const t = DEVICE_TYPE[String(d.type)] ?? DEVICE_TYPE.other;
  const os = str(d.os_name);
  const owner = str(d.owner_email_addr);
  const first = at(d.first_seen_time_dt);
  const last = at(d.last_seen_time_dt);
  const device: OcsfDevice = {
    uid: String(d.uid),
    ...t,
    ...(str(d.hostname) ? { hostname: str(d.hostname), name: str(d.hostname) } : {}),
    ...(str(d.model) ? { model: str(d.model) } : {}),
    ...(str(d.serial_number) ? { hw_info: { serial_number: str(d.serial_number) } } : {}),
    ...(os ? { os: { name: os, type_id: osTypeId(os) } } : {}),
    is_managed: bool(d.is_managed) === true,
    ...(owner ? { owner: { uid: `person:${owner}`, email_addr: owner } } : {}),
    ...(first ? { first_seen_time: first.t } : {}),
    ...(last ? { last_seen_time: last.t } : {}),
  };
  const encrypted = bool(d.is_encrypted);
  return {
    class_uid: 5001,
    category_uid: 5,
    activity_id: 2,
    type_uid: 500102,
    severity_id: 1,
    time: o.now.getTime(),
    metadata: ocsfMetadata(o.fleet, { uid: String(d.uid), labels: ["fixed_asset"] }),
    device,
    ...(encrypted !== undefined ? { unmapped: { is_encrypted: encrypted } } : {}),
  };
}

/** Any other node's Cloud Resources Inventory Info event. */
function resourceEvent(n: Row, labels: string[], o: OcsfOptions): OcsfCloudResourcesInventoryInfo {
  return {
    class_uid: 5023,
    category_uid: 5,
    activity_id: 2,
    type_uid: 502302,
    severity_id: 1,
    time: o.now.getTime(),
    metadata: ocsfMetadata(o.fleet, {
      uid: String(n.node_uid),
      labels: [String(n.label), ...(bool(n.stale) ? ["stale"] : [])],
    }),
    resources: [{
      uid: String(n.node_uid),
      name: String(n.display_name ?? n.native_id),
      type: String(n.label),
      labels,
      namespace: String(n.tenant_uid),
      tags: [{ name: "connector", value: String(n.connector) }],
      data: props(n),
    }],
  };
}

const SEVERITY_ID: Record<string, OcsfVulnerabilityFinding["severity_id"]> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};
const SEVERITY_NAME = ["Unknown", "Informational", "Low", "Medium", "High", "Critical"];
const STATUS_ID: Record<string, OcsfVulnerabilityFinding["status_id"]> = {
  open: 1,
  dismissed: 3,
  fixed: 4,
};

/** Spec 088: a scanner's vulnerability record as an OCSF Vulnerability Finding. */
function vulnerabilityEvent(n: Row, o: OcsfOptions): OcsfVulnerabilityFinding {
  const p = props(n);
  const severity_id = SEVERITY_ID[String(p.severity)] ?? 0;
  const status_id = STATUS_ID[String(p.status)] ?? 0;
  const first = at(p.first_seen);
  const cve = str(p.cve);
  const title = str(p.title) ?? String(n.display_name ?? n.native_id);
  const asset = str(p.asset);
  // "name@version" (an npm package's name may start with @).
  const at2 = String(p.package ?? "").lastIndexOf("@");
  const pkg = at2 > 0
    ? { name: String(p.package).slice(0, at2), version: String(p.package).slice(at2 + 1) }
    : undefined;
  return {
    class_uid: 2002,
    category_uid: 2,
    activity_id: 1,
    type_uid: 200201,
    severity_id,
    severity: SEVERITY_NAME[severity_id],
    status_id,
    time: o.now.getTime(),
    metadata: ocsfMetadata(o.fleet, {
      uid: String(n.node_uid),
      labels: [String(n.label), ...(bool(n.stale) ? ["stale"] : [])],
    }),
    finding_info: {
      uid: String(n.node_uid),
      title,
      data_sources: [String(n.connector)],
      ...(first ? { first_seen_time: first.t } : {}),
      ...(str(p.src_url) ? { src_url: str(p.src_url) } : {}),
    },
    vulnerabilities: [{
      title,
      severity: SEVERITY_NAME[severity_id],
      // OCSF needs a CVE, a CWE, or an advisory: without a CVE, the scanner's own finding.
      ...(cve ? { cve: { uid: cve } } : { advisory: { uid: String(n.native_id), title } }),
      ...(bool(p.fix_available) !== undefined ? { is_fix_available: bool(p.fix_available) } : {}),
      ...(pkg ? { affected_packages: [pkg] } : {}),
      ...(first ? { first_seen_time: first.t } : {}),
    }],
    ...(asset ? { resources: [{ uid: asset, name: asset }] } : {}),
  };
}

/**
 * The estate as OCSF inventory events, in a stable order: each person and
 * then their accounts, the accounts of no one, the machines, then every
 * other node.
 */
export function estateEvents(e: Estate, o: OcsfOptions): OcsfEvent[] {
  const out: OcsfEvent[] = [];
  const people = rows(e, "SELECT * FROM user_inventory ORDER BY uid");
  const byUid = new Map(people.map((p) => [String(p.uid), p]));
  const managers = new Map(
    rows(
      e,
      "SELECT from_party_uid, to_party_uid FROM party_relationship WHERE party_relationship_type = 'reports_to'",
    ).map((r) => [String(r.from_party_uid), String(r.to_party_uid)]),
  );
  const accounts = rows(
    e,
    `SELECT n.*, t.connector, t.name AS tenant_name,
       (SELECT x.src_uid FROM edge x WHERE x.dst_uid = n.node_uid AND x.verb = 'has_account'
        ORDER BY x.src_uid LIMIT 1) AS person_uid
     FROM node n JOIN tenant t ON t.tenant_uid = n.tenant_uid
     WHERE n.ocsf_class_uid = 5003 ORDER BY n.node_uid`,
  );
  for (const p of people) {
    const m = managers.get(String(p.uid));
    out.push(personEvent(p, m ? byUid.get(m) ?? { uid: m } : undefined, o));
    for (const a of accounts.filter((x) => x.person_uid === p.uid)) {
      out.push(accountEvent(a, String(p.uid), o));
    }
  }
  for (const a of accounts.filter((x) => !x.person_uid || !byUid.has(String(x.person_uid)))) {
    out.push(accountEvent(a, undefined, o));
  }
  for (const d of rows(e, "SELECT * FROM device ORDER BY uid")) out.push(deviceEvent(d, o));
  const labels = new Map<string, string[]>();
  for (const l of rows(e, "SELECT node_uid, label FROM node_label ORDER BY node_uid, label")) {
    labels.set(String(l.node_uid), [...(labels.get(String(l.node_uid)) ?? []), String(l.label)]);
  }
  for (
    const n of rows(
      e,
      `SELECT n.*, t.connector FROM node n JOIN tenant t ON t.tenant_uid = n.tenant_uid
       WHERE coalesce(n.ocsf_class_uid, 0) <> 5003 ORDER BY n.node_uid`,
    )
  ) {
    if (Number(n.ocsf_class_uid) === 2002) out.push(vulnerabilityEvent(n, o));
    else out.push(resourceEvent(n, labels.get(String(n.node_uid)) ?? [String(n.label)], o));
  }
  return out;
}

/** The compliance view as OCSF Compliance Findings: one per piece of evidence and SCF control. */
export function complianceEvents(
  view: ComplianceView,
  o: OcsfOptions & { catalog?: ScfCatalog },
): OcsfComplianceFinding[] {
  return allEvidence(view).flatMap((e) =>
    complianceFindings(e, {
      now: o.now,
      fleet: o.fleet,
      ...(o.catalog ? { catalog: o.catalog } : {}),
    })
  );
}

/** Events as JSON Lines: one object per line, each line ending in a newline. */
export function toJsonl(events: readonly unknown[]): string {
  return events.map((x) => JSON.stringify(x) + "\n").join("");
}
