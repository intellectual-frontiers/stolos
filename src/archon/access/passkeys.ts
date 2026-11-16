/**
 * Spec 100: the two pieces of commons the console's remote access stands on, behind one small
 * interface each, so the service and its tests depend on the contract, not on a module:
 *
 * - {@link Passkeys}: WebAuthn (commons kernel `webauthn`): the options a browser needs to create
 *   or use a passkey, and the verification of what it answers (FR-004, FR-007).
 * - the ACME client and the Cloudflare DNS challenge (commons runtime `acme`), for the console's
 *   certificate (FR-002).
 *
 * @module
 */
// Spec: 100-remote-access FR-002, FR-004, FR-007

import { webauthn } from "@intellectual-frontiers/commons/ts/kernel";
import { acme } from "@intellectual-frontiers/commons/ts/runtime";
import type { AcmeIssue } from "./tls.ts";

/** A result as commons gives it. */
export type Res<T> = { kind: "ok"; value: T } | { kind: "err"; error: string };

/** What a verified registration gives. */
export interface Registered {
  /** The credential's id (base64url). */
  credentialId: string;
  /** Its COSE public key (base64url). */
  publicKey: string;
  /** Its COSE algorithm (-7 ES256, -8 EdDSA, -257 RS256). */
  alg: number;
  /** The authenticator's signature counter. */
  signCount: number;
  /** The person was verified (biometrics or a PIN). */
  userVerified: boolean;
  /** A synced passkey. */
  backedUp: boolean;
  /** How the browser reaches it. */
  transports?: string[];
}

/** WebAuthn as the console uses it (commons kernel `webauthn`). */
export interface Passkeys {
  /** The options for `navigator.credentials.create` (JSON). */
  registrationOptions(o: {
    rpId: string;
    rpName: string;
    user: { id: string; name: string; displayName: string };
    challenge: string;
    /** Credential ids (base64url) this person already registered. */
    excludeCredentials?: string[];
    timeoutMs?: number;
  }): unknown;
  /** The options for `navigator.credentials.get` (JSON). */
  authenticationOptions(o: {
    rpId: string;
    challenge: string;
    /** Credential ids (base64url) that may answer (absent: any discoverable passkey). */
    allowCredentials?: string[];
    timeoutMs?: number;
  }): unknown;
  /** Verify a new passkey (its attestation, the challenge, the origin, the relying party). */
  verifyRegistration(o: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string;
    rpId: string;
  }): Promise<Res<Registered>>;
  /** Verify a sign-in against a known passkey (its signature, counter, challenge, origin). */
  verifyAuthentication(o: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string;
    rpId: string;
    credential: { id: string; publicKey: string; alg: number; signCount: number };
  }): Promise<Res<{ signCount: number; userVerified: boolean; backedUp: boolean }>>;
}

/** commons' WebAuthn (kernel `webauthn`), each browser answer parsed before it is verified. */
export function commonsPasskeys(): Passkeys {
  return {
    registrationOptions: (o) => webauthn.registrationOptions(o),
    authenticationOptions: (o) => webauthn.authenticationOptions(o),
    verifyRegistration: async (o) => {
      const r = webauthn.parseRegistrationResponse(o.response);
      if (r.kind === "err") return r;
      const v = await webauthn.verifyRegistration({ ...o, response: r.value });
      return v.kind === "err"
        ? v
        : {
            kind: "ok",
            value: {
              credentialId: v.value.credentialId,
              publicKey: v.value.publicKey,
              alg: v.value.alg,
              signCount: v.value.signCount,
              userVerified: v.value.userVerified,
              backedUp: v.value.backedUp,
              ...(v.value.transports ? { transports: [...v.value.transports] } : {}),
            },
          };
    },
    verifyAuthentication: async (o) => {
      const r = webauthn.parseAuthenticationResponse(o.response);
      if (r.kind === "err") return r;
      const v = await webauthn.verifyAuthentication({ ...o, response: r.value });
      return v.kind === "err" ? v : { kind: "ok", value: { ...v.value } };
    },
  };
}

/**
 * An ACME issuer through commons (runtime `acme`), answering the DNS-01 challenge in Cloudflare
 * with the fleet's token (`fetchImpl`: the network, a fake in tests).
 */
export function commonsAcme(token: string, zone: string, fetchImpl?: typeof fetch): AcmeIssue {
  const dns = acme.cloudflareDns({ token, zone, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return async (o) => {
    const r = await acme.issue({
      directory: o.directory,
      domains: o.domains,
      dns,
      ...(o.accountKey !== undefined ? { accountKey: o.accountKey as JsonWebKey } : {}),
      ...(o.contact ? { contact: o.contact } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    return r.kind === "err" ? r : { kind: "ok", value: { ...r.value } };
  };
}
