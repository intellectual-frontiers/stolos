/**
 * Spec 085: the estate graph. Every connector's entities, and the fleet's
 * own machines, loaded into an in-memory SQLite database (Deno's built-in
 * node:sqlite: nothing to install), so one SQL question spans every source:
 * `stolos estate query "select ..."`. The cross-system policies run on the
 * same tables: leavers with live accounts, accounts no person owns,
 * administrators without a second factor, people without a device.
 *
 * Tables: people, accounts, devices, repositories (columns as in
 * entities.ts; booleans are 0 and 1).
 *
 * ```mermaid
 * flowchart LR
 *   hr["HR system: people"] --> g[("estate graph (SQLite, in memory)")]
 *   idp["identity, code, clouds: accounts"] --> g
 *   dev["machines, MDM, SNMP: devices"] --> g
 *   code["code hosts: repositories"] --> g
 *   g --> q["estate query: one SELECT"] & p["cross-system policies (SCF)"]
 * ```
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Account, Device, Entities, Person, Repository } from "./entities.ts";
import { emailKey } from "./entities.ts";

const TABLES: Record<string, string[]> = {
  people: ["email", "name", "status", "start", "end", "manager", "type"],
  accounts: ["system", "id", "name", "email", "active", "admin", "mfa", "lastLogin", "service"],
  devices: ["source", "id", "name", "owner", "os", "serial", "encrypted", "managed", "seen"],
  repositories: [
    "system",
    "name",
    "private",
    "protected",
    "reviews",
    "secretScanning",
    "dependencyAlerts",
  ],
};

/** The estate graph: a database with every source's entities. */
export interface Estate {
  /** The database (read it with {@link estateQuery}). */
  db: DatabaseSync;
  /** Everything, merged. */
  all: Required<Entities>;
}

/** Merge sources' entities: people by email (the HR record wins), the rest as they come. */
export function mergeEntities(sources: Entities[]): Required<Entities> {
  const people = new Map<string, Person>();
  for (const s of sources) {
    for (const p of s.people ?? []) {
      const k = emailKey(p.email);
      if (k) people.set(k, { ...people.get(k), ...p, email: k });
    }
  }
  return {
    people: [...people.values()],
    accounts: sources.flatMap((s) => s.accounts ?? []).map((a) => ({
      ...a,
      ...(emailKey(a.email) ? { email: emailKey(a.email) } : {}),
    })),
    devices: sources.flatMap((s) => s.devices ?? []),
    repositories: sources.flatMap((s) => s.repositories ?? []),
  };
}

/** Build the graph. */
export function buildEstate(sources: Entities[]): Estate {
  const all = mergeEntities(sources);
  const db = new DatabaseSync(":memory:");
  for (const [t, cols] of Object.entries(TABLES)) {
    db.exec(`create table ${t} (${cols.map((c) => `"${c}"`).join(", ")})`);
    const ins = db.prepare(`insert into ${t} values (${cols.map(() => "?").join(", ")})`);
    for (const row of (all as unknown as Record<string, Array<Record<string, unknown>>>)[t]) {
      ins.run(...cols.map((c) => {
        const v = row[c];
        return typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v as string | number;
      }));
    }
  }
  return { db, all };
}

/** Why this SQL may not run on the estate, or undefined: one statement, reading only. */
export function estateRefusal(sql: string): string | undefined {
  const s = sql.trim().replace(/;\s*$/, "");
  if (!s) return "no query";
  if (s.includes(";")) return "one statement only";
  if (!/^(select|with)\b/i.test(s)) return "only SELECT (or WITH ... SELECT)";
  if (
    /\b(attach|detach|pragma|insert|update|delete|create|drop|alter|replace|vacuum|load_extension)\b/i
      .test(s)
  ) {
    return "only reading";
  }
  return undefined;
}

/** Run one SELECT on the estate. */
export function estateQuery(e: Estate, sql: string): Array<Record<string, unknown>> {
  const why = estateRefusal(sql);
  if (why) throw new Error(`refused: ${why}`);
  // Plain objects (SQLite's rows have no prototype).
  return (e.db.prepare(sql.trim().replace(/;\s*$/, "")).all() as Array<Record<string, unknown>>)
    .map((r) => ({ ...r }));
}

