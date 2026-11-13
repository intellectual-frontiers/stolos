// 027-mail: every server can send mail, the way programs expect to
// (/usr/sbin/sendmail, or SMTP on localhost:25). Postfix, Ubuntu's default
// mail server, runs as a send-only "null client" (Postfix's
// STANDARD_CONFIGURATION_README): it receives nothing from the network,
// delivers nothing locally, and relays everything to Cloudflare Email Service
// over implicit TLS on port 465 with the fleet's API token (SASL). Cloudflare
// signs with DKIM for the sending domain. Mail for local accounts (root, ops,
// cron's MAILTO) goes to the fleet's mailbox; every sender becomes
// <user>+<host>.<tag>@<domain> (root+alpha.lab@example.net): one
// onboarded domain for the fleet, the machine in the subaddress (RFC 5233).

import type { Capability, FleetDef, HostDef } from "../model/types.ts";
import { networkOf } from "../model/resolve.ts";
import {
  DEFAULT_RELAY,
  hostLabel,
  relayParts,
  SASL_PASSWD,
  senderAddress,
} from "../notify/transport.ts";

const SPEC = "027-mail" as const;

export const MAIL = {
  mainCf: "/etc/postfix/main.cf",
  sender: "/etc/postfix/archon-sender.regexp",
  recipients: "/etc/postfix/archon-recipients.regexp",
};

const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Postfix's main.cf for this host. */
export function mainCf(fleet: FleetDef, host: HostDef): string {
  const m = fleet.mail!;
  const { host: relayHost, port } = relayParts(m.relay ?? DEFAULT_RELAY);
  const ipv6 = networkOf(fleet, host).ipv6;
  return [
    `# Rendered by archon from spec ${SPEC}. Do not edit: change the model in /srv/archon.`,
    "# A send-only null client: relays this host's mail to Cloudflare Email Service.",
    "compatibility_level = 3.6",
    `myhostname = ${hostMailName(fleet, host)}`,
    // Unqualified local accounts (root, ops) become root@<host>.<tag>.<domain>, which the
    // recipient map sends to the mailbox; real addresses at <domain> are left alone.
    `myorigin = ${hostMailName(fleet, host)}`,
    "mydestination =",
    "local_transport = error:local delivery is disabled",
    "alias_maps =",
    "alias_database =",
    "",
    "# Programs on this host only: sendmail, or SMTP on the loopback address.",
    "inet_interfaces = loopback-only",
    `inet_protocols = ${ipv6 ? "all" : "ipv4"}`,
    "mynetworks = 127.0.0.0/8 [::1]/128",
    "",
    "# Cloudflare Email Service: implicit TLS on 465 (no STARTTLS), its",
    "# certificate verified, SASL PLAIN with user api_token and the API token.",
    `relayhost = [${relayHost}]:${port}`,
    "smtp_tls_wrappermode = yes",
    "smtp_tls_security_level = secure",
    "smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt",
    "smtp_sasl_auth_enable = yes",
    `smtp_sasl_password_maps = texthash:${SASL_PASSWD}`,
    "smtp_sasl_security_options = noanonymous",
    "smtp_sasl_tls_security_options = noanonymous",
    "",
    "# Every sender is this host's address; local accounts' mail goes to the mailbox.",
    `sender_canonical_maps = regexp:${MAIL.sender}`,
    `virtual_alias_maps = regexp:${MAIL.recipients}`,
    "",
    "# Cloudflare accepts messages up to 25 MiB.",
    "message_size_limit = 26214400",
    "biff = no",
    "append_dot_mydomain = no",
    "readme_directory = no",
    "",
  ].join("\n");
}

/** This host's mail domain: <host>.<domain>, onboarded for Email Sending in Cloudflare. */
/** This host's internal mail name (myhostname, myorigin): alpha.lab.example.net. Never a sender. */
export const hostMailName = (fleet: FleetDef, host: { name: string }) =>
  `${hostLabel(fleet.mail!, host.name)}.${fleet.mail!.domain}`;

/**
 * Any sender keeps its user, drops any subaddress it had, and gets the host as
 * its subaddress at the onboarded domain: www-data@localhost ->
 * www-data+alpha.lab@example.net. Applying it twice changes nothing.
 */
export function senderMap(fleet: FleetDef, host: HostDef): string {
  const label = hostLabel(fleet.mail!, host.name);
  return `# Rendered by archon from spec ${SPEC}. Do not edit.\n/^([^@+]+)(\\+[^@]*)?(@.*)?$/ \${1}+${label}@${
    fleet.mail!.domain
  }\n`;
}

/**
 * Mail for local accounts (root, ops, a cron MAILTO=user) goes to the fleet's
 * mailbox: addresses on this host's own names only. Real addresses at the
 * sending domain (it may be an organization's own, like example.net) are relayed as written.
 */
export function recipientMap(fleet: FleetDef, host: HostDef): string {
  const m = fleet.mail!;
  const local = [
    "localhost",
    host.name,
    `${host.name}.localdomain`,
    hostMailName(fleet, host),
  ]
    .map(re).join("|");
  return `# Rendered by archon from spec ${SPEC}. Do not edit.\n/^[^@]+@(${local})$/ ${m.to}\n`;
}

export const mail = (): Capability => ({ fleet, host }) => {
  if (!fleet.mail) return { spec: SPEC };
  const file = (path: string, content: string) => ({
    path,
    content,
    mode: "0644",
    owner: "root",
    spec: SPEC,
    onChange: [{ kind: "restart" as const, unit: "postfix.service" }],
  });
  return {
    spec: SPEC,
    packages: [
      {
        name: "postfix",
        // Ubuntu's own installer question: write no configuration; archon's main.cf is the one.
        debconf: ["postfix postfix/main_mailer_type select No configuration"],
        spec: SPEC,
      },
      // The SASL PLAIN and LOGIN mechanisms Postfix's SMTP client uses.
      { name: "libsasl2-modules", spec: SPEC },
    ],
    files: [
      { ...file(MAIL.mainCf, mainCf(fleet, host)), postValidate: ["postfix", "check"] },
      file(MAIL.sender, senderMap(fleet, host)),
      file(MAIL.recipients, recipientMap(fleet, host)),
    ],
    units: [{
      unitName: "postfix.service",
      managed: false,
      state: "enabled",
      verify: "systemctl is-active postfix.service",
      spec: SPEC,
    }],
    checks: [{
      name: "mail:credential",
      // Spec 052: no token yet is "not set up yet" (exit 3), not a problem.
      command: `sh -c 'test -s ${SASL_PASSWD} || exit 3'`,
      level: "warn",
      code: "P027-MAIL-TOKEN",
      fix: "on the boot machine: deno task boot mail-push <host> (after deno task boot mail-setup)",
      spec: SPEC,
    }],
    notes: [
      `Mail from this host (sendmail, localhost:25) goes through Cloudflare Email Service as ${
        senderAddress(fleet.mail, host.name, "<user>")
      }; mail for root and ops goes to ${fleet.mail.to}.`,
    ],
  };
};
