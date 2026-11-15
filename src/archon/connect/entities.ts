/**
 * Spec 085: the normalized entities every source contributes to the estate
 * graph: people (from HR systems), accounts (from identity providers, code
 * hosts, clouds, SaaS), devices (managed, adopted, MDM, SNMP), repositories,
 * resources, and findings. Connectors write them into their observations;
 * the fleet's own machines add theirs. Only what a control needs is kept:
 * names, work email, status and dates, roles. Never compensation or personal
 * fields.
 *
 * @module
 */

/** A person, as the HR system knows them. */
export interface Person {
  /** Work email, lowercase: how people are joined across systems. */
  email: string;
  /** Their name. */
  name?: string;
  /** Employment status. */
  status: "active" | "terminated" | "leave" | "unknown";
  /** Start date (YYYY-MM-DD). */
  start?: string;
  /** End date (YYYY-MM-DD), for a leaver. */
  end?: string;
  /** Their manager's work email. */
  manager?: string;
  /** Employee, contractor, ... */
  type?: string;
}

/** An account in some system. */
export interface Account {
  /** The system it is in (google, okta, github, microsoft, aws, ...). */
  system: string;
  /** Its id there. */
  id: string;
  /** Its login or display name. */
  name: string;
  /** The person's work email, when the system knows it. */
  email?: string;
  /** Whether it can sign in. */
  active: boolean;
  /** Whether it is an administrator there. */
  admin?: boolean;
  /** Whether it has a second factor. */
  mfa?: boolean;
  /** When it last signed in (ISO), when known. */
  lastLogin?: string;
  /** A service or bot account, not a person. */
  service?: boolean;
}

/** A device. */
export interface Device {
  /** Where it is known from (stolos, adopted, snmp, intune, jamf, ...). */
  source: string;
  /** Its id there. */
  id: string;
  /** Its name. */
  name: string;
  /** Its owner's work email (or name), when known. */
  owner?: string;
  /** Its operating system. */
  os?: string;
  /** Its serial number. */
  serial?: string;
  /** Whether its disk is encrypted, when known. */
  encrypted?: boolean;
  /** Whether it is managed (installed and converged), not just observed. */
  managed: boolean;
  /** When it was last seen (ISO). */
  seen?: string;
}

/** A code repository. */
export interface Repository {
  /** The code host (github, gitlab, ...). */
  system: string;
  /** owner/name. */
  name: string;
  /** Whether it is private. */
  private: boolean;
  /** Whether the default branch is protected. */
  protected?: boolean;
  /** How many approving reviews a change needs. */
  reviews?: number;
  /** Whether secret scanning is on. */
  secretScanning?: boolean;
  /** Whether dependency alerts are on. */
  dependencyAlerts?: boolean;
}

/** Everything one source contributed. */
export interface Entities {
  /** People. */
  people?: Person[];
  /** Accounts. */
  accounts?: Account[];
  /** Devices. */
  devices?: Device[];
  /** Repositories. */
  repositories?: Repository[];
}

/** An email, normalized for joining. */
export function emailKey(e?: string): string | undefined {
  const s = (e ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : undefined;
}
