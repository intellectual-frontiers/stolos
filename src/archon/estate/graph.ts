/**
 * Spec 090: the estate graph, built from a {@link Snapshot} into SQLite
 * (node:sqlite, the same on Bun and Node) with the schema in `schema.ts`.
 *
 * - **People** come only from the source of truth: the first connected
 *   source in fleet.ts's order (HR systems, then identity providers). Every
 *   other source links to them.
 * - **Accounts** and **repositories** are nodes, labeled `user_account` and
 *   `code_repository`. An account is linked to its person (`has_account`) by
 *   work email, or by a manual link in links.ts.
 * - **Machines** are fixed assets, deduplicated by serial number, then
 *   hostname (links.ts overrides); a device with no serial number (an EDR's)
 *   joins the machine with its hostname. Each property records the source it
 *   came from (Stolos's own, then the probe, then MDMs, then EDRs: `SOURCE_RANK`),
 *   and each source's record is linked by `observed_as`.
 * - **History**: first-seen and last-seen times come from Git. When a source
 *   could not read something (an observation), its earlier nodes are kept,
 *   marked stale, rather than dropped.
 *
 * ```mermaid
 * flowchart LR
 *   snap["Snapshot (Git, now or at a commit)"] --> build["buildGraph"]
 *   build --> db[("estate graph (SQLite)")]
 *   db --> policies["estatePolicies: findings (SCF), controls on the SDK (spec 078)"] & query["estate query"] & sql["estate.sql + estate.auto.sqlite.db"]
 * ```
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Observation } from "../connect/connector.ts";
import { defineControl, type EstateControl, type Row } from "../controls/define.ts";
import { runEstate } from "../controls/core.ts";
import { type Account, type Device, emailKey, type Repository } from "../connect/entities.ts";
import {
  type Column,
  ordered,
  rowParams,
  type RowOf,
  type TableDef,
  upsertSql,
} from "../schema/define.ts";
import {
  codeRepository,
  contactMechanism,
  edge,
  ESTATE_SCHEMA,
  estateSchemaSql,
  finding,
  fixedAsset,
  node,
  nodeLabel,
  nodePropertyProvenance,
  observation,
  organization,
  party,
  partyContactMechanism,
  partyFixedAssetAssignment,
  partyRelationship,
  partyRole,
  person,
  tenant,
  userAccount,
} from "./schema.ts";
import type { SeenTimes, Snapshot } from "./snapshot.ts";

/** The default source-of-truth order for people: HR systems, then identity providers. */
export const PERSON_SOURCES = [
  "bamboohr",
  "rippling",
  "gusto",
  "deel",
  "justworks",
  "okta",
  "jumpcloud",
  "microsoft",
  "google",
];

/** Spec 087: the password managers; every active person should have an account in one. */
export const PASSWORD_MANAGERS = ["onepassword", "bitwarden"];
const PM_LIST = PASSWORD_MANAGERS.map((c) => `'${c}'`).join(", ");

/** The estate graph. */
export interface Estate {
  /** The database. */
  db: DatabaseSync;
  /** The connector people came from (undefined: none is connected). */
  personSource?: string;
}

/** A tenant's uid. */
export const tenantUid = (connector: string, account: string): string => `${connector}:${account}`;

/** The uids of an observation's nodes (accounts, repositories, and declared records). */
export function nodeUids(connector: string, o: Observation): string[] {
  const t = tenantUid(connector, o.account);
  return [
    ...(o.entities?.accounts ?? []).map((a) => `${t}:${a.id}`),
    ...(o.entities?.repositories ?? []).map((r) => `${t}:${r.name}`),
    ...(o.records ?? []).map((r) => `${t}:${r.native_id}`),
  ];
}

const accountProps = (a: Account) => ({
  ...(emailKey(a.email) ? { email: emailKey(a.email) } : {}),
  active: a.active,
  ...(a.admin !== undefined ? { admin: a.admin } : {}),
  ...(a.mfa !== undefined ? { mfa: a.mfa } : {}),
  ...(a.lastLogin ? { last_login: a.lastLogin } : {}),
  ...(a.service ? { service: true } : {}),
});

