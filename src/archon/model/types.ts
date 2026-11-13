// The Archon model (spec 002): a fleet with one shared identity and one file
// per host. Capabilities contribute packages, files, units, and the rest to a
// host's plan. TypeScript types plus validate.ts are the whole validation
// story (Article 10); RDF is only an export.

import type { SiteDef } from "./site.ts";

export type SpecId = `${number}-${string}`;

/** Tiers an agent may be given over MCP (spec 030); never destructive. */
export type McpTier = "read" | "repo" | "mutate";

export type PersonaId = "standard" | "developer" | "operator";

export interface Persona {
  id: PersonaId;
  label: string;
  definition: string;
  implies: PersonaId[];
  groups: string[];
  features: {
    fish: boolean;
    tmux: boolean;
    devTools: boolean;
  };
}

/** A GitHub account as `gh` reports it (spec 003). Public data only. */
export interface GitHubIdentity {
  login: string;
  id: number;
  /** Profile name, or the login when the profile has none. */
  name: string;
  /** GitHub's anonymized commit address: `<id>+<login>@users.noreply.github.com`. */
  email: string;
  /** Public SSH keys from `https://github.com/<login>.keys`. */
  sshKeys: string[];
}

export interface UserDef {
  name: string;
  uid?: number;
  fullName: string;
  email?: string;
  personas: PersonaId[];
  admin: boolean;
  sshKeys: string[];
  spec: SpecId;
}

/**
 * Who may approve changes to a fleet (spec 047, Article 9): a host applies only
 * a tip of main signed by one of these keys. Kept in fleets/<id>/signers.ts,
 * written by `archon signers`.
 */
export interface SignerDef {
  /** A short name, the principal in allowed_signers ("alice-daily"). */
  name: string;
  /** daily: approves changes; recovery: kept offline, replaces a lost or stolen daily key. */
  role: "daily" | "recovery";
  /** The public key: "ssh-ed25519 AAAA..." (or sk-ssh-ed25519@openssh.com). */
  key: string;
  /** When it was added (ISO date). */
  added: string;
}

/**
 * The fleet's outside providers (spec 046), each a closed set the engine
 * implements. Defaults: Cloudflare for DNS and mail, Let's Encrypt for ACME.
 */
export interface ProvidersDef {
  /** DNS: each server's records and the ACME DNS challenge (spec 032). */
  dns: "cloudflare";
  /** Outbound mail: the SMTP relay (Cloudflare Email Service, spec 027). */
  mail: "cloudflare";
  /**
   * Certificates (spec 032). "letsencrypt-staging" gives untrusted certificates
   * with generous rate limits: for synthetic and test fleets.
   */
  acme: "letsencrypt" | "letsencrypt-staging";
}

