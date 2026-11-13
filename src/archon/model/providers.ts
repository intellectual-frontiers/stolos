// The fleet's outside providers as explicit choices (spec 046). Each is a
// closed set: the engine implements exactly these, so a typo or an
// unsupported provider fails `archon build` (TypeScript), not a host.

import type { FleetDef, ProvidersDef } from "./types.ts";

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
