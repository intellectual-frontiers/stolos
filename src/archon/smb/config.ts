// 037-smb: Samba's configuration, as data. One share for everyone with an
// account (`shared`), and each account's own home folder; SMB3 only, encryption
// desired, no guests, no NetBIOS, the local networks only.

import type { FleetDef, HostDef, UserDef } from "../model/types.ts";
import { LOCAL_NETWORKS, localNetworks } from "../capabilities/ssh.ts";
import { fqdn } from "../web/config.ts";

export const SMB = {
  conf: "/etc/samba/smb.conf",
  root: "/srv/smb",
  shared: "/srv/smb/shared",
  group: "smb-shared",
  unit: "smbd.service",
  /** The operator's switch: the host's own archon.sql (opt-in smb). */
  switch: "smb",
  privateDir: "/var/lib/samba/private",
} as const;

// Samba keeps its own copy of each Linux password (SMB clients prove a password
// with an NT hash, which Linux's hash cannot check): the PAM hook in
// capabilities/passwords.ts keeps it in step (specs 037, 039).

/** The accounts that may use SMB: everyone in the model but ops (a service account). */
export function smbUsers(users: UserDef[]): string[] {
  return users.filter((u) => u.name !== "ops").map((u) => u.name).sort();
}

/** "smb.alpha.lab.example.net" (the server's wildcard record covers it), else the host name. */
export function smbName(fleet: FleetDef, host: HostDef): string {
  const n = fqdn(fleet, host);
  return n ? `smb.${n}` : host.name;
}

export function smbConf(fleet: FleetDef, host: HostDef, users: UserDef[]): string {
  const nets = localNetworks(fleet);
  const allow = [...(nets.length ? nets : LOCAL_NETWORKS), "127.0.0.1", "::1"];
  const who = smbUsers(users);
  return `# Rendered by archon from spec 037-smb. Do not edit: change the model in /srv/archon.
# On only when an operator ran \`archon fs smb on\` (archon fs smb status).

[global]
   server string = ${host.name} (Archon)
   server role = standalone server
   workgroup = WORKGROUP
   # SMB over TCP 445 only: no NetBIOS (nmbd stays masked).
   disable netbios = yes
   smb ports = 445
   server min protocol = SMB3
   server smb encrypt = desired
   # Accounts only: the same username and password as Linux (spec 037); no
   # guests, no anonymous listing, no system accounts.
   security = user
   map to guest = never
   restrict anonymous = 2
   invalid users = root ops
   passdb backend = tdbsam
   unix password sync = no
   # The local networks only (the firewall says the same).
   hosts allow = ${allow.join(" ")}
   hosts deny = ALL
   # No printers, no user-defined shares.
   load printers = no
   printing = bsd
   printcap name = /dev/null
   disable spoolss = yes
   usershare max shares = 0
   logging = systemd
   # Every SMB sign-in, accepted or refused, with the user and the client, in the journal.
   log level = 1 auth_audit:3
   # macOS clients: Finder metadata and resource forks.
   vfs objects = fruit streams_xattr
   fruit:metadata = stream
   fruit:nfs_aces = no

[homes]
   comment = Your home folder
   browseable = no
   read only = no
   valid users = %S
   create mask = 0600
   directory mask = 0700

[shared]
   comment = Shared with everyone who has an account on ${host.name}
   path = ${SMB.shared}
   read only = no
   valid users = ${who.join(" ") || "nobody"}
   force group = ${SMB.group}
   create mask = 0664
   force create mode = 0660
   directory mask = 2775
   force directory mode = 2770
`;
}