export interface FleetDef {
  id: string;
  title: string;
  /** The GitHub repository hosts converge to; `branch` defaults to main (tests use their own). */
  repository: { slug: string; url: string; branch?: string };
  ubuntu: { release: "26.04"; codename: "resolute"; point?: string };
  timezone: string;
  locale: string;
  keyboard: string;
  /** DNS, mail, and ACME providers (spec 046); see ProvidersDef for the defaults. */
  providers?: Partial<ProvidersDef>;
  /** Who may approve changes (spec 047): loaded from fleets/<id>/signers.ts. */
  signers?: SignerDef[];
  /** The fleet's admin: one person, one account on every host (spec 003). */
  admin: { user: string; uid: number; github: GitHubIdentity };
  /**
   * The agent layer (spec 030, Article 17): workstations reach each server as
   * ops over SSH, forced to `archon mcp --max-tier <maxTier>`. Default: tier
   * mutate, the admin's GitHub SSH keys. The destructive tier is never served.
   */
  mcp?: { maxTier?: McpTier; keys?: string[] };
  /**
   * SSH (spec 007): networks (CIDR) from which passwords are accepted as well as
   * keys. Default: the private ranges (your LAN and VLANs). [] means keys only.
   */
  ssh?: { passwordFrom?: string[] };
  /** Local observability limits for every host and workstation (spec 021). */
  observability?: Partial<ObservabilityDef>;
  /**
   * Outbound mail (spec 027) and notifications (spec 025). Every server relays
   * its mail (Postfix) through Cloudflare Email Service, from
   * <user>+<host>.<tag>@<domain> (only <domain> onboarded for Email Sending in Cloudflare); mail
   * for local accounts (root, ops) and archon's own messages go to `to`.
   * Without it, no mail leaves and archon notify is not configured.
   */
  mail?: {
    /** The shared mailbox. */
    to: string;
    /** The sending domain, onboarded for Email Sending in Cloudflare. */
    domain: string;
    /**
     * The fleet's tag after the host in each sender's subaddress (RFC 5233):
     * "lab" gives root+alpha.lab@example.net. Default: none
     * (root+alpha@example.net).
     */
    tag?: string;
    /** host:port of the SMTP relay. Default: smtp.mx.cloudflare.net:465. */
    relay?: string;
  };
  /**
   * The fallback network facts (spec 009) for a host that is not on a site
   * network (a workstation). A host on the site takes them from its network.
   */
  network?: Partial<NetworkDef>;
  /** The site's network as data (spec 028, Article 21): fleets/<fleet>/site.ts. */
  site?: SiteDef;
  /**
   * A central OpenTelemetry collector (spec 024). Hosts and workstations look
   * for one every 15 minutes, by unicast DNS only (Article 20): this address,
   * else the name (default "otel.localdomain", a UniFi Local DNS record) on
   * port 4318. Until one answers, everything stays local.
   */
  telemetry?: { collector?: string; name?: string };
  /**
   * HTTPS on every server (spec 032): each answers as <host>.<domain> and its
   * apps as <app>.<host>.<domain>, with one Let's Encrypt certificate per
   * server (the name and its wildcard) through Cloudflare's DNS challenge.
   * Each server keeps its own A records in Cloudflare (private addresses).
   * Without it, servers still answer HTTPS with a self-signed certificate.
   */
  web?: WebFleetDef;
  /**
   * Service accounts for apps, the same on every server (spec 039): Linux
   * system accounts named s-<app>, with fixed UIDs, no password, no shell. An
   * app runs as its account and reaches PostgreSQL as the role of that name.
   */
  services?: ServiceDef[];
}

/** An app's own Linux account (spec 039). */
export interface ServiceDef {
  /** s-<app>: lowercase letters, digits, and dashes. */
  name: string;
  /** Fixed, so the account is the same on every server: 800 to 899. */
  uid: number;
  description: string;
}

export interface WebFleetDef {
  /** The DNS zone suffix servers live under, for example "lab.example.net". */
  domain: string;
  /** The Cloudflare zone that holds it (default: the last two labels, "example.net"). */
  zone?: string;
  /** Let's Encrypt account address (default: fleet.mail.to). */
  acmeEmail?: string;
}

/**
 * A service published through the server's proxy (spec 032) as
 * <name>.<host>.<domain>, from the local networks only.
 */
export interface WebRoute {
  /** A DNS label: the app's subdomain. */
  name: string;
  port: number;
  /** The backend's address (default 127.0.0.1). */
  address?: string;
  /** The backend speaks HTTPS (certificate not checked; loopback or guests only). */
  https?: boolean;
  description?: string;
  spec: SpecId;
}

/** Disk layout handed to Ubuntu's installer (spec 004): Ubuntu's own guided layouts. */
export interface DiskDef {
  /** Device path, or "largest" for the largest disk. */
  match: "largest" | `/dev/${string}`;
  /** Ubuntu's guided layouts; lvm is Ubuntu's default. */
  layout: "lvm" | "direct";
}

/** Backups (spec 016, Article 14): what to archive, where, and how many to keep. */
export interface BackupDef {
  /** Directory the archives go to (default /var/backups/archon, Ubuntu's backup location). */
  target: string;
  paths: string[];
  keep: number;
  onCalendar: string;
}

/**
 * Local observability (spec 021). Every store is ephemeral: each has an age
 * and a size limit, and gives way first when the disk runs low. The limits are
 * upper bounds, not promises.
 */
export interface ObservabilityDef {
  /** PCP metric archives: kept up to this many days... */
  metricsDays: number;
  /** ...and pruned, oldest first, beyond this size (for example "2G"). */
  metricsMaxSize: string;
  /** journald: kept up to this long (journald syntax, for example "3month")... */
  logsRetention: string;
  /** ...in at most this much space (journald also keeps 15% of the disk free). */
  logsMaxSize: string;
  /** Archon's own traces, metrics, and logs (OTLP files): kept up to this many days, 64 MB at most. */
  tracesDays: number;
  /** Below this much free disk (percent), metric archives are pruned regardless of age. */
  minFreePercent: number;
}