const repoProps = (r: Repository) => ({
  private: r.private,
  ...(r.protected !== undefined ? { protected: r.protected } : {}),
  ...(r.reviews !== undefined ? { reviews: r.reviews } : {}),
  ...(r.secretScanning !== undefined ? { secret_scanning: r.secretScanning } : {}),
  ...(r.dependencyAlerts !== undefined ? { dependency_alerts: r.dependencyAlerts } : {}),
});

/** A machine's short hostname: lowercase, without its domain. */
const shortName = (name: string): string => name.trim().toLowerCase().split(".")[0] ?? "";

/**
 * A machine's key: links.ts first, then its serial number, then its
 * hostname. A device with no serial number (an EDR that does not report
 * one) joins the machine another source knows by the same hostname and a
 * serial number, when `serialByHostname` names exactly one.
 */
export function fixedAssetKey(
  d: Device,
  links: Record<string, string>,
  serialByHostname?: Map<string, string | null>,
): string {
  const manual = links[`device:${d.source}:${d.id}`];
  if (manual) return manual;
  if (d.serial) return `serial:${d.serial.trim().toUpperCase()}`;
  const host = shortName(d.name);
  return serialByHostname?.get(host) ?? `hostname:${host}`;
}

/**
 * Each hostname's serial-number key, from the devices that report both; null
 * when two machines share a hostname (a default name like "macbook-pro"),
 * so a device with only that hostname is not joined to either.
 */
export function serialKeysByHostname(devices: Device[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const d of devices) {
    if (!d.serial?.trim()) continue;
    const host = shortName(d.name);
    const key = `serial:${d.serial.trim().toUpperCase()}`;
    out.set(host, out.has(host) && out.get(host) !== key ? null : key);
  }
  return out;
}

/**
 * Whose word wins for a machine's property when sources disagree (lower
 * first): Stolos's own managed hosts, then its probe (adopted machines), then
 * SNMP, then MDMs and directories (they enforce encryption and know the
 * owner), then EDRs. A source not listed comes last.
 */
export const SOURCE_RANK: Record<string, number> = {
  stolos: 0,
  adopted: 1,
  snmp: 2,
  intune: 3,
  jamf: 3,
  kandji: 3,
  jumpcloud: 4,
  defender: 5,
  crowdstrike: 5,
  sentinelone: 5,
};

