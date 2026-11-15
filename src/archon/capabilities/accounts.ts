/**
 * 006-accounts: Archon's groups (sysusers.d), the operator sudo rule, and the
 * ops account's GitHub access through this host's deploy key. Accounts are
 * converged by `archon apply` from the fleet admin, ops, and extras.
 *
 * Overrides of Ubuntu defaults: none. The admin account Ubuntu's installer
 * creates is kept (it is in Ubuntu's `sudo` group).
 *
 * @module
 */

import type { Capability } from "../model/types.ts";
import { ARCHON_GROUPS } from "../personas/mod.ts";
import { header } from "../render/systemd.ts";

const SPEC = "006-accounts" as const;

/** Archon's groups, the operator sudo rule, and ops' GitHub access (spec 006). */
export const accounts =
  (): Capability =>
  ({ fleet, host }) => ({
    spec: SPEC,
    files: [
      {
        path: "/etc/sysusers.d/archon.conf",
        content: header(SPEC) + ARCHON_GROUPS.map((g) => `g ${g.name} - - -`).join("\n") + "\n",
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{ kind: "run", argv: ["systemd-sysusers", "/etc/sysusers.d/archon.conf"] }],
      },
      {
        // Operators (including ops, which serves archon mcp) may run archon as root without a
        // password; every mutating archon command elevates through this rule.
        path: "/etc/sudoers.d/archon",
        content:
          header(SPEC) +
          [
            'Defaults:%archon-ops env_keep += "ARCHON_AGENT"',
            "%archon-ops ALL=(root) NOPASSWD: /usr/local/bin/archon, /usr/local/bin/archon *",
          ].join("\n") +
          "\n",
        mode: "0440",
        owner: "root",
        spec: SPEC,
        validate: ["visudo", "-cf", "{}"],
      },
      // A workstation has no ops account (spec 020).
      ...(host.kind === "workstation"
        ? []
        : [
            {
              // ops reaches GitHub over SSH with this host's deploy key (spec 004).
              path: "/home/ops/.ssh/config",
              content:
                header(SPEC) +
                [
                  "Host github.com",
                  "  User git",
                  "  IdentityFile /home/ops/.ssh/archon_deploy_key",
                  "  IdentitiesOnly yes",
                  "  UserKnownHostsFile /etc/archon/github_known_hosts",
                ].join("\n") +
                "\n",
              mode: "0600",
              owner: "ops",
              group: "ops",
              spec: SPEC,
            },
          ]),
    ],
    notes: [
      `Groups: archon (all), archon-dev (developer), archon-ops (operator). ${
        host.kind === "workstation" ? (host.user ?? fleet.admin.user) : fleet.admin.user
      } is also in Ubuntu's sudo group.`,
      "Operators get passwordless sudo for /usr/local/bin/archon only.",
    ],
  });
