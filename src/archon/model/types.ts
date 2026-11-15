/**
 * The Archon model (spec 002): a fleet with one shared identity and one file
 * per host. Capabilities contribute packages, files, units, and the rest to a
 * host's plan. TypeScript types plus validate.ts are the whole validation
 * story (Article 10); RDF is only an export.
 *
 * @module
 */

import type { SiteDef } from "./site.ts";
import type { CadenceOverrides } from "../compliance/freshness.ts";
import type { ComplianceGate } from "../compliance/impact.ts";

/** The site network model (spec 028), re-exported for the fleet types that use it. */
export type {
  BRAND,
  Brand,
  Cidr,
  Device,
  FirewallPolicy,
  IPv4,
  LocalDnsRecord,
  Port,
  SiteDef,
  SiteNetwork,
  VlanId,
  WifiNetwork,
  Zone,
} from "./site.ts";

/** A spec's folder name, `NNN-short-name` (for example `"051-machine-identity"`): why something exists. */
export type SpecId = `${number}-${string}`;

/** Tiers an agent may be given over MCP (spec 030); never destructive. */
export type McpTier = "read" | "repo" | "mutate";

/**
 * What a person does on a host (spec 012): "standard" (uses it), "developer"
 * (builds on it), "operator" (runs it). A user's personas decide their groups
 * and tools.
 */
export type PersonaId = "standard" | "developer" | "operator";

/** A persona's definition: what it means and what it brings (spec 012). */
export interface Persona {
  /** Its id. */
  id: PersonaId;
  /** Its name, for people. */
  label: string;
  /** What it means, in one sentence. */
  definition: string;
  /** Personas it includes (an operator is also a developer). */
  implies: PersonaId[];
  /** Linux groups it adds. */
  groups: string[];
  /** What it turns on. */
  features: {
    /** fish as the login shell. */
    fish: boolean;
    /** tmux, configured. */
    tmux: boolean;
    /** The developer tools. */
    devTools: boolean;
  };
}

/** A GitHub account as `gh` reports it (spec 003). Public data only. */
export interface GitHubIdentity {
  /** The GitHub login. */
  login: string;
  /** GitHub's numeric account id (it never changes, unlike the login). */
  id: number;
  /** Profile name, or the login when the profile has none. */
  name: string;
  /** GitHub's anonymized commit address: `<id>+<login>@users.noreply.github.com`. */
  email: string;
  /** Public SSH keys from `https://github.com/<login>.keys`. */
  sshKeys: string[];
}

/** A person's account on a host (spec 012): the fleet admin, or one of a host's extra users. */
export interface UserDef {
  /** The Unix account name. */
  name: string;
  /** A fixed UID, the same on every host (default: assigned by Ubuntu). */
  uid?: number;
  /** The person's name (GECOS). */
  fullName: string;
  /** Their address, for git and notifications. */
  email?: string;
  /** What they do here: their groups and tools follow. */
  personas: PersonaId[];
  /** In the sudo group. */
  admin: boolean;
  /** The public SSH keys that may log in as them. */
  sshKeys: string[];
  /** The spec that brought them. */
  spec: SpecId;
}

/**
 * Who may approve changes to a fleet (spec 047, Article 9): a host applies only
 * a tip of main signed by one of these keys. Kept in fleets/<id>/signers.ts,
 * written by `stolos signers`.
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

/**
 * The fleet: one identity shared by every host (spec 003), in
 * `fleets/<id>/fleet.ts` of a fleet repository. `stolos fleet init <id>`
 * writes the first one from your GitHub account; edit it freely after, then
 * `stolos build`.
 *
 * ```mermaid
 * classDiagram
 *   FleetDef "1" --> "*" HostDef : fleets/id/hosts/
 *   FleetDef --> ProvidersDef : providers
 *   FleetDef --> SignerDef : signers.ts
 *   HostDef --> HostRegistration : registration.ts
 *   HostDef --> HostDecisions : decisions.ts
 *   HostDef --> Capability : capabilities
 * ```
 *
 * @example A fleet with mail and HTTPS, like a real one
 * ```ts
 * import type { FleetDef } from "@intellectual-frontiers/stolos/archon/model/types";
 *
 * export const fleet: FleetDef = {
 *   id: "lab",
 *   title: "Example lab fleet",
 *   repository: { slug: "example/fleet", url: "https://github.com/example/fleet" },
 *   ubuntu: { release: "26.04", codename: "resolute" },
 *   timezone: "America/New_York",
 *   locale: "en_US.UTF-8",
 *   keyboard: "us",
 *   providers: { dns: "cloudflare", mail: "cloudflare", acme: "letsencrypt" },
 *   mail: { to: "fleet@example.net", domain: "example.net", tag: "lab" },
 *   web: { domain: "lab.example.net" },
 *   admin: {
 *     user: "alice",
 *     uid: 1000,
 *     github: {
 *       login: "alice",
 *       id: 1000001,
 *       name: "Alice Example",
 *       email: "1000001+alice@users.noreply.github.com",
 *       sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGUtbGFiLWtleS1ub3QtYS1yZWFsLWtleS0wMQ"],
 *     },
 *   },
 * };
 * ```
 */
