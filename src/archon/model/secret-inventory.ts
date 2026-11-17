/**
 * The secret inventory (spec 028, constitution Article 13): every secret the
 * fleet depends on, by name, where it lives, and how to make it again. Values
 * never. The boot machine's secrets are what `bun run stolos vault` backs up
 * and restores (spec 029); the owner's are listed so a lost one is not a
 * surprise. A test checks that every path the code writes is listed here.
 *
 * @module
 */
// Spec: 028-site-network
// Spec: 029-vault
// Spec: 100-remote-access FR-002
// Spec: 103-three-ports FR-006

/** One secret the fleet depends on: where it lives and how to make it again (never its value). */
export interface SecretRef {
  /** Stable identifier ("deploy-key"). */
  id: string;
  /** Short name for tables and the backup panel; <host> and <type> are filled in. */
  label: string;
  /**
   * Boot machine: the path inside its secrets folder (%APPDATA%\stolos\secrets),
   * with <host>, <type>, and <name> placeholders. Owner: where it is kept.
   */
  path: string;
  /** What it is for, in a sentence. */
  purpose: string;
  /** Who keeps it: the boot machine (backed up by the vault) or the owner. */
  holder: "boot-machine" | "owner";
  /** How to make it again when it is lost (vault status --lost prints this). */
  recreate: string;
  /** Short-lived; never backed up (install tokens). */
  ephemeral?: true;
  /** Identity that cannot be re-made the same: losing it changes what others trust. */
  identity?: true;
  /** The spec that introduced it (`NNN-short-name`). */
  spec: string;
}

