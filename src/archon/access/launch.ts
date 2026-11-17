/**
 * Spec 100: what `stolos console --lan` adds to the console. In order: the names (FR-001), a
 * trusted address (Article 28), the Cloudflare token, the certificate (FR-002), the DNS records,
 * remote access itself (the signed tip read once), then, once the console's handler exists, the
 * HTTPS listener on 443 (FR-003, spec 103-three-ports FR-009: no fallback; another port is an explicit choice) and the timers: the heartbeat every 5 minutes, the signed
 * tip every 30 seconds while a code waits (else 5 minutes), the certificate daily, the digest
 * daily.
 *
 * @module
 */
// Spec: 100-remote-access FR-001, FR-002, FR-003
// Spec: 103-three-ports FR-004, FR-009, FR-011

import { acme, path, type ServeHandler } from "@intellectual-frontiers/commons/ts/runtime";
import { choosePort } from "../core/listeners.ts";
import { P } from "../core/paths.ts";
import { readSecret, SECRETS, writeSecret } from "../core/secrets.ts";
import type { Phase } from "../core/ui.ts";
import type { FleetDef } from "../model/types.ts";
import type { ConsoleRemote } from "../console/stolos-server.ts";
import type { ActivityEntry } from "../console/pages.ts";
import { accessStatePath } from "./devices.ts";
import { consoleNames, type ConsoleNames } from "./names.ts";
import { REFRESH_MS, RemoteAccess } from "./service.ts";
import {
  type AcmeIssue,
  ensureCertificate,
  HEARTBEAT_MS,
  HTTPS_PORT,
  keepDns,
  listenAddress,
  type TlsMaterial,
} from "./tls.ts";
import type { TlsServer } from "./https.ts";

/** A prepared remote side: what the handler needs, and how to start and stop it. */
export interface PreparedRemote {
  /** For the console's handler. */
  remote: ConsoleRemote;
  /**
   * Listen with TLS on 443 (or the explicit port) and start the timers; where it listens, or why it cannot, with the fix. There is no
   * fallback port.
   */
  start(
    handler: ServeHandler,
  ): Promise<{ address: string; port: number; explicit: boolean } | { why: string; fix: string }>;
  /** Stop the timers and the listener. */
  stop(): Promise<void>;
}

