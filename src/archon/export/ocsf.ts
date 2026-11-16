/**
 * Spec 092: the estate and the compliance view as OCSF 1.9.0 events, one
 * JSON object per line (JSON Lines), for a SIEM or a data lake to read
 * without a parser of its own. Every event is written by IFC TypeScript's
 * kernel (`ocsf`), typed by its OCSF 1.9.0 types, so a missing required
 * attribute does not compile; the mapping from the estate's rows is Stolos's.
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
// Spec: 088-wave3-registry
// Spec: 092-exporters

import { grc, ocsf } from "@intellectual-frontiers/commons/ts/kernel";
import type { ScfCatalog } from "../compliance/catalog.ts";
import { instantOfDate } from "../compliance/findings.ts";
import { allEvidence } from "../compliance/oscal.ts";
import type { ComplianceView } from "../compliance/report.ts";
import type { Estate } from "../estate/graph.ts";
import { complianceFindings, OCSF_PRODUCT } from "../ocsf/finding.ts";

/** One OCSF event Stolos exports (the kernel's: inventories and findings). */
export type OcsfEvent = ocsf.OcsfEvent;

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string"
    ? v === ""
      ? undefined
      : v
    : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
      ? String(v)
      : undefined;
/** A column as text ("" where it is empty or not a scalar). */
const text = (v: unknown): string => str(v) ?? "";
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
export function osTypeId(name: string): ocsf.OcsfOs["type_id"] {
  const n = name.toLowerCase();
  if (/windows/.test(n)) return 100;
  if (/android/.test(n)) return 201;
  if (/mac ?os|os x|darwin/.test(n)) return 300;
  if (/ios\b/.test(n)) return 301;
  if (/ubuntu|debian|linux|fedora|red hat|rhel|centos|suse|alpine/.test(n)) return 200;
  return 0;
}

type DeviceType = { type_id: ocsf.OcsfDevice["type_id"]; type: string };
const UNKNOWN_DEVICE: DeviceType = { type_id: 0, type: "Unknown" };
const DEVICE_TYPE: Record<string, DeviceType> = {
  server: { type_id: 1, type: "Server" },
  workstation: { type_id: 99, type: "Workstation" },
  network_device: { type_id: 99, type: "Network Device" },
  other: UNKNOWN_DEVICE,
};

/** OCSF's account type for a connector's tenant (99 Other, named by the connector, otherwise). */
const ACCOUNT_TYPE: Record<
  string,
  { type_id: Exclude<ocsf.OcsfAccount["type_id"], undefined>; type: string }
> = {
  aws: { type_id: 10, type: "AWS Account" },
  google: { type_id: 15, type: "Google Workspace" },
  microsoft: { type_id: 17, type: "M365 Tenant" },
};

const rows = (e: Estate, sql: string): Row[] =>
  (e.db.prepare(sql).all() as Row[]).map((r) => ({ ...r }));

