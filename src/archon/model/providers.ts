/**
 * The fleet's outside providers as explicit choices (spec 046). Each is a
 * closed set: the engine implements exactly these, so a typo or an
 * unsupported provider fails `stolos build` (TypeScript), not a host.
 *
 * @module
 */

import type { FleetDef, ProvidersDef } from "./types.ts";

/** The providers a fleet gets when it names none: Cloudflare for DNS and mail, Let's Encrypt for certificates. */
export const DEFAULT_PROVIDERS: ProvidersDef = {
  dns: "cloudflare",
  mail: "cloudflare",
  acme: "letsencrypt",
};

/** The fleet's providers, with the defaults filled in. */
export function providersOf(fleet: Pick<FleetDef, "providers">): ProvidersDef {
  return { ...DEFAULT_PROVIDERS, ...fleet.providers };
}

/** Each ACME provider's directory (RFC 8555). */
export const ACME_DIRECTORIES: Record<ProvidersDef["acme"], string> = {
  "letsencrypt": "https://acme-v02.api.letsencrypt.org/directory",
  // Untrusted certificates with generous rate limits: for test fleets (synthetic, UAT).
  "letsencrypt-staging": "https://acme-staging-v02.api.letsencrypt.org/directory",
};

/**
 * Names reserved for documentation and tests (RFC 2606, RFC 6761): example.com,
 * example.net, example.org, and the .test, .example, .invalid, .localhost
 * domains. No provider can hold them, so a synthetic fleet uses them and the
 * checks that ask the outside world about a domain skip them.
 */
export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");
  return /(^|\.)example\.(com|net|org)$/.test(d) ||
    /(^|\.)(test|example|invalid|localhost)$/.test(d);
}