/** Every secret the fleet depends on: the boot machine's first, then the owner's. */
export const SECRET_INVENTORY: SecretRef[] = [
  // ------------------------------------------------------------ boot machine
  {
    id: "admin-password-hash",
    label: "admin password hash",
    path: "admin-password.hash",
    purpose: "the fleet admin's password (SHA-512 crypt), set on every host at install",
    holder: "boot-machine",
    recreate:
      "bun run stolos fleet init (keeps fleets/<fleet>/fleet.ts; asks for the password again; the same password keeps the hosts as they are)",
    spec: "003-identity",
  },
  {
    id: "deploy-key",
    label: "<host> deploy key",
    path: "hosts/<host>/deploy_key",
    purpose: "<host>'s GitHub deploy key (pulls and pushes its state as ops)",
    holder: "boot-machine",
    recreate:
      "while the host runs: bun run stolos vault recover-host-keys <host> (the same key comes back); otherwise bun run stolos host add <host> (keeps its model, registers a new key on GitHub), then bun run stolos boot reinstall <host> --confirm-destroy <host>",
    spec: "004-install",
  },
  {
    id: "probe-key",
    label: "<host> probe key",
    path: "adopted/<host>/probe_key",
    purpose:
      "reads facts from the adopted machine <host>: its authorized_keys lets this key run the read-only probe and nothing else (spec 067)",
    holder: "boot-machine",
    recreate:
      "bun run stolos host adopt <host> --ssh <user>@<address> again (it makes a new key and replaces the old line)",
    spec: "067-adopt",
  },
  {
    id: "cloud-credential",
    label: "<provider> read-only credential",
    path: "connectors/<provider>/credential.json",
    purpose:
      "reads one cloud account (cloudflare, microsoft, aws, hetzner) for stolos estate observe: read-only, never changes the cloud (spec 067)",
    holder: "boot-machine",
    recreate:
      "make a new read-only credential in the provider's console; bun run stolos connect <provider>",
    spec: "067-adopt",
  },
  {
    id: "device-snmp",
    label: "<host> SNMPv3 passphrases",
    path: "devices/<host>/snmp.json",
    purpose:
      "read the device <host> over SNMPv3 (authentication and privacy passphrases of a read-only user made on it; spec 069)",
    holder: "boot-machine",
    recreate:
      "make a new read-only SNMPv3 user on the device; bun run stolos device add <host> ... again",
    spec: "069-integrate",
  },
  {
    id: "probe-key-pub",
    label: "<host> probe key (public)",
    path: "adopted/<host>/probe_key.pub",
    purpose: "the probe key's public half (in the adopted machine's authorized_keys)",
    holder: "boot-machine",
    recreate: "made with the probe key",
    spec: "067-adopt",
  },
  {
    id: "deploy-key-pub",
    label: "<host> deploy key (public)",
    path: "hosts/<host>/deploy_key.pub",
    purpose: "the public half of <host>'s deploy key (kept beside it; not secret)",
    holder: "boot-machine",
    recreate: "made again with the deploy key",
    spec: "004-install",
  },
  {
    id: "host-key",
    label: "<host> SSH host key (<type>)",
    path: "hosts/<host>/ssh_host_<type>_key",
    purpose: "<host>'s SSH host key (<type>): its identity across re-installs",
    holder: "boot-machine",
    identity: true,
    recreate:
      "bun run stolos vault recover-host-keys <host> while it runs; otherwise a re-install makes new keys and every client sees a changed host identity",
    spec: "004-install",
  },
  {
    id: "host-key-pub",
    label: "<host> SSH host key (<type>, public)",
    path: "hosts/<host>/ssh_host_<type>_key.pub",
    purpose: "the public half of <host>'s SSH host key (not secret; rebuilds known_hosts)",
    holder: "boot-machine",
    recreate: "recovered with the host key",
    spec: "004-install",
  },
  {
    id: "mail-relay-token",
    label: "mail relay token",
    path: "mail.json",
    purpose: "Cloudflare Email Sending token for the mail relay (Postfix and archon notify)",
    holder: "boot-machine",
    recreate:
      "Cloudflare: create an API token with Email Sending: Edit; bun run stolos boot mail-setup; bun run stolos boot mail-push <host> for each server",
    spec: "027-mail",
  },
  {
    id: "export-mail-token",
    label: "<name> export mail credential",
    path: "mail-<name>.json",
    purpose:
      "a send-only SMTP credential for export jobs that send through their own account (email.credential in estate.exports; spec 092)",
    holder: "boot-machine",
    recreate:
      "make a new send-only credential with the provider (Cloudflare: an API token with only Email Sending: Edit); bun run stolos export credential <name>",
    spec: "092-exporters",
  },
  {
    id: "acme-store",
    label: "<host> Let's Encrypt certificates",
    path: "hosts/<host>/acme.json",
    purpose:
      "<host>'s Let's Encrypt account, certificates, and keys, copied by boot reinstall so the new install serves them at once",
    holder: "boot-machine",
    // A cache: renewed on the server, refreshed by every reinstall, and remade by Let's Encrypt.
    ephemeral: true,
    recreate: "nothing: the server asks Let's Encrypt for a new certificate",
    spec: "032-web",
  },
  {
    id: "web-dns-token",
    label: "Cloudflare DNS token",
    path: "web.json",
    purpose:
      "Cloudflare API token (Zone Read, DNS Edit on the fleet's zone): each server's DNS records and its Let's Encrypt certificate",
    holder: "boot-machine",
    recreate:
      "Cloudflare: create a token with Zone: Read and DNS: Edit for the zone; bun run stolos boot web-setup; bun run stolos boot web-push <host> for each server",
    spec: "032-web",
  },
  {
    id: "console-tls",
    label: "Stolos Console certificate",
    path: "console/tls.json",
    purpose:
      "the Stolos Console's Let's Encrypt certificate, its private key and the ACME account key, for HTTPS on the LAN",
    holder: "boot-machine",
    recreate: "bun run stolos console --lan (it asks Let's Encrypt for a new one)",
    spec: "100-remote-access",
  },
  {
    id: "install-tokens",
    label: "install tokens",
    path: "install-tokens.json",
    purpose: "one-time install tokens for armed hosts, and MACs learned at install",
    holder: "boot-machine",
    ephemeral: true,
    recreate: "bun run stolos boot arm <host> makes a new one when needed",
    spec: "004-install",
  },
  ...[
    [
      "pairing",
      "pairing in progress",
      "the code of a pairing in progress and what the machine and the person said (spec 098)",
    ],
    [
      "pairing-lock",
      "pairing's lock",
      "the lock the processes that serve and ask for a pairing take while they change its record",
    ],
    [
      "pairing-tmp",
      "pairing's new record",
      "the record being written, renamed over the pairing's file at once (atomic)",
    ],
  ].map(([id, label, purpose]): SecretRef => ({
    id: id ?? "",
    label: label ?? "",
    path: `pair/${id}`,
    purpose: `${purpose}: written by stolos pair, read by the doors (the boot server's HTTP, the console's TLS), gone when the pairing session is closed (Ctrl+C)`,
    holder: "boot-machine",
    ephemeral: true,
    recreate: "bun run stolos pair makes a new one",
    spec: "103-three-ports",
  })),

  // ------------------------------------------------------------------- owner
  {
    id: "unifi-backup",
    label: "UniFi backup",
    path: "UniFi: Settings > Management > Backup Files (cloud), and the downloaded .unifi file kept offline",
    purpose: "the whole router configuration, Wi-Fi keys and VPN keys included",
    holder: "owner",
    recreate: "download a fresh backup from the console after any major change",
    spec: "028-site-network",
  },
  {
    id: "wifi-passwords",
    label: "Wi-Fi passwords",
    path: "UniFi WiFi settings (and the UniFi backup); the owner's password manager",
    purpose: "the pre-shared keys of Lab King, Lab IoT, and Example Guest",
    holder: "owner",
    recreate: "UniFi: WiFi > the SSID > change the password; rejoin each device",
    spec: "028-site-network",
  },
  {
    id: "wireguard-keys",
    label: "WireGuard keys",
    path: "UniFi (server key); each client's WireGuard app (client keys)",
    purpose: "Lab WireGuard's server and client keys",
    holder: "owner",
    recreate: "UniFi: VPN > Lab WireGuard: delete and re-add the client; import the new config",
    spec: "028-site-network",
  },
  {
    id: "cloudflare-ddns-token",
    label: "Cloudflare DDNS token",
    path: "UniFi: Dynamic DNS settings on WAN the ISP",
    purpose: "Cloudflare API token (Edit zone DNS, example.net) that keeps lab.example.net current",
    holder: "owner",
    recreate:
      "Cloudflare: create a token with Edit zone DNS for example.net; paste it into UniFi's Dynamic DNS",
    spec: "028-site-network",
  },
  {
    id: "recovery-codes",
    label: "recovery and MFA codes",
    path: "the owner's password manager",
    purpose:
      "recovery and MFA codes for the UniFi account, the Google mailbox, Cloudflare, and the Microsoft account whose OneDrive Personal Vault holds the backup ZIPs",
    holder: "owner",
    recreate: "each service's security settings: generate new recovery codes",
    spec: "028-site-network",
  },
];

/** A path pattern ("hosts/<host>/deploy_key") as a regular expression. */
export function patternOf(path: string): RegExp {
  const esc = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/<host>/g, "(?<host>[a-z0-9-]+)")
    .replace(/<type>/g, "(?<type>[a-z0-9]+)")
    .replace(/<name>/g, "(?<name>[a-z0-9-]+)");
  return new RegExp(`^${esc}$`);
}

/** The entry's label for one file: "hermes deploy key". */
export function labelFor(ref: SecretRef, rel: string): string {
  const g = patternOf(ref.path).exec(rel.replace(/\\/g, "/"))?.groups ?? {};
  return ref.label
    .replace("<host>", g["host"] ?? "<host>")
    .replace("<type>", g["type"] ?? "<type>")
    .replace("<name>", g["name"] ?? "<name>");
}

/** The inventory entry for a path relative to the secrets folder (forward slashes). */
export function secretFor(rel: string): SecretRef | undefined {
  const r = rel.replace(/\\/g, "/");
  return SECRET_INVENTORY.find((s) => s.holder === "boot-machine" && patternOf(s.path).test(r));
}
