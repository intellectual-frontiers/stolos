/**
 * 039-pg-identity: the fleet's service accounts on every server. An app runs as
 * its own Linux account (s-<app>), the same UID everywhere, with no password and
 * no shell; that account is its identity in PostgreSQL (peer on the socket).
 *
 * @module
 */

import type { Capability } from "../model/types.ts";
import { header } from "../render/systemd.ts";

const SPEC = "039-pg-identity" as const;

/** sysusers.d lines for the fleet's service accounts. */
export const serviceAccountsConf = (
  services: Array<{ name: string; uid: number; description: string }>,
): string =>
  header(SPEC) +
  services.map((s) =>
    `u ${s.name} ${s.uid} "${
      s.description.replace(/"/g, "'")
    }" /var/lib/${s.name} /usr/sbin/nologin`
  ).join("\n") + "\n";

/** The fleet's service accounts on every server (spec 039). */
export const services = (): Capability => ({ fleet, host }) => {
  const list = fleet.services ?? [];
  if (host.kind === "workstation" || !list.length) return { spec: SPEC };
  return {
    spec: SPEC,
    files: [
      {
        path: "/etc/sysusers.d/archon-services.conf",
        content: serviceAccountsConf(list),
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{
          kind: "run",
          argv: ["systemd-sysusers", "/etc/sysusers.d/archon-services.conf"],
        }],
      },
      {
        path: "/etc/tmpfiles.d/archon-services.conf",
        content: header(SPEC) +
          list.map((s) => `d /var/lib/${s.name} 0750 ${s.name} ${s.name} -`).join("\n") + "\n",
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{
          kind: "run",
          argv: ["systemd-tmpfiles", "--create", "/etc/tmpfiles.d/archon-services.conf"],
        }],
      },
    ],
    notes: [
      `Service accounts (no password, no shell): ${
        list.map((s) => `${s.name} (${s.uid})`).join(", ")
      }.`,
    ],
  };
};
