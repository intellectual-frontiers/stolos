/**
 * 038-pg, 039-pg-identity, 040-opt-in: PostgreSQL instances on a server, from
 * the model (host.pg.instances) and the host's record (the host's own archon.sql (opt-in pg)).
 * An opt-in service: every server has postgresql-common, and postgresql.service
 * (every cluster is PartOf it) stays masked until an operator runs archon pg on;
 * then apply's Databases phase converges each instance, a Debian cluster
 * <version>/<name>.
 *
 * Overrides of Ubuntu defaults: no `main` cluster on install
 * (createcluster.d/50-archon.conf), so every cluster on the host is one an
 * operator asked for; postgresql.service masked until switched on.
 *
 * @module
 */

import type { Capability, UnitDef } from "../model/types.ts";
import { header } from "../render/systemd.ts";
import { timedJob } from "./ops.ts";
import {
  IDENTITY_SPEC,
  instancesOf,
  PG,
  PG_UNIT,
  pgOn,
  publishFrom,
  SPEC,
  sudoersPg,
  unitOf,
} from "../pg/config.ts";

export const pg = (): Capability => ({ fleet, host, users }) => {
  if (host.kind === "workstation") return { spec: SPEC };
  const instances = instancesOf(host, users, fleet);
  const on = pgOn(host);
  // On every server: Ubuntu's PostgreSQL tooling, no clusters, the umbrella unit masked.
  const always = {
    packages: [{ name: "postgresql-common", spec: SPEC }, { name: "zstd", spec: SPEC }],
    files: [{
      path: PG.createclusterConf,
      content: header(SPEC) + "create_main_cluster = false\n",
      mode: "0644",
      owner: "root",
      spec: SPEC,
    }],
    unit: {
      unitName: PG_UNIT,
      managed: false,
      state: "masked" as const,
      switch: "pg",
      verify:
        // Rendered from the host's own record (spec 048): on, it runs; off, it does not.
        on
          ? `systemctl is-active --quiet ${PG_UNIT}`
          : `sh -c '! systemctl is-active --quiet ${PG_UNIT}'`,
      spec: SPEC,
    },
  };
  if (!on) {
    return {
      spec: SPEC,
      packages: always.packages,
      files: always.files,
      units: [always.unit],
      notes: [
        "PostgreSQL is installed and off until an operator runs archon pg on (an opt-in service).",
      ],
    };
  }
  const services = [
    ...new Set(
      instances.flatMap((i) => i.roles.filter((r) => r.kind === "service").map((r) => r.name)),
    ),
  ].sort();
  return {
    spec: SPEC,
    packages: always.packages,
    files: [
      ...always.files,
      {
        path: "/etc/tmpfiles.d/archon-pg.conf",
        content: header(SPEC) +
          [`d ${PG.secrets} 0711 root root -`, `d ${PG.dumps} 0700 root root -`].join("\n") + "\n",
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{
          kind: "run",
          argv: ["systemd-tmpfiles", "--create", "/etc/tmpfiles.d/archon-pg.conf"],
        }],
      },
      {
        // The superuser only through sudo; operators may also act as an app's account.
        path: PG.sudoers,
        content: sudoersPg(services),
        mode: "0440",
        owner: "root",
        spec: IDENTITY_SPEC,
        validate: ["visudo", "-cf", "{}"],
      },
    ],
    // Published instances: open to every address (the router decides what reaches the
    // server), or to the local networks only with --local-only. TLS and scram always.
    ports: instances.filter((i) => i.published && i.port).map((i) => ({
      port: i.port!,
      protocol: "tcp" as const,
      ...(i.localOnly ? { from: publishFrom(fleet, true) } : {}),
      spec: SPEC,
    })),
    units: [
      always.unit,
      ...instances.filter((i) => i.port).map((i): UnitDef => ({
        // postgresql-common's own unit for the cluster; Archon only checks it.
        unitName: unitOf(i.version, i.name),
        managed: false,
        state: "ignore",
        verify: `pg_isready -q -h ${PG.socketDir} -p ${i.port}`,
        spec: SPEC,
      })),
      // Nightly dumps before spec 016's archive (02:37), which then carries them.
      ...timedJob({
        name: "pg-backup",
        description: "PostgreSQL dumps",
        argv: ["pg", "backup", "--all"],
        onCalendar: "*-*-* 02:07:00",
        spec: SPEC,
      }),
    ],
    checks: instances.filter((i) => i.record).map((i) => ({
      name: `${i.name}: every login is a Linux account; only postgres is a superuser`,
      command: `/usr/local/bin/archon pg who ${i.name}`,
      level: "fail" as const,
      fix:
        `sudo archon pg who ${i.name} names each problem; sudo archon apply fixes the ones Archon owns`,
      spec: IDENTITY_SPEC,
    })),
    notes: [
      `PostgreSQL is on: ${
        instances.map((i) =>
          `${i.name} (${i.version}${i.port ? `, port ${i.port}` : ""}${
            i.published ? ", published" : ""
          })`
        ).join(", ") || "no instances yet"
      }.`,
    ],
  };
};