export interface FleetDef {
  /** The fleet's id: its folder, fleets/<id>/, and a DNS label (lowercase, digits, hyphens). */
  id: string;
  /** Its name, for people. */
  title: string;
  /** The GitHub repository hosts converge to; `branch` defaults to main (tests use their own). */
  repository: { slug: string; url: string; branch?: string };
  /** The Ubuntu release every host runs (point: a point release's image, when pinned). */
  ubuntu: { release: "26.04"; codename: "resolute"; point?: string };
  /** An IANA time zone, for example "America/New_York". */
  timezone: string;
  /** For example "en_US.UTF-8". */
  locale: string;
  /** The console's keyboard layout, for example "us". */
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
  /**
   * The estate graph (spec 090). `personSources`: the connectors that may
   * create people, in order; the first one connected is the source of truth
   * and the others only link to its people. Default: bamboohr, rippling,
   * gusto, deel, justworks, okta, jumpcloud, microsoft, google (HR systems,
   * then identity providers).
   *
   * `exports` (spec 092): export jobs, each for some of the estate's tenants,
   * delivered to the fleet's OpenTelemetry collector, else to a file on this
   * PC, and emailed (send-only, S/MIME) to its own recipients, on its own
   * schedule. See ExportJobDef.
   */
  estate?: { personSources?: string[]; exports?: ExportJobDef[] };
  /**
   * Compliance (spec 073). `cadence`: how often each source of evidence is
   * observed and how late it may be before it is stale (a failing check,
   * SCF MON-02). Default: managed servers every 15 minutes, everything else
   * daily, each stale after twice its cadence, never more than 7 days.
   *
   * `gate` (spec 074): whether a change that weakens a control may be
   * committed (`stolos apply`) or merged (the pull request's check):
   * `{ block: "weakens" }` refuses one unless `allow` names it, an accepted
   * risk (`impact/<key>` in controls/accepted.ts) covers it, or a commit
   * signed by a fleet signer approves it (`Compliance-Approved: <key>`).
   * Default: never block, only show.
   */
  compliance?: { cadence?: CadenceOverrides; gate?: ComplianceGate };
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

/** The kinds of export document (spec 092). */
export type ExportKind = "oscal" | "ocsf" | "otlp" | "cyclonedx" | "in-toto";

/**
 * One export job (spec 092): which documents, for which tenants, to whom, and
 * when. Delivery: to the fleet's OpenTelemetry collector (OTLP/HTTP,
 * `telemetry.collector`) when one is configured, otherwise to a file in this
 * PC's state directory; with `email`, the files are also mailed, encrypted to
 * each recipient's certificate. Nothing secret is in a job: the sending
 * credential stays in this PC's secrets folder.
 *
 * @example An auditor's monthly OSCAL, and a cloud tenant's daily inventory
 * ```ts
 * import type { ExportJobDef } from "@intellectual-frontiers/stolos/archon/model/types";
 *
 * export const exports: ExportJobDef[] = [
 *   {
 *     id: "auditor",
 *     kinds: ["oscal"],
 *     tenants: ["fleet:lab"],
 *     email: {
 *       to: [{ address: "auditor@example.com", certificate: "certs/auditor.pem" }],
 *     },
 *     schedule: { every: "monthly", at: "06:10", dayOfMonth: 1 },
 *   },
 *   { id: "aws-inventory", kinds: ["cyclonedx"], tenants: ["aws:*"], schedule: { every: "daily" } },
 * ];
 * ```
 */
export interface ExportJobDef {
  /** Its id, a DNS label: names the scheduled job and its folder (`stolos export run <id>`). */
  id: string;
  /** What it is for, in one line. */
  title?: string;
  /** The documents to export. */
  kinds: ExportKind[];
  /**
   * The tenants it covers, by uid (`<connector>:<account>`, as in the estate
   * graph: `fleet:<fleet>`, `aws:123456789012`); a trailing `*` matches a
   * prefix (`aws:*`). Default: every tenant.
   */
  tenants?: string[];
  /** Send to the fleet's OpenTelemetry collector when one is configured (default true). */
  otlp?: boolean;
  /** Also email the files (send-only, each copy encrypted to its recipient). */
  email?: ExportEmailDef;
  /** When it runs by itself (`stolos export schedule <id>` creates the OS's own job). */
  schedule?: ExportScheduleDef;
}

/** Where a job's files are emailed, and how they are sent (spec 092). */
export interface ExportEmailDef {
  /** The recipients; each gets their own copy, encrypted to their certificate only. */
  to: ExportRecipientDef[];
  /**
   * The sender: a whole address, or a local part on `fleet.mail.domain`.
   * Default: `exports+<pc>.<tag>@<fleet.mail.domain>`.
   */
  from?: string;
  /** host:port of the SMTP relay (default `fleet.mail.relay`, else Cloudflare's, port 465). */
  relay?: string;
  /**
   * A separate send-only credential on this PC, by name (`stolos export
   * credential <name>`), for a tenant that sends through its own account.
   * Default: the fleet's (`stolos boot mail-setup`).
   */
  credential?: string;
  /** The subject (it is not encrypted, so keep it plain). Default: "[Stolos] <fleet> export <id>". */
  subject?: string;
}

/** One recipient of emailed exports and their public certificate (spec 092). */
export interface ExportRecipientDef {
  /** Their email address. */
  address: string;
  /**
   * Their S/MIME certificate (X.509, RSA, PEM): a path relative to the fleet's
   * folder (`fleets/<id>/certs/auditor.pem`), or the PEM text itself. It is
   * public; the private key never leaves the recipient.
   */
  certificate: string;
}

/** When an export job runs (spec 092), in the PC's local time. */
export interface ExportScheduleDef {
  /** How often. */
  every: "hourly" | "daily" | "weekly" | "monthly";
  /** HH:MM, 24-hour, local time (hourly uses only the minute). Default "02:17". */
  at?: string;
  /** For weekly: the day (default "mon"). */
  weekday?: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
  /** For monthly: the day of the month, 1 to 28 (default 1). */
  dayOfMonth?: number;
}

/** An app's own Linux account (spec 039). */
export interface ServiceDef {
  /** s-<app>: lowercase letters, digits, and dashes. */
  name: string;
  /** Fixed, so the account is the same on every server: 800 to 899. */
  uid: number;
  /** Its purpose, in one line. */
  description: string;
}

/** HTTPS for every server (spec 032): names under one domain, certificates from Let's Encrypt. */
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
 * <name>.<host>.<domain> (who reaches it is the router's decision).
 */
export interface WebRoute {
  /** A DNS label: the app's subdomain. */
  name: string;
  /** The backend's port. */
  port: number;
  /** The backend's address (default 127.0.0.1). */
  address?: string;
  /** The backend speaks HTTPS (certificate not checked; loopback or guests only). */
  https?: boolean;
  /** What it is, in one line (shown on the server's welcome page). */
  description?: string;
  /** The spec that publishes it. */
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
  /** Directories to archive. */
  paths: string[];
  /** How many archives to keep (the oldest go first). */
  keep: number;
  /** When to run (systemd OnCalendar syntax, for example "daily"). */
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
  /** The guest's name (an LXD instance name). */
  name: string;
  /** A system container, or a virtual machine. */
  kind: "container" | "vm";
  /** LXD image, for example "ubuntu:26.04". */
  image: string;
  /** CPU cores (default: LXD's). */
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

/**
 * A host: one machine of the fleet, in `fleets/<id>/hosts/<name>/host.ts`.
 * `stolos host add <name> --claim` (or `--mac-address`) writes a server's;
 * `stolos workstation add` a workstation's. What it gets comes from its
 * capabilities; what it is (its MAC, its SSH host keys) is in its
 * registration.ts, from the machine itself (spec 051).
 *
 * @example A server, as host add writes it
 * ```ts
 * import type { HostDef } from "@intellectual-frontiers/stolos/archon/model/types";
 * import { foundation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";
 *
 * export const host: HostDef = {
 *   name: "alpha",
 *   arch: "amd64",
 *   disk: { match: "largest", layout: "lvm" },
 *   capabilities: foundation(),
 *   spec: "004-install",
 * };
 * ```
 */
export interface HostDef {
  /** Its name: a DNS label, unique in the fleet. */
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
   * VS Code is installed only here; set by `stolos workstation add`.
   */
  desktop?: boolean;
  /**
   * Optional, and no longer written by archon: the NIC the host network-boots
   * from (lowercase, colon-separated). Since spec 051 the MAC lives in
   * registration.ts, given with --mac-address or reported by the machine; a
   * mac here is still read. Without either, the host is recognized by a
   * claim or its own Boot URI (/boot/<name>/bootx64.efi).
   */
  mac?: string;
  /** The CPU architecture (amd64 only, for now). */
  arch: "amd64";
  /** Servers: the install disk (default: Ubuntu's LVM layout on the largest disk). */
  disk?: DiskDef;
  /** Extra accounts beyond the fleet admin and ops. */
  users?: UserDef[];
  /** What it gets: `foundation()` for a server, `workstation()` for a workstation, plus any more. */
  capabilities: Capability[];
  /** LXD containers and VMs (spec 017). */
  guests?: GuestDef[];
  /** Overrides of the default backup policy (spec 016). */
  backup?: Partial<BackupDef>;
  /** Overrides of the fleet's local observability limits (spec 021). */
  observability?: Partial<ObservabilityDef>;
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
  /** Out-of-band management (Intel AMT): its address and notes, for the person at the console. */
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
  /** The spec that brought it (for a host, usually "004-install"). */
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
  /** The database's name. */
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
  /** The instance's name (a Debian cluster name): "prime" is the default one. */
  name: string;
  /** Major version (default 18, Ubuntu's). */
  version?: number;
  /** Fixed port (default: the first free from 5432, then kept). */
  port?: number;
  /** Shown in the psql prompt: production, staging, development... (default production). */
  environment?: string;
  /** psql turns AUTOCOMMIT off and warns in red (default true for production). */
  protected?: boolean;
  /** The databases in it, and who may use each. */
  databases?: PgDatabaseDef[];
}

/** One instance as recorded on the host (the host's own archon.sql (opt-in pg)). */
export interface PgRecord {
  /** Its major version. */
  version: number;
  /** The port it listens on. */
  port: number;
  /** ISO time and who: Archon owns only clusters it created (FR-003). */
  created: string;
  /** Who created it. */
  by: string;
  /** Shown in the psql prompt. */
  environment?: string;
  /** psql turns AUTOCOMMIT off and warns in red. */
  protected?: boolean;
  /**
   * Published: reachable on the server's address over TLS (scram-sha-256). From
   * anywhere the router lets through (the machine restricts no network).
   */
  published?: { at: string; by: string };
  /** Older clusters kept, stopped, after an upgrade (removed with archon pg remove --version). */
  retired?: number[];
}

/**
 * Article 23 (spec 044): data that can come from end users is either durable
 * (it exists nowhere else) or ephemeral (losing it is harmless).
 */
export type DataClass = "durable" | "ephemeral";

/** An operator's decision about an opt-in service or container (spec 040). */
export interface OptInRecord {
  /** On or off. */
  enabled: boolean;
  /** Who decided (a Unix account). */
  by: string;
  /** When (ISO time). */
  at: string;
  /** For an opt-in that holds end users' data: the operator's choice (spec 044). */
  data?: DataClass;
}

/**
 * Who a host is, in Git (spec 047): fleets/<id>/hosts/<host>/registration.ts,
 * written by `stolos host add`. Public facts only: its SSH host public keys
 * (operators' known_hosts is generated from them), its network card, and the
 * fingerprint of its read-only deploy key.
 */
export interface HostRegistration {
  /** "ssh-ed25519 AAAA...", "ecdsa-sha2-nistp256 AAAA...", "ssh-rsa AAAA..." (no comments). */
  sshHostKeys: string[];
  /** The network card it is recognized by when it network-boots (spec 051). */
  mac?: string;
  /**
   * Where that MAC came from (spec 051): "operator", given with
   * --mac-address; "installed", reported by the machine itself when it
   * installed (or was bootstrapped). Only a machine that installed as this
   * host is reinstalled without the blank-disk guard.
   */
  macSource?: "operator" | "installed";
  /** SHA256:... of its deploy key, when it has one. */
  deployKey?: string;
  /** When it was registered (ISO date). */
  added: string;
}

/**
 * What operators decided for a host, in Git (spec 047): fleets/<id>/hosts/<host>/decisions.ts,
 * written by `stolos decide`. A decision here wins over the host's own record.
 */
export interface HostDecisions {
  /** What operators decided in Git (decisions.ts): opt-in name to its record. */
  optIns?: Record<string, OptInRecord>;
}

/** the host's own archon.sql (opt-in pg): the opt-in switch (spec 040) and the instances Archon made. */
export interface PgState extends Partial<OptInRecord> {
  /** Each instance Archon created, by name. */
  instances: Record<string, PgRecord>;
}

/** What to do when a file changed: reload systemd, restart or reload a unit, or run a command. */
export type Action =
  | { kind: "daemon-reload" }
  | { kind: "restart"; unit: string }
  | { kind: "reload-or-restart"; unit: string }
  | { kind: "run"; argv: string[]; asUser?: string; ifExists?: string };

/** A file Archon keeps on a host: its content, owner, and mode, checked before and after it is put in place. */
export interface FileDef {
  /** Its absolute path on the host. */
  path: string;
  /** Its content (absent for a symlink). */
  content?: string;
  /** Make it a symlink to this target instead. */
  symlink?: string;
  /** Its mode, for example "0644". */
  mode: string;
  /** Its owner (a Unix account). */
  owner: string;
  /** Its group (default: the owner's). */
  group?: string;
  /** The spec that writes it. */
  spec: SpecId;
  /** A command that checks the new content before it is put in place (the file's path appended). */
  validate?: string[];
  /** A command that checks it after it is in place (rolled back when it fails). */
  postValidate?: string[];
  /** What to do when it changed: reload, restart, run. */
  onChange?: Action[];
}

/** A systemd unit Archon manages: its file (when Archon writes it), and whether it is enabled, started, or masked. */
export interface UnitDef {
  /** The systemd unit's name, for example "archon-web.service". */
  unitName: string;
  /** Archon writes the unit file (true) or only enables, starts, or masks Ubuntu's own (false). */
  managed: boolean;
  /** The unit file's content, when Archon writes it. */
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
  /** Start it now, not only at the next boot. */
  start?: boolean;
  /** The command that checks it (exit 0: fine). */
  verify: string;
  /** The spec that brings it. */
  spec: SpecId;
  /** For a timer: when it fires (systemd OnCalendar syntax). */
  onCalendar?: string;
}

/** A package to install, from Ubuntu's apt (default), a PPA, a vendor repository, or a snap. */
export interface PackageDef {
  /** The package's name. */
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
  /** The spec that installs it. */
  spec: SpecId;
}

/**
 * A vendor's official apt repository (spec 010): its signing key is pinned in
 * this repository and the source is written in deb822 form. Kept current by
 * unattended-upgrades through `site`.
 */
export interface AptRepoDef {
  /** Its id: names the source file and the key (for example "vscode"). */
  id: string;
  /** The repository's URL. */
  uri: string;
  /** Its suites, for example "stable". */
  suites: string;
  /** Its components, for example "main". */
  components: string;
  /** ASCII-armored public key, pinned (Article 12). */
  key: string;
  /** The repository's host, for unattended-upgrades' Origins-Pattern (site=...). */
  site: string;
  /** The spec that adds it. */
  spec: SpecId;
}

/** A port opened in the host's firewall (ufw). */
export interface PortDef {
  /** The port number. */
  port: number;
  /** tcp or udp. */
  protocol: "tcp" | "udp";
  /** The spec that opens it. */
  spec: SpecId;
}

/** Where an upstream tool's releases come from (GitHub releases, each asset checked against GitHub's SHA-256). */
export interface GitHubSource {
  /** The GitHub repository, "owner/name". */
  repo: string;
  /** The release asset's file name, for this architecture and version. */
  asset: (arch: "amd64", version: string) => RegExp;
  /** What precedes the version in its tags (for example "v"). */
  tagPrefix?: string;
}

/** A tool installed at its newest release (spec 010): from apt, a snap, an upstream binary (checked, smoke-tested, rolled back on failure), or its own installer. */
export interface ToolDef {
  /** Its id (also its folder under /opt/tools). */
  id: string;
  /** Its name, for people. */
  name: string;
  /** Where it comes from: Ubuntu's apt, a snap, an upstream release binary, or its own installer (which then updates itself). */
  source: "apt" | "snap" | "upstream-binary" | "self-updating";
  /** The commands it provides, linked into /usr/local/bin. */
  bins: string[];
  /** The command that prints its version. */
  versionCommand: string;
  /** The command that checks it works (its smoke test after an install, and a verify check). */
  verify: string;
  /** The spec that brings it. */
  spec: SpecId;
  /** Where upstream releases come from (upstream-binary tools). */
  github?: GitHubSource;
  /** The apt package, when it is not the id. */
  package?: string;
  /** apt tools: the maintainers' PPA with newer builds (PackageDef.ppa). */
  ppa?: string;
  /** apt tools: the vendor's own apt repository (PackageDef.repo). */
  repo?: AptRepoDef;
  /** Services restarted after this tool is installed or upgraded (for example its own daemon). */
  restarts?: string[];
  /** Only for users with this persona. */
  forPersona?: PersonaId;
  /** Installed on workstations only (the agent layer, spec 030), never on servers. */
  workstationOnly?: true;
  /** Installed on servers only (the HTTPS front door, spec 032). */
  serverOnly?: true;
  /**
   * The tool refuses to run as root (Steampipe): its smoke test and its verify
   * check run as nobody when archon runs as root.
   */
  unprivileged?: true;
  /** The URL of its own installer script (self-updating tools). */
  installer?: string;
}

/**
 * A verification the model declares (Article 15). "warn" checks report a
 * warning with their fix and never count as a failure (installed.json stays ok).
 */
export interface CheckDef {
  /** The check's name, shown in verify (for example "mail:credential"). */
  name: string;
  /** Run without a shell (splitArgs); use `sh -c '...'` for pipes. Exit 0 means pass. */
  command: string;
  /** "fail": a failure fails verify; "warn": reported with its fix, never a failure. */
  level: "fail" | "warn";
  /** How to fix it, in one line (shown under the problem). */
  fix?: string;
  /** Spec 052: archon explain <code>. Exit 3 from the command means "not set up yet". */
  code?: string;
  /** The spec that declares it. */
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

/** What one capability adds to a host's plan. */
export interface Contribution {
  /** The spec it comes from. */
  spec: SpecId;
  /** Packages to install. */
  packages?: PackageDef[];
  /** Checks verify runs. */
  checks?: CheckDef[];
  /** systemd units to write, enable, start, or mask. */
  units?: UnitDef[];
  /** Files to write. */
  files?: FileDef[];
  /** Ports to open in the firewall. */
  ports?: PortDef[];
  /** Tools to install at their newest releases. */
  tools?: ToolDef[];
  /** Vendor apt repositories to add. */
  aptRepos?: AptRepoDef[];
  /** Services published through the proxy (spec 032). */
  routes?: WebRoute[];
  /** Notes for people (shown by archon guide). */
  notes?: string[];
  /** Files computed from the whole plan (for example the firewall from all ports). */
  derive?: (plan: HostPlan) => FileDef[];
}

/** What a capability is given: the host, its fleet, and the people with accounts on it. */
export interface CapabilityContext {
  /** The host being planned. */
  host: HostDef;
  /** Its fleet. */
  fleet: FleetDef;
  /** Every account on it (the admin, ops, and the host's users). */
  users: UserDef[];
}

/**
 * Something a host gets (spec 002): a function from the host, its fleet, and
 * its users to what it contributes to the host's plan (packages, files, units,
 * ports, checks, tools). `foundation()` is every server's set; a host lists
 * more in its `capabilities`.
 */
export type Capability = (ctx: CapabilityContext) => Contribution;

/** Everything a host gets: every capability's contribution, merged, for apply and verify. */
export interface HostPlan {
  /** The host. */
  host: HostDef;
  /** Its fleet. */
  fleet: FleetDef;
  /** Every account on it. */
  users: UserDef[];
  /** Every package, from every capability. */
  packages: PackageDef[];
  /** Every unit. */
  units: UnitDef[];
  /** Every file. */
  files: FileDef[];
  /** Every open port. */
  ports: PortDef[];
  /** Every tool. */
  tools: ToolDef[];
  /** Every vendor apt repository. */
  aptRepos: AptRepoDef[];
  /** Every check. */
  checks: CheckDef[];
  /** Every service published through the proxy. */
  routes: WebRoute[];
  /** Notes, by spec. */
  notes: Record<string, string[]>;
  /** The specs its capabilities come from. */
  specsUsed: SpecId[];
}