/** Prepare remote access, or say why it cannot start (each reason with its fix). */
export async function prepareRemote(o: {
  phase: Phase;
  fleet: FleetDef;
  pc: string;
  addresses: string[];
  activity: { add(e: ActivityEntry): Promise<void>; recent(n: number): Promise<ActivityEntry[]> };
  issue?: AcmeIssue;
  directory?: string;
  /** An explicit port for the LAN listener (`--lan-port`), outside the three standard ports unless it is 443. */
  port?: number;
  /** Names what holds a port (tests give one; the default asks the operating system). */
  holder?: (port: number) => Promise<string | undefined>;
}): Promise<PreparedRemote | { why: string; fix: string }> {
  const c = o.phase;
  const names: ConsoleNames | undefined = consoleNames(o.fleet, o.pc);
  if (!names) {
    return {
      why: "remote access needs the fleet's web domain",
      fix: 'add web: { domain: "lab.example.net" } to fleets/<fleet>/fleet.ts',
    };
  }
  const address = listenAddress(o.addresses);
  if (!address) {
    return {
      why: `no LAN or mesh address on this PC (have: ${o.addresses.join(", ") || "none"}): the console never listens on a public address (Article 28)`,
      fix: "join the site's network (or a zero trust mesh network: bun run stolos mesh)",
    };
  }
  const cred = await readSecret(SECRETS.web);
  const token = cred ? ((JSON.parse(cred) as { token?: string }).token ?? "") : "";
  if (!token) {
    return {
      why: "no Cloudflare token on this PC for the console's DNS records and certificate",
      fix: "bun run stolos boot web-setup",
    };
  }
  const { zoneOf } = await import("../web/config.ts");
  const zone = zoneOf(o.fleet.web ?? { domain: names.domain });
  const { commonsAcme } = await import("./passkeys.ts");
  const issue = o.issue ?? commonsAcme(token, zone);
  const directory = o.directory ?? acme.LETS_ENCRYPT;
  c.status(`certificate for ${names.certNames.join(", ")}`);
  const certify = () =>
    ensureCertificate({
      names: names.certNames,
      directory,
      issue,
      read: () => readSecret(SECRETS.consoleTls),
      write: (t) => writeSecret(SECRETS.consoleTls, t),
      ...(o.fleet.mail?.to ? { contact: [`mailto:${o.fleet.mail.to}`] } : {}),
    });
  const first = await certify();
  if (!("tls" in first) || !first.tls) {
    return {
      why: `no certificate: ${"why" in first ? first.why : "?"}`,
      fix: "check the Cloudflare token (bun run stolos boot web-setup), then run this again",
    };
  }
  let tls: TlsMaterial = first.tls;
  if ("why" in first) c.warn(`renewal failed (the current certificate serves): ${first.why}`);
  c.status("DNS records");
  let other: { pc: string; at: string } | undefined;
  const beat = async () => {
    other = (await keepDns({ token, zone, names, address })).other;
  };
  await beat();
  const { signersHere } = await import("./commands.ts");
  const { loadSigners } = await import("../identity/signers.ts");
  const signers = () => loadSigners();
  const { commonsPasskeys } = await import("./passkeys.ts");
  const passkeys = commonsPasskeys();
  const { notify } = await import("../notify/events.ts");
  const access = new RemoteAccess({
    names,
    fleet: {
      id: o.fleet.id,
      title: o.fleet.title,
      branch: o.fleet.repository.branch ?? "main",
    },
    repo: P.repo,
    localSigners: await signersHere(await signers()),
    passkeys,
    statePath: accessStatePath(P.state),
    allowedFile: path.join(P.state, "console-allowed-signers"),
    activity: o.activity,
    mail: (ev) => notify(ev),
  });
  await access.load();
  c.status("reading access.ts from GitHub");
  const read = await access.refresh().catch((e: unknown) => ({ refused: String(e) }));
  if ("refused" in read && read.refused) c.warn(`access.ts not read: ${read.refused}`);
  const hosts: string[] = [];
  let listening: { address: string; port: number; explicit: boolean } | undefined;
  let server: TlsServer | undefined;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const remote: ConsoleRemote = {
    access,
    hosts,
    signers,
    view: () => ({
      ...(listening ? { listener: listening } : {}),
      tls: { names: tls.names, notAfter: tls.notAfter, directory: tls.directory },
      ...(other ? { other } : {}),
    }),
    get controller() {
      return `https://${names.base}${listening && listening.port !== HTTPS_PORT ? `:${listening.port}` : ""}`;
    },
  };
  return {
    remote,
    async start(handler) {
      const { serveTls } = await import("./https.ts");
      const choice = choosePort("console-https", o.port);
      try {
        server = await serveTls(
          {
            hostname: address,
            port: choice.port,
            cert: tls.certificatePem,
            key: tls.privateKeyPem,
          },
          handler,
        );
        listening = { address, port: choice.port, explicit: choice.explicit };
      } catch (e) {
        const { listenRefusal, portHolder } = await import("./holder.ts");
        const code = (e as { code?: string }).code ?? (e as Error).name;
        const holder = await (o.holder ?? portHolder)(choice.port).catch(() => undefined);
        return listenRefusal({ port: choice.port, code, holder });
      }
      for (const n of names.served)
        hosts.push(listening.port === HTTPS_PORT ? n : `${n}:${listening.port}`);
      await access.listening(listening);
      // The timers: none keeps the process alive by itself; Ctrl+C ends the console.
      const every = (ms: number, f: () => Promise<unknown>) => {
        const t = setInterval(() => void f().catch(() => undefined), ms);
        (t as { unref?: () => void }).unref?.();
        timers.push(t);
      };
      every(HEARTBEAT_MS, async () => {
        await beat();
        if (listening) await access.listening(listening);
      });
      let lastRead = Date.now();
      access.onPending(() => {
        lastRead = 0;
      });
      every(5_000, async () => {
        const wait = access.pending.list().length ? REFRESH_MS.pending : REFRESH_MS.idle;
        if (Date.now() - lastRead < wait) return;
        lastRead = Date.now();
        await access.refresh();
      });
      every(24 * 3600_000, async () => {
        const r = await certify();
        if ("tls" in r && r.tls && r.tls !== tls) {
          tls = r.tls;
          await server?.setCertificate({ cert: tls.certificatePem, key: tls.privateKeyPem });
        }
      });
      every(3600_000, () => access.digest());
      return listening;
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      await access.listening(undefined).catch(() => undefined);
      await server?.shutdown();
    },
  };
}