/** An LXD instance on a host (spec 017). */
export interface GuestDef {
  name: string;
  kind: "container" | "vm";
  /** LXD image, for example "ubuntu:26.04". */
  image: string;
  cpus?: number;
  /** For example "4GiB". */
  memory?: string;
  /**
   * Required (Article 23, spec 044): "durable" when the guest can hold data
   * that exists nowhere else (backed up with `lxc export` and guarded), or
   * "ephemeral" when losing it is harmless. There is no default.
   */
  data: DataClass;
  /** Publish the guest's web port as <guest>.<host>.<domain> (spec 032). */
  web?: { port: number; https?: boolean };
}

export interface HostDef {
  name: string;
  /**
   * "server" (default): an Ubuntu Server host Archon installs and converges.
   * "workstation" (spec 020): Ubuntu on WSL (or a desktop) where Archon applies
   * only the user-level parts: tools, dotfiles, the archon command.
   */
  kind?: "server" | "workstation";
  /** Workstations: the existing account Archon sets up (default: the fleet admin's name). */
  user?: string;
  /**
   * Workstations (spec 036): a graphical desktop, not WSL or a headless machine.
   * VS Code is installed only here; set by `archon workstation add`.
   */
  desktop?: boolean;
  /**
   * Optional: the NIC the host network-boots from (lowercase, colon-separated).
   * Without it the host is recognized by its own Boot URI
   * (/boot/<name>/bootx64.efi), and the installed system's network matches
   * the NIC it actually booted from (spec 004).
   */
  mac?: string;
  arch: "amd64";
  /** Servers: the install disk (default: Ubuntu's LVM layout on the largest disk). */
  disk?: DiskDef;
  /** Extra accounts beyond the fleet admin and ops. */
  users?: UserDef[];
  capabilities: Capability[];
  /** LXD containers and VMs (spec 017). */
  guests?: GuestDef[];
  /** Overrides of the default backup policy (spec 016). */
  backup?: Partial<BackupDef>;
  /** Overrides of the fleet's local observability limits (spec 021). */
  observability?: Partial<ObservabilityDef>;
  /** Overrides of the fleet's network properties (spec 009). */
  /** The site network it lives on (spec 028), by name: "Servers". Its IPv6 follows that network. */
  network?: string;
  /** Per-host override of the network's IPv6 (spec 009). */
  ipv6?: boolean;
  /** Its fixed address (a UniFi Fixed IP), inside its network (spec 028). */
  ip?: string;
  /** Its unicast DNS name, a UniFi Local DNS record (Article 20): "alpha.localdomain". */
  dnsName?: string;
  /** The switch port it is cabled to: "flex-2.5g/3". */
  switchPort?: string;
  /** Services this server publishes through its proxy (spec 032). */
  web?: { routes?: Array<Omit<WebRoute, "spec">> };
  outOfBand?: { amt?: { address?: string; notes?: string } };
  /** PostgreSQL instances this server keeps (spec 038). */
  pg?: { instances?: PgInstanceDef[] };
  /**
   * What operators recorded on this host (the host's own archon.sql (opt-in pg), spec 038):
   * the clusters Archon created and which are published. Read by loadHosts;
   * never written in a host file.
   */
  pgState?: PgState;
  /**
   * Opt-in services and containers an operator turned on or off (spec 040):
   * this machine's archon.sql<name>.json {enabled, by, at}. Read by loadHosts; never
   * written in a host file. Absent means off.
   */
  optIn?: Record<string, OptInRecord>;
  spec: SpecId;
  /** Who it is, from fleets/<id>/hosts/<host>/registration.ts (spec 047): read by loadHosts. */
  registration?: HostRegistration;
}

/**
 * A database in an instance and who may use it (spec 039). Every name is a
 * Linux account (a person in the model, or a service account s-<app>) or
 * @group (a Linux group's members). PostgreSQL roles are the same names.
 */