const props = (r: Row): Row => {
  try {
    const p: unknown = JSON.parse(str(r["props"]) ?? "{}");
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

/** The kernel's inventory options: Stolos, the time, the fleet as the tenant, and more metadata. */
function inventory(
  o: OcsfOptions,
  metadata: ocsf.MetadataExtra,
  unmapped?: ocsf.OcsfOpenObject,
): ocsf.InventoryOptions {
  return {
    product: OCSF_PRODUCT,
    at: instantOfDate(o.now),
    metadata: { tenant_uid: o.fleet, ...metadata },
    ...(unmapped === undefined ? {} : { unmapped }),
  };
}

/** The person's User Inventory Info event. */
function personEvent(p: Row, manager: Row | undefined, o: OcsfOptions): ocsf.UserInventoryEvent {
  const hire = at(p["start_date"]);
  const leave = at(p["end_date"]);
  const name = str(p["name"]);
  const type = str(p["type"]);
  const email = str(p["email_addr"]);
  const managerEmail = manager === undefined ? undefined : str(manager["email_addr"]);
  const ldap: ocsf.OcsfLdapPerson = {
    ...(name === undefined ? {} : { display_name: name }),
    ...(type === undefined ? {} : { labels: [type] }),
    ...(hire ? { hire_time: hire.t } : {}),
    ...(leave ? { leave_time: leave.t } : {}),
    ...(manager
      ? {
          manager: {
            uid: text(manager["uid"]),
            ...(managerEmail === undefined ? {} : { email_addr: managerEmail }),
          },
        }
      : {}),
  };
  const user: ocsf.OcsfUser = {
    uid: text(p["uid"]),
    type_id: 1,
    type: "User",
    ...(name === undefined ? {} : { full_name: name }),
    ...(email === undefined ? {} : { email_addr: email }),
    org: { uid: o.fleet, ...(o.fleetTitle ? { name: o.fleetTitle } : {}) },
    ...(Object.keys(ldap).length ? { ldap_person: ldap } : {}),
  };
  return ocsf.userInventoryInfo(
    user,
    inventory(o, { uid: text(p["uid"]), labels: ["person"] }, { status: text(p["status"]) }),
  );
}

/** An account's User Inventory Info event, tied to its person when it has one. */
function accountEvent(a: Row, person: string | undefined, o: OcsfOptions): ocsf.UserInventoryEvent {
  const pr = props(a);
  const connector = text(a["connector"]);
  const acct = ACCOUNT_TYPE[connector] ?? { type_id: 99 as const, type: connector };
  const active = bool(pr["active"]);
  const account: ocsf.OcsfAccount = {
    uid: text(a["tenant_uid"]),
    name: text(a["tenant_name"]),
    ...acct,
    ...(active === undefined ? {} : { is_disabled: !active }),
  };
  const service = bool(pr["service"]) === true;
  const admin = bool(pr["admin"]) === true;
  const login = at(pr["last_login"]);
  const email = str(pr["email"]);
  const mfa = bool(pr["mfa"]);
  const user: ocsf.OcsfUser = {
    uid: text(a["node_uid"]),
    name: text(a["display_name"] ?? a["native_id"]),
    type_id: service ? 4 : admin ? 2 : 1,
    type: service ? "Service" : admin ? "Admin" : "User",
    ...(email === undefined ? {} : { email_addr: email }),
    ...(mfa === undefined ? {} : { has_mfa: mfa }),
    account,
    ...(login ? { ldap_person: { last_login_time: login.t } } : {}),
  };
  return ocsf.userInventoryInfo(
    user,
    inventory(o, {
      uid: text(a["node_uid"]),
      labels: ["user_account", ...(bool(a["stale"]) ? ["stale"] : [])],
      ...(person ? { correlation_uid: person } : {}),
    }),
  );
}

/** A machine's Device Inventory Info event. */
function deviceEvent(d: Row, o: OcsfOptions): ocsf.DeviceInventoryEvent {
  const t = DEVICE_TYPE[text(d["type"])] ?? UNKNOWN_DEVICE;
  const os = str(d["os_name"]);
  const owner = str(d["owner_email_addr"]);
  const hostname = str(d["hostname"]);
  const model = str(d["model"]);
  const serial = str(d["serial_number"]);
  const first = at(d["first_seen_time_dt"]);
  const last = at(d["last_seen_time_dt"]);
  const device: ocsf.OcsfDevice = {
    uid: text(d["uid"]),
    ...t,
    ...(hostname === undefined ? {} : { hostname, name: hostname }),
    ...(model === undefined ? {} : { model }),
    ...(serial === undefined ? {} : { hw_info: { serial_number: serial } }),
    ...(os === undefined ? {} : { os: { name: os, type_id: osTypeId(os) } }),
    is_managed: bool(d["is_managed"]) === true,
    ...(owner === undefined ? {} : { owner: { uid: `person:${owner}`, email_addr: owner } }),
    ...(first ? { first_seen_time: first.t } : {}),
    ...(last ? { last_seen_time: last.t } : {}),
  };
  const encrypted = bool(d["is_encrypted"]);
  return ocsf.deviceInventoryInfo(
    device,
    inventory(
      o,
      { uid: text(d["uid"]), labels: ["fixed_asset"] },
      encrypted === undefined ? undefined : { is_encrypted: encrypted },
    ),
  );
}

/** Any other node's Cloud Resources Inventory Info event. */
function resourceEvent(
  n: Row,
  labels: string[],
  o: OcsfOptions,
): ocsf.CloudResourcesInventoryEvent {
  return ocsf.cloudResourcesInventoryInfo(
    [
      {
        uid: text(n["node_uid"]),
        name: text(n["display_name"] ?? n["native_id"]),
        type: text(n["label"]),
        labels,
        namespace: text(n["tenant_uid"]),
        tags: [{ name: "connector", value: text(n["connector"]) }],
        data: props(n),
      },
    ],
    inventory(o, {
      uid: text(n["node_uid"]),
      labels: [text(n["label"]), ...(bool(n["stale"]) ? ["stale"] : [])],
    }),
  );
}

const isSeverity = (s: string): s is grc.Severity =>
  (grc.SEVERITIES as readonly string[]).includes(s);
const STATUS: Record<string, ocsf.VulnerabilityStatus> = {
  open: "new",
  dismissed: "suppressed",
  fixed: "resolved",
};

/** Spec 088: a scanner's vulnerability record as an OCSF Vulnerability Finding. */
function vulnerabilityEvent(n: Row, o: OcsfOptions): ocsf.VulnerabilityFindingEvent {
  const p = props(n);
  const severity = text(p["severity"]);
  const status = STATUS[text(p["status"])];
  const first = at(p["first_seen"]);
  const cve = str(p["cve"]);
  const title = str(p["title"]) ?? text(n["display_name"] ?? n["native_id"]);
  const asset = str(p["asset"]);
  const src = str(p["src_url"]);
  const fix = bool(p["fix_available"]);
  // "name@version" (an npm package's name may start with @).
  const spec = text(p["package"]);
  const split = spec.lastIndexOf("@");
  const pkg =
    split > 0 ? { name: spec.slice(0, split), version: spec.slice(split + 1) } : undefined;
  const caption = isSeverity(severity) ? ocsf.OCSF_SEVERITY[severity].caption : "Unknown";
  return ocsf.vulnerabilityFinding(
    {
      uid: text(n["node_uid"]),
      title,
      ...(isSeverity(severity) ? { severity } : {}),
      ...(status === undefined ? {} : { status }),
      vulnerabilities: [
        {
          title,
          severity: caption,
          // OCSF needs a CVE, a CWE, or an advisory: without a CVE, the scanner's own finding.
          ...(cve ? { cve: { uid: cve } } : { advisory: { uid: text(n["native_id"]), title } }),
          ...(fix === undefined ? {} : { is_fix_available: fix }),
          ...(pkg ? { affected_packages: [pkg] } : {}),
          ...(first ? { first_seen_time: first.t } : {}),
        },
      ],
      ...(asset ? { resources: [{ uid: asset, name: asset }] } : {}),
      findingInfo: {
        data_sources: [text(n["connector"])],
        ...(first ? { first_seen_time: first.t } : {}),
        ...(src === undefined ? {} : { src_url: src }),
      },
    },
    {
      product: OCSF_PRODUCT,
      at: instantOfDate(o.now),
      metadata: {
        tenant_uid: o.fleet,
        uid: text(n["node_uid"]),
        labels: [text(n["label"]), ...(bool(n["stale"]) ? ["stale"] : [])],
      },
    },
  );
}

/**
 * The estate as OCSF inventory events, in a stable order: each person and
 * then their accounts, the accounts of no one, the machines, then every
 * other node.
 */
export function estateEvents(e: Estate, o: OcsfOptions): OcsfEvent[] {
  const out: OcsfEvent[] = [];
  const people = rows(e, "SELECT * FROM user_inventory ORDER BY uid");
  const byUid = new Map(people.map((p) => [text(p["uid"]), p]));
  const managers = new Map(
    rows(
      e,
      "SELECT from_party_uid, to_party_uid FROM party_relationship WHERE party_relationship_type = 'reports_to'",
    ).map((r) => [text(r["from_party_uid"]), text(r["to_party_uid"])]),
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
    const m = managers.get(text(p["uid"]));
    out.push(personEvent(p, m ? (byUid.get(m) ?? { uid: m }) : undefined, o));
    for (const a of accounts.filter((x) => x["person_uid"] === p["uid"])) {
      out.push(accountEvent(a, text(p["uid"]), o));
    }
  }
  for (const a of accounts.filter((x) => !x["person_uid"] || !byUid.has(text(x["person_uid"])))) {
    out.push(accountEvent(a, undefined, o));
  }
  for (const d of rows(e, "SELECT * FROM device ORDER BY uid")) out.push(deviceEvent(d, o));
  const labels = new Map<string, string[]>();
  for (const l of rows(e, "SELECT node_uid, label FROM node_label ORDER BY node_uid, label")) {
    const k = text(l["node_uid"]);
    labels.set(k, [...(labels.get(k) ?? []), text(l["label"])]);
  }
  for (const n of rows(
    e,
    `SELECT n.*, t.connector FROM node n JOIN tenant t ON t.tenant_uid = n.tenant_uid
       WHERE coalesce(n.ocsf_class_uid, 0) <> 5003 ORDER BY n.node_uid`,
  )) {
    if (Number(n["ocsf_class_uid"]) === 2002) out.push(vulnerabilityEvent(n, o));
    else {
      out.push(resourceEvent(n, labels.get(text(n["node_uid"])) ?? [text(n["label"])], o));
    }
  }
  return out;
}

/** The compliance view as OCSF Compliance Findings: one per piece of evidence and SCF control. */
export function complianceEvents(
  view: ComplianceView,
  o: OcsfOptions & { catalog?: ScfCatalog },
): ocsf.ComplianceFindingEvent[] {
  return allEvidence(view).flatMap((e) =>
    complianceFindings(e, {
      now: o.now,
      fleet: o.fleet,
      ...(o.catalog ? { catalog: o.catalog } : {}),
    }),
  );
}

/** Events as JSON Lines: one object per line, each line ending in a newline. */
export function toJsonl(events: readonly unknown[]): string {
  return events.map((x) => JSON.stringify(x) + "\n").join("");
}
