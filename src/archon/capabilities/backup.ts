/**
 * 016-backups: the host's own state is archived daily (zstd tar) into Ubuntu's
 * /var/backups by default, kept to a retention count, and restore-tested.
 * Spec 044 (Article 23): durable data (S3 buckets, SMB shares) joins the
 * archive, durable guests are exported with `lxc export`, and a durable host
 * warns until an off-host copy exists.
 *
 * @module
 */
// Spec: 016-backups
// Spec: 044-durable

import type { BackupDef, Capability, HostDef } from "../model/types.ts";
import { describeData, durableGuests, durablePaths, hostData } from "../model/durable.ts";
import { timedJob } from "./ops.ts";

/** The default backup policy: Ubuntu's /var/backups, daily, a week kept. */
export const DEFAULT_BACKUP: BackupDef = {
  target: "/var/backups/archon",
  // The repository itself lives on GitHub; these are the host's own state.
  // Spec 037: Samba's password database (SMB passwords survive a restore; share contents
  // under /srv/smb can be large and are not included).
  paths: [
    "/etc",
    "/home",
    "/root",
    "/var/lib/archon",
    "/var/lib/archon-keys",
    "/var/lib/samba/private",
    "/var/snap/lxd/common/lxd/database",
  ],
  keep: 14,
  onCalendar: "*-*-* 02:37:00",
};

/** A host's backup policy: the default with the host's overrides. */
export function backupPolicy(host: HostDef): BackupDef {
  const p = { ...DEFAULT_BACKUP, ...(host.backup ?? {}) };
  const extra = durablePaths(host).filter((x) => !p.paths.includes(x));
  return extra.length ? { ...p, paths: [...p.paths, ...extra] } : p;
}

/** Daily, restore-tested archives of the host's own state (spec 016). */
export const backup =
  (): Capability =>
  ({ host }) => {
    const p = backupPolicy(host);
    return {
      spec: "016-backups",
      packages: [{ name: "zstd", spec: "016-backups" }],
      files: [
        {
          path: "/etc/tmpfiles.d/archon-backup.conf",
          content: `# Rendered by archon from spec 016-backups. Do not edit.\nd ${p.target} 0700 root root -\n`,
          mode: "0644",
          owner: "root",
          spec: "016-backups",
          onChange: [
            {
              kind: "run",
              argv: ["systemd-tmpfiles", "--create", "/etc/tmpfiles.d/archon-backup.conf"],
            },
          ],
        },
      ],
      units: [
        ...timedJob({
          name: "backup",
          description: "daily backup",
          argv: ["backup", "run"],
          onCalendar: p.onCalendar,
          spec: "016-backups",
        }),
      ],
      checks:
        hostData(host).class === "durable"
          ? [
              {
                name: "off-host copy of durable data",
                // No destination yet (spec 044): a later spec adds one and makes this a failure.
                command: `sh -c 'echo "none yet: the destination is not chosen, so the local archive is the only copy"; exit 1'`,
                level: "warn",
                fix: `${host.name} is ${describeData(
                  hostData(host),
                )}; a later spec adds the off-host destination (a NAS)`,
                spec: "044-durable",
              },
            ]
          : [],
      notes: [
        `Daily archives of ${p.paths.join(", ")} into ${p.target}, keeping ${p.keep}.`,
        ...(durableGuests(host).length
          ? [`Durable guests exported daily (lxc export): ${durableGuests(host).join(", ")}.`]
          : []),
      ],
    };
  };
