/**
 * 032-web: a server's Let's Encrypt certificates survive its re-install. Before
 * `deno task boot reinstall` reboots a server, it copies Traefik's ACME store
 * (the Let's Encrypt account, the certificates, and their keys) to the boot
 * machine; the install hands it back, and the first boot puts it in place
 * before Traefik first starts. Traefik then serves the trusted certificate
 * from its first minute and asks Let's Encrypt only to renew (Let's Encrypt
 * allows 5 identical certificates a week). Renewals stay on the server: the
 * boot machine only carries the store across the re-install, and an expired
 * copy is never delivered.
 *
 * @module
 */

import { ensureDir, exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";

/** Traefik's ACME store (spec 032: Traefik's state directory). */
export const ACME_STORE = "/var/lib/traefik/acme.json";
/** Where an install delivers the carried store (first boot moves it, then deletes this). */
export const ACME_DELIVERED = "/etc/archon/acme.json";

/** One certificate in a carried store: its names and when it expires. */
export interface CarriedCertificate {
  /** Its main name (for example `alpha.lab.example.net`). */
  main: string;
  /** Its other names (for example `*.alpha.lab.example.net`). */
  sans: string[];
  /** ISO time the certificate expires. */
  notAfter: string;
}

/** What `archon web acme-export` prints and the boot machine keeps (hosts/<host>/acme.json). */
export interface AcmeCarry {
  /** The server it was exported from. */
  host: string;
  /** When it was exported (ISO 8601). */
  exported: string;
  /** The certificates in the store with a readable expiry; none when the store had none. */
  certificates: CarriedCertificate[];
  /** Traefik's acme.json as it was on the server. */
  acme: string;
}

interface TraefikStore {
  [resolver: string]: {
    Certificates?: Array<{ domain?: { main?: string; sans?: string[] }; certificate?: string }>;
  } | null;
}

/** The certificates in a Traefik ACME store: names and base64 PEM. */
export function storeCertificates(
  acme: string,
): Array<{ main: string; sans: string[]; pem: string }> {
  let store: TraefikStore;
  try {
    store = JSON.parse(acme) as TraefikStore;
  } catch {
    return [];
  }
  const out: Array<{ main: string; sans: string[]; pem: string }> = [];
  for (const r of Object.values(store ?? {})) {
    for (const c of r?.Certificates ?? []) {
      if (c.domain?.main && c.certificate) {
        out.push({ main: c.domain.main, sans: c.domain.sans ?? [], pem: c.certificate });
      }
    }
  }
  return out;
}

/** The soonest expiry among the carried certificates, or undefined when there are none. */
export function validUntil(c: Pick<AcmeCarry, "certificates">): Date | undefined {
  const t = c.certificates.map((x) => Date.parse(x.notAfter)).filter((x) => !isNaN(x));
  return t.length ? new Date(Math.min(...t)) : undefined;
}

/** Worth delivering: it has certificates and none expires within a day. */
export function deliverable(c: AcmeCarry, now = Date.now()): boolean {
  const until = validUntil(c);
  return !!until && until.getTime() - now > 86_400_000;
}

/** "alpha.lab.example.net and *.alpha.lab.example.net, valid until 2027-02-09" */
export function describeCarry(c: AcmeCarry): string {
  const names = [...new Set(c.certificates.flatMap((x) => [x.main, ...x.sans]))];
  const until = validUntil(c);
  return `${names.join(" and ")}${
    until ? `, valid until ${until.toISOString().slice(0, 10)}` : ""
  }`;
}

/** `archon web acme-export` (root): the store and each certificate's expiry, as JSON. */
export async function exportAcme(hostName: string): Promise<number> {
  const acme = await readTextOr(ACME_STORE);
  const certificates: CarriedCertificate[] = [];
  for (const c of storeCertificates(acme ?? "")) {
    const pem = new TextDecoder().decode(
      Uint8Array.from(atob(c.pem), (ch) => ch.charCodeAt(0)),
    );
    const r = await run(["openssl", "x509", "-noout", "-enddate"], { stdin: pem });
    const end = r.stdout.match(/notAfter=(.*)/)?.[1];
    const t = end ? Date.parse(end) : NaN;
    if (!isNaN(t)) {
      certificates.push({ main: c.main, sans: c.sans, notAfter: new Date(t).toISOString() });
    }
  }
  const out: AcmeCarry = {
    host: hostName,
    exported: new Date().toISOString(),
    certificates,
    acme: certificates.length ? acme! : "",
  };
  console.log(JSON.stringify(out));
  return 0;
}

/**
 * First boot: put the carried store in place for Traefik (owner traefik,
 * 0600), unless Traefik already has one. Returns what happened, for the log.
 */
export async function importAcme(): Promise<string | undefined> {
  if (!(await exists(ACME_DELIVERED))) return undefined;
  const acme = await Deno.readTextFile(ACME_DELIVERED);
  await Deno.remove(ACME_DELIVERED);
  if ((await readTextOr(ACME_STORE))?.trim()) {
    return "Traefik already has certificates here: the carried copy was not needed";
  }
  await ensureDir("/var/lib/traefik");
  await Deno.writeTextFile(ACME_STORE, acme, { mode: 0o600 });
  await Deno.chmod(ACME_STORE, 0o600);
  await Deno.chmod("/var/lib/traefik", 0o700);
  await run(["chown", "-R", "traefik:traefik", "/var/lib/traefik"]);
  const names = storeCertificates(acme).flatMap((c) => [c.main, ...c.sans]);
  return `restored the Let's Encrypt certificate carried from the previous install (${
    names.join(", ")
  }): Traefik serves it from its first start, with no new request to Let's Encrypt`;
}
