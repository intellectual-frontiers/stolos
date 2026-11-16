/**
 * Spec 084: connectors. Each reads one outside account (a cloud, an identity
 * provider, a code host, an HR system, ...) with a read-only credential kept
 * in the vault, writes what it found to `fleets/<fleet>/estate/<id>.ts`
 * (GENERATED, so `git log -p` is the account's history), and checks posture
 * policies tagged with SCF controls. A connector never changes the account.
 *
 * ```mermaid
 * flowchart LR
 *   vault["Vault: connectors/&lt;id&gt;/credential.json (read only)"] --> observe["stolos estate observe"]
 *   observe -- "HTTPS GET" --> account["the account: a cloud, identity, code, HR, ..."]
 *   observe --> file["fleets/&lt;fleet&gt;/estate/&lt;id&gt;.ts (GENERATED)"]
 *   file --> check["estate check: policies (SCF)"] & assets["estate assets"] & compliance["Compliance"]
 * ```
 *
 * @module
 */
// Spec: 084-connectors

import { formatJson5Error, parseJson5, tsLiteral } from "@intellectual-frontiers/commons/ts/kernel";
import { type http, path } from "@intellectual-frontiers/commons/ts/runtime";
import type { ObservedRecord } from "./sdk.ts";
import { P } from "../core/paths.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Entities } from "./entities.ts";
import type { CadenceDef } from "../compliance/freshness.ts";

/**
 * NIST SP 800-145's cloud service models, the ones FedRAMP uses to describe
 * a cloud service offering.
 */
export const SERVICE_MODELS = ["IaaS", "PaaS", "SaaS"] as const;

/** A NIST SP 800-145 service model. */
export type ServiceModel = (typeof SERVICE_MODELS)[number];

/** A market category, by the name an analyst firm uses for it, and where that name comes from. */
export interface MarketCategory {
  /** A short id. */
  id: string;
  /** The category's name, as published. */
  name: string;
  /** Where the name comes from. */
  source: string;
}

/**
 * The market categories connectors belong to, named as the analyst firms
 * name them (spec 084): never Stolos's own words. Reports are renamed over
 * time; the newest name is used.
 */
export const MARKET_CATEGORIES: MarketCategory[] = [
  {
    id: "strategic-cloud-platform-services",
    name: "Strategic Cloud Platform Services",
    source: "Gartner Magic Quadrant",
  },
  {
    id: "edge-development-platforms",
    name: "Edge Development Platforms",
    source: "Forrester Wave",
  },
  { id: "access-management", name: "Access Management", source: "Gartner Magic Quadrant" },
  {
    id: "identity-governance-administration",
    name: "Identity Governance and Administration",
    source: "Gartner Magic Quadrant",
  },
  { id: "devops-platforms", name: "DevOps Platforms", source: "Gartner Magic Quadrant" },
  { id: "cloud-hcm-suites", name: "Cloud HCM Suites", source: "Gartner Magic Quadrant" },
  {
    id: "unified-endpoint-management",
    name: "Unified Endpoint Management Tools",
    source: "Gartner Magic Quadrant",
  },
  {
    id: "endpoint-protection-platforms",
    name: "Endpoint Protection Platforms",
    source: "Gartner Magic Quadrant",
  },
  {
    id: "it-service-management",
    name: "IT Service Management Platforms",
    source: "Gartner Magic Quadrant",
  },
  {
    id: "enterprise-agile-planning",
    name: "Enterprise Agile Planning Tools",
    source: "Gartner Magic Quadrant",
  },
  {
    id: "workstream-collaboration",
    name: "Workstream Collaboration",
    source: "Gartner Market Guide",
  },
  {
    id: "secrets-management",
    name: "Secrets Management",
    source: "Gartner Hype Cycle for Application Security",
  },
  {
    id: "cnapp",
    name: "Cloud-Native Application Protection Platforms",
    source: "Gartner Market Guide",
  },
  {
    id: "vulnerability-assessment",
    name: "Vulnerability Assessment",
    source: "Gartner Market Guide",
  },
  {
    id: "security-awareness-training",
    name: "Security Awareness Computer-Based Training",
    source: "Gartner Market Guide",
  },
];

/** A market category by id. */
export function marketCategory(id: string): MarketCategory | undefined {
  return MARKET_CATEGORIES.find((m) => m.id === id);
}

/** One thing in an account: a zone, a DNS record, a server, a bucket, a user, ... */
export interface Asset {
  /** What it is: zone, dns-record, worker, r2-bucket, server, s3-bucket, user, ... */
  kind: string;
  /** The provider's id for it. */
  id: string;
  /** Its name for people. */
  name: string;
  /** Where it is (region, location, zone), when that means something. */
  where?: string;
  /** The managed host or adopted machine it belongs to, when Stolos can tell. */
  fleetMachine?: string;
  /** The few facts worth seeing (no secrets: providers never return them to a read-only token). */
  facts?: Record<string, string | number | boolean>;
}