export interface PgDatabaseDef {
  name: string;
  /** Owns the database and its public schema (creates tables). */
  owner: string;
  /** Read and write every table (not create). */
  write?: string[];
  /** Read every table. */
  read?: string[];
  /** Extensions Archon creates (as the superuser, for untrusted ones). */
  extensions?: string[];
}

/** A named PostgreSQL instance: one Debian cluster, <version>/<name> (spec 038). */
export interface PgInstanceDef {
  name: string;
  /** Major version (default 18, Ubuntu's). */
  version?: number;
  /** Fixed port (default: the first free from 5432, then kept). */
  port?: number;
  /** Shown in the psql prompt: production, staging, development... (default production). */
  environment?: string;
  /** psql turns AUTOCOMMIT off and warns in red (default true for production). */
  protected?: boolean;
  databases?: PgDatabaseDef[];
}

/** One instance as recorded on the host (the host's own archon.sql (opt-in pg)). */
export interface PgRecord {
  version: number;
  port: number;
  /** ISO time and who: Archon owns only clusters it created (FR-003). */
  created: string;
  by: string;
  environment?: string;
  protected?: boolean;
  /** Published on the local networks at pg-<name>.<host>.<domain>. */
  /**
   * Published: reachable on the server's address over TLS (scram-sha-256). From
   * anywhere the router lets through, unless localOnly (archon pg publish --local-only).
   */
  published?: { at: string; by: string; localOnly?: boolean };
  /** Older clusters kept, stopped, after an upgrade (removed with archon pg remove --version). */
  retired?: number[];
}

/** An operator's decision about an opt-in service or container (spec 040). */
/**
 * Article 23 (spec 044): data that can come from end users is either durable
 * (it exists nowhere else) or ephemeral (losing it is harmless).
 */
export type DataClass = "durable" | "ephemeral";

export interface OptInRecord {
  enabled: boolean;
  by: string;
  at: string;
  /** For an opt-in that holds end users' data: the operator's choice (spec 044). */
  data?: DataClass;
}

/**
 * Who a host is, in Git (spec 047): fleets/<id>/hosts/<host>/registration.ts,
 * written by `archon host add`. Public facts only: its SSH host public keys
 * (operators' known_hosts is generated from them), its network card, and the
 * fingerprint of its read-only deploy key.
 */
export interface HostRegistration {
  /** "ssh-ed25519 AAAA...", "ecdsa-sha2-nistp256 AAAA...", "ssh-rsa AAAA..." (no comments). */
  sshHostKeys: string[];
  mac?: string;
  /** SHA256:... of its deploy key, when it has one. */
  deployKey?: string;
  /** When it was registered (ISO date). */
  added: string;
}

/**
 * What operators decided for a host, in Git (spec 047): fleets/<id>/hosts/<host>/decisions.ts,
 * written by `archon decide`. A decision here wins over the host's own record.
 */
export interface HostDecisions {
  optIns?: Record<string, OptInRecord>;
}

/** the host's own archon.sql (opt-in pg): the opt-in switch (spec 040) and the instances Archon made. */
export interface PgState extends Partial<OptInRecord> {
  instances: Record<string, PgRecord>;
}

export type Action =
  | { kind: "daemon-reload" }
  | { kind: "restart"; unit: string }
  | { kind: "reload-or-restart"; unit: string }
  | { kind: "run"; argv: string[]; asUser?: string; ifExists?: string };

export interface FileDef {
  path: string;
  content?: string;
  symlink?: string;
  mode: string;
  owner: string;
  group?: string;
  spec: SpecId;
  validate?: string[];
  postValidate?: string[];
  onChange?: Action[];
}

export interface UnitDef {
  unitName: string;
  managed: boolean;
  content?: string;
  /** masked: stopped and masked, the package kept (spec 001: avahi-daemon). */
  state: "enabled" | "disabled" | "masked" | "ignore";
  /**
   * An operator's switch (spec 037): the name of a record in
   * this machine's archon.sql<switch>.json. When it says {"enabled": true} the unit is
   * enabled and started; otherwise `state` applies (masked, for SMB).
   */
  switch?: string;
  /**
   * Made by a systemd generator (a Podman Quadlet container, spec 040): it
   * cannot be enabled; its [Install] section starts it at boot unless masked.
   * Turning it on is unmask and start.
   */
  generated?: boolean;
  start?: boolean;
  verify: string;
  spec: SpecId;
  onCalendar?: string;
}

