/**
 * 042-sql: osquery's daemon on every host, as infrastructure: always installed
 * and running. It listens on no port (its only socket is a local one for
 * extensions), so the firewall opens nothing. It runs Archon's scheduled
 * queries and writes what changed to /var/log/osquery (rotated), where anyone
 * with root can read the machine's history: ports, logins, users, sudoers,
 * SSH keys, packages, kernel modules. osqueryi, the interactive shell, needs
 * no daemon.
 *
 * @module
 */

import { STATE_DB, VIEWS } from "../state/store.ts";
import type { Capability } from "../model/types.ts";

const SPEC = "042-sql" as const;

export const OSQUERY = {
  conf: "/etc/osquery/osquery.conf",
  flags: "/etc/osquery/osquery.flags",
  unit: "osqueryd.service",
  logs: "/var/log/osquery",
} as const;

/**
 * Flags for osqueryd (one per line, as osquery's flagfile reads them). The
 * package's unit passes the config path and the pidfile (/etc/default/osqueryd).
 */
export const OSQUERY_FLAGS = [
  "--config_plugin=filesystem",
  "--logger_plugin=filesystem",
  `--logger_path=${OSQUERY.logs}`,
  "--logger_rotate=true",
  "--logger_rotate_size=26214400",
  "--logger_rotate_max_files=10",
  "--database_path=/var/osquery/osquery.db",
  "--host_identifier=hostname",
  // No kernel audit subscription: event tables stay off (no load on journald).
  "--disable_events=true",
  "--schedule_splay_percent=10",
  // The watchdog keeps osqueryd small; a query over its limits is stopped.
  "--watchdog_level=0",
].join("\n") + "\n";

/** Archon's scheduled queries: what changed is logged (differential results). */
export const OSQUERY_SCHEDULE: Record<
  string,
  { query: string; interval: number; description: string }
> = {
  listening_ports: {
    query:
      "SELECT p.name, l.port, l.protocol, l.address FROM listening_ports l JOIN processes p USING (pid) WHERE l.port != 0;",
    interval: 900,
    description: "what listens on which port, by process",
  },
  logged_in_users: {
    query: "SELECT user, tty, host, time FROM logged_in_users;",
    interval: 300,
    description: "who is logged in, from where",
  },
  users: {
    query: "SELECT username, uid, gid, shell, directory FROM users;",
    interval: 3600,
    description: "the accounts",
  },
  sudoers: {
    query: "SELECT * FROM sudoers;",
    interval: 3600,
    description: "who may use sudo, and how",
  },
  authorized_keys: {
    query:
      "SELECT u.username, k.key_file, k.algorithm, k.comment FROM users u JOIN authorized_keys k USING (uid);",
    interval: 3600,
    description: "SSH keys that can log in",
  },
  deb_packages: {
    query: "SELECT name, version, source FROM deb_packages;",
    interval: 86400,
    description: "installed packages",
  },
  kernel_modules: {
    query: "SELECT name, size, status FROM kernel_modules;",
    interval: 3600,
    description: "loaded kernel modules",
  },
  failed_units: {
    query: "SELECT id, description, sub_state FROM systemd_units WHERE active_state = 'failed';",
    interval: 600,
    description: "systemd units that failed",
  },
};

/**
 * Spec 048: Archon's own records as osquery tables (automatic table
 * construction), read from archon.auto.sqlite.db, which archon builds from
 * this machine's archon.sql.
 */
export function archonTables(dir = "/var/lib/archon"): Record<
  string,
  { query: string; path: string; columns: string[]; platform: string }
> {
  return Object.fromEntries(
    Object.entries(VIEWS).map(([view, columns]) => [view, {
      query: `SELECT ${columns.join(", ")} FROM ${view}`,
      path: `${dir}/${STATE_DB}`,
      columns,
      platform: "linux",
    }]),
  );
}

export function osqueryConf(): string {
  return JSON.stringify(
    {
      options: { host_identifier: "hostname", schedule_splay_percent: 10 },
      schedule: OSQUERY_SCHEDULE,
      auto_table_construction: archonTables(),
    },
    null,
    2,
  ) + "\n";
}

export const osquery = (): Capability => () => ({
  spec: SPEC,
  files: [
    {
      path: OSQUERY.flags,
      content: "# Rendered by archon from spec 042-sql. Do not edit.\n" + OSQUERY_FLAGS,
      mode: "0644",
      owner: "root",
      spec: SPEC,
      onChange: [{ kind: "restart", unit: OSQUERY.unit }],
    },
    {
      // osquery's config is JSON (no comments): this file is rendered by archon (spec 042).
      path: OSQUERY.conf,
      content: osqueryConf(),
      mode: "0644",
      owner: "root",
      spec: SPEC,
      onChange: [{ kind: "restart", unit: OSQUERY.unit }],
    },
  ],
  units: [{
    unitName: OSQUERY.unit,
    managed: false,
    state: "enabled",
    start: true,
    verify:
      `sh -c 'systemctl is-active --quiet ${OSQUERY.unit} && osqueryi --json "SELECT 1 AS ok;" | grep -q ok'`,
    spec: SPEC,
  }],
  notes: [
    "osquery runs on every host (osqueryd: scheduled queries, changes logged to /var/log/osquery; no port). sudo osqueryi asks the machine anything in SQL.",
  ],
});