/** What one cloud account holds, as observed. */
export interface Observation {
  /** When (ISO time). */
  at: string;
  /** The provider: cloudflare, microsoft, aws, hetzner. */
  provider: string;
  /** The account (or tenant, or project) for people. */
  account: string;
  /** Everything found. */
  assets: Asset[];
  /** Posture facts the policies read (per provider). */
  posture: Record<string, string | number | boolean>;
  /** What could not be read, and why (a missing permission, usually). */
  gaps: string[];
  /** Spec 085: the people, accounts, devices, and repositories it found, for the estate graph. */
  entities?: Entities;
  /** Spec 089: each record read, as a labeled node with its OCSF class (connectors made with defineConnector). */
  records?: ObservedRecord[];
}

/** A provider: how to connect, what to read, what to check. */
export interface Connector {
  /** Its id (the vault folder and the file name). */
  id: string;
  /** Its NIST SP 800-145 service models (what FedRAMP calls the offering's service model). */
  serviceModels: ServiceModel[];
  /** Its market categories, as the analyst firms name them (ids in MARKET_CATEGORIES). */
  markets: string[];
  /** Its name for people. */
  title: string;
  /** The Simple Icons slug for its logo, or "" when its owner does not allow one there. */
  logo: string;
  /** What to create in the provider's console, step by step: read-only access only. */
  connectHelp: string[];
  /** The quickest way to a read-only credential: a page to open, or a command for the provider's own browser shell. */
  recipe: {
    open?: { href: string; label: string };
    shell?: { where: string; href: string; command: string };
  };
  /** The fields the credential has (one is a token; several make a JSON credential). */
  fields: Array<{
    name: string;
    secret: boolean;
    hint: string;
    /** A file's path is asked for, and the file's content kept (a key file). */
    file?: boolean;
  }>;
  /** Read the account. */
  observe(cred: Record<string, string>, http: http.Transport, now: Date): Promise<Observation>;
  /** Its posture policies. */
  policies(o: Observation, now: number): PolicyResult[];
  /** Spec 073: how often it is observed, when not daily (a fleet may override it). */
  cadence?: CadenceDef;
}

/** Where a provider's credential is in the vault. */
export function connectorCredPath(id: string): string {
  return path.join(P.secrets, "connectors", id, "credential.json");
}

/** Where a provider's observation is in the fleet repository. */
export function observationFile(id: string): string {
  return path.join(P.fleetDir, "estate", `${id}.ts`);
}

/** The observation's TypeScript. */
export function observationSource(o: Observation): string {
  // The observation as JSON is a literal the kernel writes (an undefined property is left out).
  const literal = parseJson5(JSON.stringify(o));
  if (literal.kind === "err") throw new Error(`observation: ${formatJson5Error(literal.error)}`);
  return `// GENERATED by \`stolos estate observe\` (spec 084): what ${o.provider} holds, read with a
// read-only credential. Never edit by hand; \`git log -p\` on this file is the account's history.

import type { Observation } from "@intellectual-frontiers/stolos/archon/connect/connector";

export const observed: Observation = ${tsLiteral(literal.value)};
`;
}

/** A call the credential is not allowed to make: a gap, not a failure. */
export class AccessDenied extends Error {}

/** Run `f`; a denial becomes a gap and `fallback`. */
export async function orGap<T>(
  gaps: string[],
  what: string,
  fallback: T,
  f: () => Promise<T>,
): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AccessDenied) {
      gaps.push(`${what}: ${e.message}`);
      return fallback;
    }
    throw e;
  }
}

/** One posture policy from a boolean (or unknown when the fact is missing). */
export function check(
  o: Observation,
  p: {
    id: string;
    title: string;
    scf: string[];
    fact: string;
    want: (v: unknown) => boolean;
    fix: string;
    warnOnly?: boolean;
    show?: (v: string | number | boolean) => string;
  },
): PolicyResult {
  const v = o.posture[p.fact];
  const status = v === undefined ? "unknown" : p.want(v) ? "pass" : p.warnOnly ? "warn" : "fail";
  return {
    id: p.id,
    title: p.title,
    scf: p.scf,
    status,
    detail:
      v === undefined
        ? "not readable with this credential"
        : p.show
          ? p.show(v)
          : typeof v === "boolean"
            ? v
              ? "yes"
              : "no"
            : String(v),
    fix: p.fix,
  };
}

/** The observed-recently policy every provider has. */
export function fresh(o: Observation, now: number, id: string): PolicyResult {
  const days = (now - Date.parse(o.at)) / 86_400_000;
  return {
    id: "observed",
    title: "Observed in the last 7 days",
    scf: ["AST-04", "MON-02"],
    status: days <= 7 ? "pass" : "fail",
    detail: `last observed ${o.at.slice(0, 10)}`,
    fix: `bun run stolos estate observe ${id}`,
  };
}