export interface PackageDef {
  name: string;
  /** apt (default) or snap: both are native on Ubuntu (Article 2). */
  source?: "apt" | "snap";
  /**
   * The upstream maintainers' Launchpad PPA ("owner/name") that carries newer
   * builds (Article 5). Added with add-apt-repository, kept current by
   * unattended-upgrades; without builds for this release, Ubuntu's package stays.
   */
  ppa?: string;
  /** A vendor's own apt repository (AptRepoDef.id) that carries this package. */
  repo?: string;
  /**
   * Answers to the package's own install questions, as debconf-set-selections
   * lines ("postfix postfix/main_mailer_type select No configuration"), set
   * before it is installed: Ubuntu's way to install a package unattended.
   */
  debconf?: string[];
  spec: SpecId;
}

/**
 * A vendor's official apt repository (spec 010): its signing key is pinned in
 * this repository and the source is written in deb822 form. Kept current by
 * unattended-upgrades through `site`.
 */
export interface AptRepoDef {
  id: string;
  uri: string;
  suites: string;
  components: string;
  /** ASCII-armored public key, pinned (Article 12). */
  key: string;
  /** The repository's host, for unattended-upgrades' Origins-Pattern (site=...). */
  site: string;
  spec: SpecId;
}

export interface PortDef {
  port: number;
  protocol: "tcp" | "udp";
  /** Only from these networks (CIDR), for example the local networks; default: anywhere. */
  from?: string[];
  spec: SpecId;
}

export interface GitHubSource {
  repo: string;
  asset: (arch: "amd64", version: string) => RegExp;
  tagPrefix?: string;
}

export interface ToolDef {
  id: string;
  name: string;
  source: "apt" | "snap" | "upstream-binary" | "self-updating";
  bins: string[];
  versionCommand: string;
  verify: string;
  spec: SpecId;
  github?: GitHubSource;
  package?: string;
  /** apt tools: the maintainers' PPA with newer builds (PackageDef.ppa). */
  ppa?: string;
  /** apt tools: the vendor's own apt repository (PackageDef.repo). */
  repo?: AptRepoDef;
  /** Services restarted after this tool is installed or upgraded (for example its own daemon). */
  restarts?: string[];
  forPersona?: PersonaId;
  /** Installed on workstations only (the agent layer, spec 030), never on servers. */
  workstationOnly?: true;
  /** Installed on servers only (the HTTPS front door, spec 032). */
  serverOnly?: true;
  installer?: string;
}

/**
 * A verification the model declares (Article 15). "warn" checks report a
 * warning with their fix and never count as a failure (installed.json stays ok).
 */
export interface CheckDef {
  name: string;
  /** Run without a shell (splitArgs); use `sh -c '...'` for pipes. Exit 0 means pass. */
  command: string;
  level: "fail" | "warn";
  fix?: string;
  spec: SpecId;
}

/** The network a host lives on (spec 009). */
export interface NetworkDef {
  /**
   * Does this network route IPv6? false (an IPv4-only LAN): apt resolves and
   * connects over IPv4 only, and retries transient failures.
   */
  ipv6: boolean;
}

export interface Contribution {
  spec: SpecId;
  packages?: PackageDef[];
  checks?: CheckDef[];
  units?: UnitDef[];
  files?: FileDef[];
  ports?: PortDef[];
  tools?: ToolDef[];
  aptRepos?: AptRepoDef[];
  /** Services published through the proxy (spec 032). */
  routes?: WebRoute[];
  notes?: string[];
  /** Files computed from the whole plan (for example the firewall from all ports). */
  derive?: (plan: HostPlan) => FileDef[];
}

export interface CapabilityContext {
  host: HostDef;
  fleet: FleetDef;
  users: UserDef[];
}

export type Capability = (ctx: CapabilityContext) => Contribution;

export interface HostPlan {
  host: HostDef;
  fleet: FleetDef;
  users: UserDef[];
  packages: PackageDef[];
  units: UnitDef[];
  files: FileDef[];
  ports: PortDef[];
  tools: ToolDef[];
  aptRepos: AptRepoDef[];
  checks: CheckDef[];
  routes: WebRoute[];
  notes: Record<string, string[]>;
  specsUsed: SpecId[];
}
