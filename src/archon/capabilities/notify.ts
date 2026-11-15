/**
 * 025-notify: email the fleet's shared mailbox about major events. The queue
 * lives in /var/spool/archon/notify (root only); the relay's token is Postfix's
 * (spec 027). A timer retries what is waiting, and
 * archon-notify-watch follows the journal for logins and other server events.
 *
 * @module
 */

import type { Capability } from "../model/types.ts";
import { HOST_NOTIFY } from "../notify/notify.ts";
import { SASL_PASSWD } from "../notify/transport.ts";
import { WATCH } from "../notify/watch.ts";
import { header } from "../render/systemd.ts";
import { timedJob } from "./ops.ts";

const SPEC = "025-notify" as const;

/** Emails the fleet's shared mailbox about major events (spec 025). */
export const notify =
  (): Capability =>
  ({ fleet }) => {
    if (!fleet.mail) return { spec: SPEC };
    return {
      spec: SPEC,
      files: [
        {
          path: "/etc/tmpfiles.d/archon-notify.conf",
          content:
            `# Rendered by archon from spec 025-notify. Do not edit.\n` +
            `d ${HOST_NOTIFY.spool} 0700 root root -\n`,
          mode: "0644",
          owner: "root",
          spec: SPEC,
          onChange: [
            {
              kind: "run",
              argv: ["systemd-tmpfiles", "--create", "/etc/tmpfiles.d/archon-notify.conf"],
            },
          ],
        },
      ],
      units: [
        ...timedJob({
          name: "notify-flush",
          description: "send queued notifications",
          argv: ["notify", "flush"],
          onCalendar: "*:0/5",
          spec: SPEC,
        }),
        {
          unitName: WATCH.unit,
          managed: true,
          content:
            header(SPEC) +
            [
              "[Unit]",
              "Description=Archon: email logins and other server events (archon notify watch)",
              "Documentation=man:archon-notify-watch(1)",
              "After=systemd-journald.service",
              "",
              "[Service]",
              "ExecStart=/usr/local/bin/archon notify watch",
              "Environment=ARCHON_AGENT=timer",
              "Restart=always",
              "RestartSec=30",
              "Nice=10",
              "MemoryMax=256M",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n"),
          state: "enabled",
          verify: `systemctl is-active ${WATCH.unit}`,
          spec: SPEC,
        },
      ],
      checks: [
        {
          name: "notify:ok",
          // Spec 052: without the relay token, mail is not set up yet (exit 3).
          command: `sh -c 'test -s ${SASL_PASSWD} || exit 3; archon notify status --check'`,
          level: "warn",
          code: "P027-MAIL-TOKEN",
          fix: "on the boot machine: bun run stolos boot mail-push <host> (or bun run stolos boot mail-setup first); archon notify status shows the last error",
          spec: SPEC,
        },
      ],
      notes: [
        `Major events are emailed to ${fleet.mail.to} from root+<host>${
          fleet.mail.tag ? `.${fleet.mail.tag}` : ""
        }@${fleet.mail.domain} (archon notify status).`,
      ],
    };
  };