/** Build the graph. */
export function buildGraph(
  s: Snapshot,
  o: {
    now?: Date;
    fleetTitle?: string;
    personSources?: string[];
    seen?: SeenTimes;
    /** The previous snapshot's sources, for nodes a source could not read this time. */
    previous?: Snapshot;
  } = {},
): Estate {
  const now = (o.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const db = new DatabaseSync(":memory:");
  db.exec(estateSchemaSql());
  // A row is written as its table declares it; the graph's rows are made for their tables.
  const put = (t: TableDef, row: Record<string, unknown>): void => {
    db.prepare(upsertSql(t)).run(...rowParams(t, row as RowOf<Record<string, Column>>));
  };
  const seenOf = (uid: string, at: string) => o.seen?.get(uid) ?? { first: at, last: at };

  // The fleet itself: an organization, and a tenant for its own machines.
  const org = `organization:${s.fleet}`;
  put(party, { party_uid: org, party_type: "organization" });
  put(organization, { party_uid: org, name: o.fleetTitle ?? s.fleet });
  const fleetTenant = tenantUid("fleet", s.fleet);
  put(tenant, {
    tenant_uid: fleetTenant,
    connector: "fleet",
    name: o.fleetTitle ?? s.fleet,
    observed_at: now,
  });

  // People, from the source of truth only.
  const order = o.personSources ?? PERSON_SOURCES;
  const personSource = order.find((c) => s.sources.some((x) => x.connector === c));
  const parties = new Map<string, string>(); // email -> party uid
  const addPerson = (
    email: string,
    p: {
      name?: string;
      status: string;
      start?: string;
      end?: string;
      type?: string;
      manager?: string;
    },
    source: string,
  ) => {
    const uid = `person:${email}`;
    parties.set(email, uid);
    put(party, { party_uid: uid, party_type: "person" });
    put(person, {
      party_uid: uid,
      name: p.name ?? null,
      status: p.status,
      start_date: p.start ?? null,
      end_date: p.end ?? null,
      source,
    });
    put(contactMechanism, {
      contact_mechanism_uid: `email:${email}`,
      contact_mechanism_type: "electronic_address",
      address: email,
    });
    put(partyContactMechanism, {
      party_uid: uid,
      contact_mechanism_uid: `email:${email}`,
      contact_purpose: "work_email",
    });
    if (p.type) {
      put(partyRole, {
        party_uid: uid,
        role_type: p.type,
        from_date: p.start ?? null,
        thru_date: p.end ?? null,
        source,
      });
    }
    return uid;
  };
  const managers: Array<[string, string, string]> = [];
  for (const src of s.sources.filter((x) => x.connector === personSource)) {
    for (const p of src.observation.entities?.people ?? []) {
      const email = emailKey(p.email);
      if (!email) continue;
      addPerson(email, p, src.connector);
      const m = emailKey(p.manager);
      if (m) managers.push([email, m, src.connector]);
    }
    // An identity provider as the source of truth: its people are its accounts.
    if (!(src.observation.entities?.people ?? []).length) {
      for (const a of src.observation.entities?.accounts ?? []) {
        const email = emailKey(a.email);
        if (!email || a.service || parties.has(email)) continue;
        addPerson(email, { name: a.name, status: a.active ? "active" : "unknown" }, src.connector);
      }
    }
  }
  for (const [email, m, source] of managers) {
    put(partyRelationship, {
      from_party_uid: `person:${email}`,
      to_party_uid: `person:${m}`,
      party_relationship_type: "reports_to",
      source,
    });
  }

  // Each source's tenant, nodes, gaps, and links to people.
  const linkAccount = (
    uid: string,
    a: { email?: string; name: string },
    connector: string,
    at: string,
  ) => {
    const manual = emailKey(s.links[`${connector}:${a.name}`]);
    const email = emailKey(a.email) ?? manual;
    const who = email && parties.get(email);
    if (!who) return;
    const t = seenOf(`${who}>${uid}`, at);
    put(edge, {
      src_uid: who,
      verb: "has_account",
      dst_uid: uid,
      source: connector,
      basis: emailKey(a.email) ? "email" : "manual",
      ...(emailKey(a.email)
        ? {}
        : { asserted_by: "links.ts", reason: `links.ts: ${connector}:${a.name}` }),
      first_seen: t.first,
      last_seen: t.last,
    });
  };
  const addNode = (
    uid: string,
    t: string,
    label: string,
    nativeId: string,
    name: string,
    ocsf: number,
    props: Record<string, unknown>,
    at: string,
    stale: boolean,
  ) => {
    const seen = seenOf(uid, at);
    put(node, {
      node_uid: uid,
      label,
      tenant_uid: t,
      native_id: nativeId,
      display_name: name,
      ocsf_class_uid: ocsf,
      first_seen: seen.first,
      last_seen: seen.last,
      stale,
      props,
    });
    put(nodeLabel, { node_uid: uid, label, kind: "standard" });
  };
  for (const src of s.sources) {
    const ob = src.observation;
    const t = tenantUid(src.connector, ob.account);
    put(tenant, {
      tenant_uid: t,
      connector: src.connector,
      name: ob.account,
      observed_at: ob.at,
      commit_sha: src.commit ?? null,
    });
    for (const g of ob.gaps) {
      const [resource, ...why] = g.split(": ");
      put(observation, {
        tenant_uid: t,
        resource: why.length ? resource : g,
        reason: why.length ? why.join(": ") : "not readable",
        observed_at: ob.at,
      });
    }
    const emit = (x: Observation, stale: boolean) => {
      for (const a of x.entities?.accounts ?? []) {
        const uid = `${t}:${a.id}`;
        addNode(uid, t, userAccount.name, a.id, a.name, 5003, accountProps(a), x.at, stale);
        linkAccount(uid, a, src.connector, x.at);
      }
      for (const r of x.entities?.repositories ?? []) {
        addNode(
          `${t}:${r.name}`,
          t,
          codeRepository.name,
          r.name,
          r.name,
          5023,
          repoProps(r),
          x.at,
          stale,
        );
      }
      for (const r of x.records ?? []) {
        const uid = `${t}:${r.native_id}`;
        addNode(
          uid,
          t,
          r.label,
          r.native_id,
          r.display_name,
          r.ocsf_class_uid,
          r.props,
          x.at,
          stale,
        );
        if (r.label === userAccount.name) {
          linkAccount(
            uid,
            {
              ...(typeof r.props["email"] === "string" ? { email: r.props["email"] } : {}),
              name: r.display_name,
            },
            src.connector,
            x.at,
          );
        }
      }
    };
    // What the previous observation had and this one could not read is kept, marked stale.
    const prev = o.previous?.sources.find((p) => p.connector === src.connector)?.observation;
    if (prev && ob.gaps.length) {
      const current = new Set(nodeUids(src.connector, ob));
      emit(
        {
          ...prev,
          entities: {
            accounts: (prev.entities?.accounts ?? []).filter((a) => !current.has(`${t}:${a.id}`)),
            repositories: (prev.entities?.repositories ?? []).filter(
              (r) => !current.has(`${t}:${r.name}`),
            ),
          },
          records: (prev.records ?? []).filter((r) => !current.has(`${t}:${r.native_id}`)),
        },
        true,
      );
    }
    emit(ob, false);
  }

  // Machines: the fleet's own and every source's devices, deduplicated.
  const devices: Device[] = [
    ...s.machines,
    ...s.sources.flatMap((x) => x.observation.entities?.devices ?? []),
  ].sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
  const assets = new Map<string, Record<string, unknown>>();
  const assignments: Array<Record<string, unknown>> = [];
  const byHostname = serialKeysByHostname(devices);
  for (const d of devices) {
    const key = fixedAssetKey(d, s.links, byHostname);
    const a = assets.get(key) ?? { fixed_asset_uid: key, managed: false };
    const set = (prop: string, v: unknown) => {
      if (v === undefined || v === null || v === "" || a[prop] !== undefined) return;
      a[prop] = v;
      put(nodePropertyProvenance, { node_uid: key, property: prop, source: d.source });
    };
    set("hostname", shortName(d.name));
    set("serial_number", d.serial);
    set("os_name", d.os);
    set("encrypted", d.encrypted);
    if (d.managed) a["managed"] = true;
    a["fixed_asset_type"] ??=
      d.source === "snmp"
        ? "network_device"
        : d.source === "stolos"
          ? "server"
          : d.source === "adopted"
            ? "workstation"
            : "other";
    const seen = d.seen ?? now;
    a["first_seen"] = [a["first_seen"] as string | undefined, seenOf(key, seen).first]
      .filter(Boolean)
      .sort()[0];
    a["last_seen"] = [a["last_seen"] as string | undefined, seen].filter(Boolean).sort().pop();
    assets.set(key, a);
    const t = seenOf(`${key}>${d.source}:${d.id}`, seen);
    put(edge, {
      src_uid: key,
      verb: "observed_as",
      dst_uid: `${d.source}:${d.id}`,
      source: d.source,
      basis: s.links[`device:${d.source}:${d.id}`] ? "manual" : d.serial ? "serial" : "hostname",
      ...(s.links[`device:${d.source}:${d.id}`]
        ? { asserted_by: "links.ts", reason: `links.ts: device:${d.source}:${d.id}` }
        : {}),
      first_seen: t.first,
      last_seen: t.last,
    });
    const owner = emailKey(d.owner);
    if (owner && parties.has(owner)) {
      assignments.push({
        party_uid: parties.get(owner) ?? owner,
        fixed_asset_uid: key,
        source: d.source,
      });
    }
  }
  for (const a of assets.values()) put(fixedAsset, a);
  for (const a of assignments) put(partyFixedAssetAssignment, a);
  return { db, ...(personSource ? { personSource } : {}) };
}

/** Why this SQL may not run on the estate, or undefined: one statement, reading only. */
export function estateRefusal(sql: string): string | undefined {
  const s = sql.trim().replace(/;\s*$/, "");
  if (!s) return "no query";
  if (s.includes(";")) return "one statement only";
  if (!/^(select|with)\b/i.test(s)) return "only SELECT (or WITH ... SELECT)";
  if (
    /\b(attach|detach|pragma|insert|update|delete|create|drop|alter|replace|vacuum|load_extension)\b/i.test(
      s,
    )
  ) {
    return "only reading";
  }
  return undefined;
}

/** Run one SELECT on the estate (rows as plain objects). */
export function estateQuery(e: Estate, sql: string): Array<Record<string, unknown>> {
  const why = estateRefusal(sql);
  if (why) throw new Error(`refused: ${why}`);
  return (
    e.db.prepare(sql.trim().replace(/;\s*$/, "")).all() as Array<Record<string, unknown>>
  ).map((r) => ({ ...r }));
}

/** The tables and views a query may read, for messages. */
export const ESTATE_NAMES: string = ESTATE_SCHEMA.map((d) => d.name).join(", ");

/** A cell's value as text: a string as it is, a number or a boolean written, anything else as JSON. */
const cell = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "bigint" || typeof v === "boolean"
      ? String(v)
      : v === null || v === undefined
        ? ""
        : JSON.stringify(v);

const list = (r: Row[], f: (x: Row) => string): string =>
  r.slice(0, 12).map(f).join(", ") + (r.length > 12 ? `, and ${r.length - 12} more` : "");
const n = (r: Row[]) => Number(r[0]?.["n"] ?? 0);
const uids = (r: Row[]) => r.map((x) => x["uid"] as string);

/** The cross-system policies, as controls over the graph (spec 078), in the order results are shown. */
export const ESTATE_CONTROLS: EstateControl[] = [
  defineControl({
    id: "leavers",
    title: "People who left have no active accounts",
    scf: ["IAC-04"],
    subject: "estate",
    query: {
      people: "SELECT count(*) AS n FROM person",
      left: "SELECT count(*) AS n FROM person WHERE status = 'terminated'",
      leavers: `SELECT u.email_addr AS email, t.connector AS system, a.display_name AS name, a.user_account_uid AS uid
       FROM user_inventory u
       JOIN edge e ON e.src_uid = u.uid AND e.verb = 'has_account'
       JOIN user_account a ON a.user_account_uid = e.dst_uid
       JOIN tenant t ON t.tenant_uid = a.tenant_uid
       WHERE u.status = 'terminated' AND a.active = 1 ORDER BY u.email_addr`,
    },
    assert: ({ people, left, leavers }) =>
      !n(people)
        ? undefined
        : {
            status: leavers.length ? "fail" : "pass",
            detail: leavers.length
              ? `${leavers.length} active account(s) of people who left: ${list(
                  leavers,
                  (x) => `${cell(x["email"])} in ${cell(x["system"])}`,
                )}`
              : `${n(left)} leaver(s), none with an active account`,
            subjects: uids(leavers),
          },
    fix: "turn the accounts off in each system today; then make offboarding turn them off (identity provider first)",
  }),
  defineControl({
    id: "orphans",
    title: "Every active account belongs to a person on the roster",
    scf: ["IAC-08"],
    subject: "estate",
    query: {
      people: "SELECT count(*) AS n FROM person",
      orphans: `SELECT a.connector AS system, a.display_name AS name, a.user_account_uid AS uid FROM user_account a
       WHERE a.active = 1 AND coalesce(a.service, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.dst_uid = a.user_account_uid AND e.verb = 'has_account')
       ORDER BY a.connector, a.display_name`,
    },
    assert: ({ people, orphans }) =>
      !n(people)
        ? undefined
        : {
            status: orphans.length ? "warn" : "pass",
            detail: orphans.length
              ? `${orphans.length} account(s) with no person: ${list(
                  orphans,
                  (x) => `${cell(x["name"])} in ${cell(x["system"])}`,
                )}`
              : "every active account matches a person",
            subjects: uids(orphans),
          },
    fix: 'for each: link it to a person (a login-only system: add it to fleets/<fleet>/estate/links.ts, as "github:alice": "alice@example.org"), or turn it off',
  }),
  defineControl({
    id: "devices-for-people",
    title: "Every active person has a known device",
    scf: ["AST-04", "AST-07.1"],
    subject: "estate",
    query: {
      people: "SELECT count(*) AS n FROM person",
      without: `SELECT u.email_addr AS email, u.uid FROM user_inventory u WHERE u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM party_fixed_asset_assignment a WHERE a.party_uid = u.uid)
       ORDER BY u.email_addr`,
    },
    assert: ({ people, without }) =>
      !n(people)
        ? undefined
        : {
            status: without.length ? "warn" : "pass",
            detail: without.length
              ? `${without.length} without a device: ${list(without, (x) => x["email"] as string)}`
              : "every active person has a device",
            subjects: uids(without),
          },
    fix: "adopt each person's laptop (Add a machine), with --owner set to their work email",
  }),
  defineControl({
    id: "admins-mfa",
    title: "Every administrator signs in with a second factor",
    scf: ["IAC-37"],
    subject: "estate",
    query: {
      known: "SELECT count(*) AS n FROM user_account WHERE admin IS NOT NULL AND mfa IS NOT NULL",
      bad: `SELECT connector AS system, display_name AS name, user_account_uid AS uid FROM user_account
       WHERE active = 1 AND admin = 1 AND mfa = 0 ORDER BY connector, display_name`,
    },
    assert: ({ known, bad }) =>
      !n(known)
        ? undefined
        : {
            status: bad.length ? "fail" : "pass",
            detail: bad.length
              ? `${bad.length} without MFA: ${list(bad, (x) => `${cell(x["name"])} in ${cell(x["system"])}`)}`
              : "every administrator has MFA",
            subjects: uids(bad),
          },
    fix: "require MFA for administrators in each system (and register it for these people)",
  }),
  // Spec 087: password manager coverage, when one is connected and people are known.
  defineControl({
    id: "password-manager",
    title: "Every active person has a password manager account",
    scf: ["IAC-14"],
    subject: "estate",
    query: {
      people: "SELECT count(*) AS n FROM person",
      connected: `SELECT count(*) AS n FROM tenant WHERE connector IN (${PM_LIST})`,
      uncovered: `SELECT u.email_addr AS email, u.uid FROM user_inventory u WHERE u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM edge e JOIN user_account a ON a.user_account_uid = e.dst_uid
         WHERE e.src_uid = u.uid AND e.verb = 'has_account' AND a.active = 1 AND a.connector IN (${PM_LIST}))
       ORDER BY u.email_addr`,
    },
    assert: ({ people, connected, uncovered }) =>
      !n(people) || !n(connected)
        ? undefined
        : {
            status: uncovered.length ? "warn" : "pass",
            detail: uncovered.length
              ? `${uncovered.length} without one: ${list(uncovered, (x) => String(x["email"]))}`
              : "every active person has an active password manager account",
            subjects: uids(uncovered),
          },
    fix: "invite each of them to the company's password manager (and have them accept)",
  }),
  defineControl({
    id: "devices-encrypted",
    title: "Every device's disk is encrypted",
    scf: ["CRY-07"],
    subject: "estate",
    query: {
      known: "SELECT count(*) AS n FROM fixed_asset WHERE encrypted IS NOT NULL",
      plain: `SELECT hostname AS name, fixed_asset_uid AS uid FROM fixed_asset WHERE encrypted = 0 ORDER BY hostname`,
    },
    assert: ({ known, plain }) =>
      !n(known)
        ? undefined
        : {
            status: plain.length ? "fail" : "pass",
            detail: plain.length
              ? `${plain.length} not encrypted: ${list(plain, (x) => x["name"] as string)}`
              : "every device that says is encrypted",
            subjects: uids(plain),
          },
    fix: "turn on FileVault, BitLocker, or LUKS (or record an accepted risk)",
  }),
  defineControl({
    id: "repos-protected",
    title: "Every private repository protects its default branch",
    scf: ["CHG-03"],
    subject: "estate",
    query: {
      repos: "SELECT count(*) AS n FROM code_repository",
      open: `SELECT display_name AS name, code_repository_uid AS uid FROM code_repository
       WHERE private = 1 AND protected = 0 ORDER BY display_name`,
    },
    assert: ({ repos, open }) =>
      !n(repos)
        ? undefined
        : {
            status: open.length ? "fail" : "pass",
            detail: open.length
              ? `${open.length} unprotected: ${list(open, (x) => x["name"] as string)}`
              : `${n(repos)} repositories, all protected`,
            subjects: uids(open),
          },
    fix: "protect the default branch: require a pull request, an approving review, and passing checks",
  }),
];

/** Write results to the finding table: one row per result, SCF control, and subject. */
export function writeFindings(
  e: Estate,
  results: ReadonlyArray<PolicyResult & { subjects?: string[] }>,
  now = new Date(),
): void {
  const at = now.toISOString().replace(/\.\d+Z$/, "Z");
  for (const p of results) {
    const subjects = p.subjects ?? [];
    for (const control of p.scf) {
      for (const subject of subjects.length ? subjects : [undefined]) {
        e.db.prepare(upsertSql(finding)).run(
          ...rowParams(finding, {
            finding_uid: `${p.id}:${control}:${subject ?? "all"}`,
            policy_id: p.id,
            subject_uid: subject ?? null,
            scf_control: control,
            status: p.status,
            detail: p.detail,
            fix: p.fix ?? null,
            observed_at: at,
          }),
        );
      }
    }
  }
}

/** The cross-system policies, on the graph; each result is also written to the finding table. */
export function estatePolicies(e: Estate, now = new Date()): PolicyResult[] {
  const out = ESTATE_CONTROLS.flatMap((c) => runEstate(c, (sql) => estateQuery(e, sql), now) ?? []);
  writeFindings(e, out, now);
  return out.map(({ subjects: _, ...p }) => p);
}

const sqlValue = (v: unknown): string =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "number" || typeof v === "bigint"
      ? String(v)
      : `'${cell(v).replace(/'/g, "''")}'`;

/** The graph as canonical SQL: the schema, then every row as an INSERT, in a stable order. */
export function estateSql(e: Estate): string {
  const out = [estateSchemaSql(), "BEGIN;"];
  for (const t of ordered(ESTATE_SCHEMA).filter((d) => d.kind === "table")) {
    const cols = Object.keys(t.columns);
    const rows = e.db
      .prepare(`SELECT ${cols.join(", ")} FROM ${t.name} ORDER BY ${t.key.join(", ")}`)
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.push(
        `INSERT INTO ${t.name} (${cols.join(", ")}) VALUES (${cols
          .map((c) => sqlValue(r[c]))
          .join(", ")});`,
      );
    }
  }
  out.push("COMMIT;", "");
  return out.join("\n");
}
