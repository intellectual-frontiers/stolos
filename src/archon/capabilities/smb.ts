// 037-smb: file shares over SMB (Samba) on every server, off until an operator
// turns them on with `archon fs smb on`; then on, across reboots and reinstalls,
// until `archon fs smb off`. The switch is the host's own recorded state
// (state/hosts/<host>/smb.json), which every apply honors.
//
// Overrides of Ubuntu defaults: smbd masked until switched on (Ubuntu starts it
// on install); nmbd always masked (NetBIOS off).

import type { Capability } from "../model/types.ts";
import { header } from "../render/systemd.ts";
import { localNetworks } from "./ssh.ts";
import { SMB, smbConf } from "../smb/config.ts";
import { P } from "../core/paths.ts";
import { join } from "../core/path.ts";

const SPEC = "037-smb" as const;

export const smb = (): Capability => ({ fleet, host, users }) => {
  if (host.kind === "workstation") return { spec: SPEC };
  const record = join(P.installedRepo, "state", "hosts", host.name, `${SMB.switch}.json`);
  return {
    spec: SPEC,
    packages: [{ name: "samba", spec: SPEC }],
    // Open to the local networks on every server; nothing listens while SMB is off.
    ports: [{ port: 445, protocol: "tcp", from: localNetworks(fleet), spec: SPEC }],
    files: [
      {
        path: "/etc/sysusers.d/archon-smb.conf",
        content: header(SPEC) + `g ${SMB.group} - - -\n`,
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{ kind: "run", argv: ["systemd-sysusers", "/etc/sysusers.d/archon-smb.conf"] }],
      },
      {
        path: "/etc/tmpfiles.d/archon-smb.conf",
        content: header(SPEC) +
          [`d ${SMB.root} 0755 root root -`, `d ${SMB.shared} 2775 root ${SMB.group} -`].join(
            "\n",
          ) + "\n",
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{
          kind: "run",
          argv: ["systemd-tmpfiles", "--create", "/etc/tmpfiles.d/archon-smb.conf"],
        }],
      },
      {
        path: SMB.conf,
        content: smbConf(fleet, host, users),
        mode: "0644",
        owner: "root",
        spec: SPEC,
        validate: ["testparm", "-s", "{}"],
        // Running or not, the new configuration is the one in force.
        onChange: [{ kind: "run", argv: ["systemctl", "try-reload-or-restart", SMB.unit] }],
      },
    ],
    units: [
      {
        // Off (masked) until an operator's `archon fs smb on`; then on until `off`.
        unitName: SMB.unit,
        managed: false,
        state: "masked",
        switch: SMB.switch,
        verify:
          `sh -c 'if grep -q "\\"enabled\\": *true" ${record} 2>/dev/null; then systemctl is-active --quiet ${SMB.unit}; else ! systemctl is-active --quiet ${SMB.unit}; fi'`,
        spec: SPEC,
      },
      {
        // NetBIOS stays off.
        unitName: "nmbd.service",
        managed: false,
        state: "masked",
        verify: "sh -c '! systemctl is-active --quiet nmbd.service'",
        spec: SPEC,
      },
    ],
    notes: [
      "SMB (Samba) is installed and off until an operator runs archon fs smb on; archon fs smb status shows it.",
    ],
  };
};
