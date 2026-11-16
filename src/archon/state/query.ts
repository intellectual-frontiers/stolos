/**
 * Spec 048-observe-by-query (Article 17): `archon query` answers one SELECT
 * about this machine through osquery, including Archon's own tables
 * (archon_install, archon_verify, archon_prov, archon_optin, built from
 * archon.sql). The server limits it, not the client: one statement, only
 * tables on the allowlist (nothing that reveals secrets or reaches out),
 * a row limit, and a time limit.
 *
 * @module
 */
// Spec: 048-observe-by-query

import { count, span } from "../core/telemetry.ts";
import { run } from "../core/exec.ts";
import { OSQUERY } from "../capabilities/osquery.ts";
import { VIEWS } from "./store.ts";

/** osquery tables an operator or agent may read (Archon's own are added). */
export const QUERY_TABLES = new Set([
  "os_version",
  "system_info",
  "uptime",
  "kernel_info",
  "kernel_modules",
  "deb_packages",
  "apt_sources",
  "snap_packages",
  "systemd_units",
  "processes",
  "listening_ports",
  "process_open_sockets",
  "interface_addresses",
  "interface_details",
  "routes",
  "dns_resolvers",
  "etc_hosts",
  "users",
  "groups",
  "user_groups",
  "logged_in_users",
  "last",
  "sudoers",
  "authorized_keys",
  "ssh_configs",
  "mounts",
  "disk_encryption",
  "block_devices",
  "memory_info",
  "cpu_info",
  "load_average",
  "crontab",
  "iptables",
  "time",
  "osquery_info",
  // Spec 067: workstations (adopted machines): installed applications and packages.
  "apps",
  "homebrew_packages",
  "rpm_packages",
  "programs",
  ...Object.keys(VIEWS),
]);

/** Never: these reveal secrets (password hashes, environments) or reach out (network, files). */
export const QUERY_DENIED = [
  "shadow",
  "process_envs",
  "curl",
  "curl_certificate",
  "carves",
  "yara",
  "augeas",
  "file",
  "hash",
  "magic",
  "docker_container_envs",
];

/** The most rows a query returns. */
export const QUERY_MAX_ROWS = 1000;
/** How long a query may run, in seconds. */
export const QUERY_TIMEOUT_S = 20;

/** Why this SQL may not run here, or undefined. */
export function queryRefusal(sql: string): string | undefined {
  const s = sql.trim().replace(/;\s*$/, "");
  if (!s) return "no query";
  if (s.includes(";")) return "one statement only";
  if (!/^(select|with)\b/i.test(s)) return "only SELECT (or WITH ... SELECT)";
  if (/\b(attach|pragma|insert|update|delete|create|drop|alter|replace)\b/i.test(s)) {
    return "only reading";
  }
  const tables = queryTables(s);
  const ctes = new Set(
    [...s.matchAll(/\b(\w+)\s+as\s*\(/gi)].map((m) => (m[1] ?? "").toLowerCase()),
  );
  for (const t of tables) {
    if (ctes.has(t)) continue;
    if (QUERY_DENIED.includes(t)) return `the table ${t} is never served (secrets or reaching out)`;
    if (!QUERY_TABLES.has(t)) return `the table ${t} is not on the allowlist`;
  }
  return undefined;
}

/** Tables named after FROM or JOIN. */
export function queryTables(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)].map((m) =>
    (m[1] ?? "").toLowerCase(),
  );
}

/** The osqueryi command for one query (Archon's tables come with its config). */
export function queryArgv(sql: string): string[] {
  return [
    "timeout",
    String(QUERY_TIMEOUT_S),
    "osqueryi",
    `--config_path=${OSQUERY.conf}`,
    `--disable_tables=${QUERY_DENIED.join(",")}`,
    "--json",
    sql,
  ];
}

/** Run one allowlisted SQL query through osquery. */
export async function query(sql: string): Promise<Array<Record<string, string>>> {
  const why = queryRefusal(sql);
  const tables = queryTables(sql);
  for (const t of tables.length ? tables : ["(none)"]) {
    count("archon.query.requests", 1, {
      "archon.result": why ? "refused" : "served",
      "archon.table": t,
    });
  }
  if (why) throw new Error(`refused: ${why}`);
  const end = span("archon.query", { "archon.table": tables.join(",") });
  const r = await run(queryArgv(sql.trim().replace(/;\s*$/, "")));
  end(r.ok);
  if (!r.ok) throw new Error(`osqueryi: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  const rows = JSON.parse(r.stdout || "[]") as Array<Record<string, string>>;
  return rows.slice(0, QUERY_MAX_ROWS);
}

/** Rows as aligned text columns. */
export function table(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "(no rows)";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    return JSON.stringify(v) ?? "";
  };
  const w = cols.map((c) =>
    Math.min(60, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))),
  );
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.slice(0, 60).padEnd(w[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(cols),
    line(w.map((n) => "-".repeat(n))),
    ...rows.map((r) => line(cols.map((c) => cell(r[c])))),
  ].join("\n");
}