/** The cross-system policies: what no single source can say. */
export function estatePolicies(e: Estate): PolicyResult[] {
  const out: PolicyResult[] = [];
  const rows = (sql: string) => e.db.prepare(sql).all() as Array<Record<string, string>>;
  const hasPeople = e.all.people.length > 0;
  const list = (r: Array<Record<string, string>>, f: (x: Record<string, string>) => string) =>
    r.slice(0, 12).map(f).join(", ") + (r.length > 12 ? `, and ${r.length - 12} more` : "");
  if (hasPeople) {
    const leavers = rows(
      `select a.system, a.name, p.email, p.end from accounts a join people p on a.email = p.email
       where p.status = 'terminated' and a.active = 1 order by p.email`,
    );
    out.push({
      id: "leavers",
      title: "People who left have no active accounts",
      scf: ["IAC-07"],
      status: leavers.length ? "fail" : "pass",
      detail: leavers.length
        ? `${leavers.length} active account(s) of people who left: ${
          list(leavers, (x) => `${x.email} in ${x.system}`)
        }`
        : `${
          e.all.people.filter((p) => p.status === "terminated").length
        } leaver(s), none with an active account`,
      fix:
        "turn the accounts off in each system today; then make offboarding turn them off (identity provider first)",
    });
    const orphans = rows(
      `select a.system, a.name, a.email from accounts a left join people p on a.email = p.email
       where a.active = 1 and coalesce(a.service, 0) = 0 and (a.email is null or p.email is null) order by a.system, a.name`,
    );
    out.push({
      id: "orphans",
      title: "Every active account belongs to a person on the roster",
      scf: ["IAC-15"],
      status: orphans.length ? "warn" : "pass",
      detail: orphans.length
        ? `${orphans.length} account(s) with no person: ${
          list(orphans, (x) => `${x.name} in ${x.system}`)
        }`
        : "every active account matches a person",
      fix: "for each: link it to a person (its email), mark it a service account, or turn it off",
    });
    const noDevice = rows(
      `select p.email from people p where p.status = 'active'
       and not exists (select 1 from devices d where lower(d.owner) = p.email) order by p.email`,
    );
    out.push({
      id: "devices-for-people",
      title: "Every active person has a known device",
      scf: ["AST-02", "AST-03"],
      status: noDevice.length ? "warn" : "pass",
      detail: noDevice.length
        ? `${noDevice.length} without a device: ${list(noDevice, (x) => x.email)}`
        : "every active person has a device",
      fix: "adopt each person's laptop (Add a machine), with --owner set to their work email",
    });
  }
  const adminsNoMfa = rows(
    `select system, name from accounts where active = 1 and admin = 1 and mfa = 0 order by system, name`,
  );
  if (e.all.accounts.some((a) => a.admin !== undefined && a.mfa !== undefined)) {
    out.push({
      id: "admins-mfa",
      title: "Every administrator signs in with a second factor",
      scf: ["IAC-06"],
      status: adminsNoMfa.length ? "fail" : "pass",
      detail: adminsNoMfa.length
        ? `${adminsNoMfa.length} without MFA: ${
          list(adminsNoMfa, (x) => `${x.name} in ${x.system}`)
        }`
        : "every administrator has MFA",
      fix: "require MFA for administrators in each system (and register it for these people)",
    });
  }
  const plain = rows(`select name, source from devices where encrypted = 0 order by name`);
  if (e.all.devices.some((d) => d.encrypted !== undefined)) {
    out.push({
      id: "devices-encrypted",
      title: "Every device's disk is encrypted",
      scf: ["CRY-05"],
      status: plain.length ? "fail" : "pass",
      detail: plain.length
        ? `${plain.length} not encrypted: ${list(plain, (x) => x.name)}`
        : "every device that says is encrypted",
      fix: "turn on FileVault, BitLocker, or LUKS (or record an accepted risk)",
    });
  }
  const unprotected = rows(
    `select name from repositories where private = 1 and protected = 0 order by name`,
  );
  if (e.all.repositories.length) {
    out.push({
      id: "repos-protected",
      title: "Every private repository protects its default branch",
      scf: ["CHG-02"],
      status: unprotected.length ? "fail" : "pass",
      detail: unprotected.length
        ? `${unprotected.length} unprotected: ${list(unprotected, (x) => x.name)}`
        : `${e.all.repositories.length} repositories, all protected`,
      fix:
        "protect the default branch: require a pull request, an approving review, and passing checks",
    });
  }
  return out;
}

/** Entities from accounts and the like, for a source that has none of a kind. */
export type { Account, Device, Person, Repository };
