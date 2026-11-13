// archon-boot's HTTP server (spec 004): UEFI HTTP Boot files, GRUB menus
// per host (by Boot URI, or by MAC when the model has one), the verified installer image, and each host's install config with
// its secrets filled in at request time (Article 13).

import { loadFleet, loadServers } from "../archon/model/load.ts";
import type { HostDef } from "../archon/model/types.ts";
import { metaData, userData } from "../archon/render/autoinstall.ts";
import { liveToken, loadTokens, readSecret, saveTokens, SECRETS } from "../archon/core/secrets.ts";
import type { Assets } from "./assets.ts";
import { chooserMenu, hostMenu, mainMenu } from "./grub.ts";
import { UBUNTU } from "./pins.ts";
import { ensureHostKeys, trustHost } from "../archon/install/host-keys.ts";
import { describe, type InstallerEvent } from "./progress.ts";
import { installEnd, installProblem, installStep, served } from "./telemetry.ts";
import { type Handler, listen } from "./http.ts";

export interface ServeOptions {
  port: number;
  /** Proxy the installer and first boot should use (sites behind one; optional). */
  proxy?: string;
  /** PEM of a CA that proxy needs trusted (optional). */
  caPem?: string;
  /** GitHub Enterprise or a releases mirror (optional). */
  githubApi?: string;
  log: (line: string) => void;
}

/** How long a machine's address stays tied to the host named in its Boot URI. */
const BOOT_URI_MEMORY_MS = 15 * 60 * 1000;

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function file(path: string, req: Request): Promise<Response> {
  const st = await Deno.stat(path);
  const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
  const f = await Deno.open(path);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : st.size - 1;
    await f.seek(start, Deno.SeekMode.Start);
    const len = end - start + 1;
    let left = len;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (left <= 0) {
          f.close();
          return c.close();
        }
        const buf = new Uint8Array(Math.min(1 << 20, left));
        const n = await f.read(buf);
        if (n === null) {
          f.close();
          return c.close();
        }
        left -= n;
        c.enqueue(buf.subarray(0, n));
      },
      cancel() {
        f.close();
      },
    });
    return new Response(body, {
      status: 206,
      headers: {
        "content-length": String(len),
        "content-range": `bytes ${start}-${end}/${st.size}`,
        "accept-ranges": "bytes",
      },
    });
  }
  return new Response(f.readable, {
    headers: { "content-length": String(st.size), "accept-ranges": "bytes" },
  });
}

/** Serve HTTP with the given handler: the same one TFTP uses, so they share what they saw. */
export function serve(o: ServeOptions, h: Handler): Deno.Listener {
  return listen(o.port, h);
}

/** The request handler, shared by HTTP and TFTP (PXE). */
export function handler(assets: Assets, o: ServeOptions): Handler {
  // A MAC in the model, else one learned when the host installed or was claimed.
  const byMac = async (raw: string): Promise<HostDef | undefined> => {
    const mac = raw.toLowerCase();
    const hosts = await loadServers();
    const known = hosts.find((h) => h.mac === mac);
    if (known) return known;
    const t = (await loadTokens()).find((x) => x.mac === mac);
    return t && hosts.find((h) => h.name === t.host && !h.mac);
  };
  // Firmware, shim, and GRUB fetch from the same address in one boot: the host
  // named in the Boot URI is remembered for that address, so GRUB (which asks
  // for /grub/grub.cfg without it) gets that host's menu.
  const byAddress = new Map<string, { host: string; at: number }>();
  // After a machine loads the installer over TFTP it must reach HTTP (the ISO,
  // its config). If nothing arrives, the usual cause is a firewall: say so.
  let lastHttp = 0;
  const addressHost = (from: string): string | undefined => {
    const m = byAddress.get(from);
    return m && Date.now() - m.at < BOOT_URI_MEMORY_MS ? m.host : undefined;
  };
  // Which host each address is installing (spec 023: its requests join that install's trace).
  const installing = new Map<string, string>();
  const menuFor = async (
    host: HostDef,
    from: string,
    base: string,
    method: string,
  ): Promise<Response> => {
    const t = liveToken(await loadTokens(), host.name);
    if (method !== "GET") return text(hostMenu(host, base, t?.token));
    o.log(
      `${from} ${host.name}: ${
        t ? "armed, starting its install" : "not armed, booting its own disk"
      }`,
    );
    if (t) {
      installing.set(from, host.name);
      installStep(host.name, "network boot", { "client.address": from });
    }
    return text(hostMenu(host, base, t?.token));
  };
  const milestones = new Map<string, Set<string>>();
  return async (req, from) => {
    if (req.headers.get("x-archon-via") !== "tftp") lastHttp = Date.now();
    const url = new URL(req.url);
    // Shim asks for its second stage as "\\grubx64.efi" (a backslash path).
    const path = decodeURIComponent(url.pathname).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    // Everything the host is told to fetch next points back at the address it used.
    const base = `http://${req.headers.get("host") ?? `${url.hostname}:${o.port}`}/`;
    try {
      // UEFI HTTP Boot: shim, then GRUB, kernel, initrd (Ubuntu's signed files).
      // A host's own Boot URI is /boot/<host>/bootx64.efi; shim then asks for
      // grubx64.efi next to it.
      const boot = path.match(
        /^\/(?:boot\/)?(?:([a-z0-9-]+)\/)?(bootx64\.efi|grubx64\.efi|linux|initrd)$/,
      );
      if (boot) {
        const [, name, what] = boot;
        if (name) {
          if (!(await loadServers()).some((h) => h.name === name)) {
            o.log(`${from} Boot URI names ${name}, which is not a host (archon host add ${name})`);
            return text("unknown host\n", 404);
          }
          byAddress.set(from, { host: name, at: Date.now() });
        }
        const via = req.headers.get("x-archon-via") === "tftp" ? "TFTP" : req.method;
        o.log(`${from} ${via} ${name ? `${name}/` : ""}${what}`);
        if (req.method === "GET") {
          served(
            what,
            (await Deno.stat(assets.files[what])).size,
            via === "TFTP" ? "tftp" : "http",
          );
          const h = installing.get(from);
          if (h && (what === "linux" || what === "initrd")) installStep(h, "loading the installer");
        }
        if (via === "TFTP" && what === "initrd") {
          const sent = Date.now();
          setTimeout(() => {
            if (lastHttp >= sent) return;
            o.log(
              `${from} loaded the installer over TFTP but has not reached HTTP port ${o.port} in 3 minutes: allow TCP ${o.port} inbound on this PC (README step 1), and between networks on the router`,
            );
          }, 180_000);
        }
        return await file(assets.files[what], req);
      }
      // A router still set up for another boot loader (for example netboot.xyz)
      // asks for its file: serve Ubuntu's shim anyway, and say how to fix it.
      const other = path.match(/^\/([^/]+\.efi)$/);
      if (
        other && !/^(revocations|mmx64|fbx64)\.efi$/.test(other[1]) &&
        req.headers.get("x-archon-via") === "tftp"
      ) {
        o.log(
          `${from} TFTP ${
            other[1]
          }: serving bootx64.efi instead (set the router's boot file name to bootx64.efi)`,
        );
        return await file(assets.files["bootx64.efi"], req);
      }
      if (path === "/boot/grub/grub.cfg" || path === "/grub/grub.cfg") {
        const name = addressHost(from);
        const host = name ? (await loadServers()).find((h) => h.name === name) : undefined;
        if (host) return await menuFor(host, from, base, req.method);
        if (req.method === "GET") o.log(`${from} GRUB menu (no host in its Boot URI: by MAC)`);
        return text(mainMenu());
      }
      const menu = path.match(/^\/boot\/hosts\/([0-9a-f:]{17})\.cfg$/);
      if (menu) {
        const host = await byMac(menu[1]);
        if (host) return await menuFor(host, from, base, req.method);
        const tokens = await loadTokens();
        // `boot arm <host> --claim`: the next unknown machine becomes that host.
        const hosts = await loadServers();
        const claims = tokens.filter((t) =>
          t.claimUntil && Date.parse(t.claimUntil) > Date.now() && liveToken(tokens, t.host) &&
          hosts.some((h) => h.name === t.host && !h.mac)
        );
        if (claims.length === 1) {
          const t = claims[0];
          t.mac = menu[1];
          delete t.claimUntil;
          await saveTokens(tokens);
          o.log(`${from} unknown machine ${menu[1]} claimed by ${t.host} (boot arm --claim)`);
          return await menuFor(hosts.find((h) => h.name === t.host)!, from, base, req.method);
        }
        // An armed host without a known MAC, booting from its own address (the
        // router's fixed IP for it, or where it was installed from): that host.
        const fromAddr = from.replace(/^::ffff:/, "");
        const byAddr = hosts.filter((h) => {
          const t = liveToken(tokens, h.name);
          return !h.mac && t && !t.mac && (h.ip === fromAddr || t.addresses?.includes(fromAddr));
        });
        if (byAddr.length === 1) {
          const t = tokens.find((x) => x.host === byAddr[0].name)!;
          t.mac = menu[1];
          await saveTokens(tokens);
          o.log(
            `${from} ${byAddr[0].name}: recognized by its address; MAC ${
              menu[1]
            } learned (add mac: "${menu[1]}" to its host model to make it permanent)`,
          );
          return await menuFor(byAddr[0], from, base, req.method);
        }
        const armed = hosts
          .map((h) => ({ host: h, token: liveToken(tokens, h.name)?.token }))
          .filter((a): a is { host: HostDef; token: string } => !!a.token);
        if (req.method === "GET") {
          o.log(
            `${from} unknown machine ${menu[1]}: ${
              armed.length
                ? `menu of armed hosts (${
                  armed.map((a) => a.host.name).join(", ")
                }), default boots its own disk`
                : "nothing armed, booting its own disk"
            }`,
          );
        }
        return text(chooserMenu(armed, base));
      }
      if (path === "/health") return text("archon-boot ok\n");
      // Events from this PC's own commands (arm, reinstall): loopback only.
      if (path === "/local/event" && req.method === "POST") {
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(from)) return text("no\n", 403);
        const e = await req.json().catch(() => ({})) as { line?: string };
        if (typeof e.line === "string" && e.line.trim()) o.log(e.line.trim().slice(0, 500));
        return text("ok\n");
      }
      if (path === "/site-ca.crt" && o.caPem) {
        o.log(`${from} site CA`);
        return text(o.caPem);
      }
      if (path === `/iso/${UBUNTU.iso.name}`) {
        if (req.method === "GET") {
          o.log(`${from} installer image (${req.headers.get("range") ?? "whole"})`);
          const h = installing.get(from);
          if (h) installStep(h, "downloading Ubuntu");
          served(UBUNTU.iso.name, (await Deno.stat(assets.iso)).size, "http");
        }
        return await file(assets.iso, req);
      }
      // GRUB puts the MAC it booted from into the URL (spec 004).
      const inst = path.match(
        /^\/install\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)\/(?:([0-9A-Fa-f:]{17})\/)?(user-data|meta-data|vendor-data|network-config|done|event)$/,
      );
      if (inst) {
        const [, name, token, rawMac, what] = inst;
        const bootMac = rawMac?.toLowerCase();
        if (what === "event") {
          // Progress: accepted during the install and for 3 hours after it finished.
          const rec = (await loadTokens()).find((x) => x.host === name && x.token === token);
          const fresh = rec && (!rec.done || Date.now() - Date.parse(rec.done) < 3 * 3600_000);
          if (!fresh || req.method !== "POST") return text("no\n", 403);
          const e = await req.json().catch(() => ({})) as InstallerEvent;
          if (!milestones.has(name)) milestones.set(name, new Set());
          const line = describe(e, milestones.get(name)!);
          if (line) {
            o.log(`${from} ${name}: ${line}`);
            // Spec 023: the install's trace follows the same milestones.
            if (e.origin === "archon" && /^(Ready|Done with problems)$/.test(e.phase ?? "")) {
              installEnd(name, e.phase === "Ready", e.summary ?? "");
              // What now: how to reach and observe it (specs 021, 022).
              const h = (await loadServers()).find((x) => x.name === name);
              if (h) {
                const { nextSteps } = await import("../archon/observe/next.ts");
                o.log(
                  `${name}: ${e.phase === "Ready" ? "ready" : "installed, with problems"}. Next:`,
                );
                for (
                  const l of nextSteps({
                    host: h,
                    fleet: await loadFleet(),
                    address: from,
                  })
                ) o.log(`  ${l}`);
              }
            } else if (line.startsWith("✗")) installProblem(name, line);
            else {installStep(
                name,
                e.origin === "archon" ? `first boot: ${e.phase}` : line.replace(/^installer: /, ""),
              );}
          }
          return text("ok\n");
        }
        const tokens = await loadTokens();
        const t = liveToken(tokens, name);
        if (!t || t.token !== token) {
          o.log(`${from} refused ${what} for ${name}: no live install token`);
          return text("not armed\n", 403);
        }
        const host = (await loadServers()).find((h) => h.name === name);
        if (!host) return text("unknown host\n", 404);
        if (what === "done") {
          t.done = new Date().toISOString();
          if (bootMac) t.mac = bootMac;
          t.addresses = [...new Set([...(t.addresses ?? []), from])];
          await saveTokens(tokens);
          o.log(`${from} ${name}: install finished; disarmed (it boots its own disk from now on)`);
          installStep(name, "rebooting into Ubuntu");
          // It keeps its own SSH host keys (installed by cloud-init): trust them here
          // for its name and every address it used, so `ssh ${name}` just works.
          const names = await trustHost(name, t.addresses);
          o.log(`${name}: this PC trusts its SSH host keys for ${names.join(", ")}`);
          return text("ok\n");
        }
        if (what === "meta-data") {
          o.log(`${from} ${name}: meta-data`);
          return text(metaData(host));
        }
        // Empty: the installer keeps the DHCP it booted with; the installed
        // system's netplan comes from autoinstall's network section.
        if (what === "vendor-data" || what === "network-config") return text("");
        if (!t.firstUse || (bootMac && t.mac !== bootMac) || !t.addresses?.includes(from)) {
          t.firstUse ??= new Date().toISOString();
          if (bootMac) t.mac = bootMac;
          t.addresses = [...new Set([...(t.addresses ?? []), from])];
          await saveTokens(tokens);
        }
        const passwordHash = await readSecret(SECRETS.adminPasswordHash);
        if (!passwordHash) return text("no admin password: run archon fleet init\n", 500);
        const deployKey = await readSecret(SECRETS.deployKey(name));
        const hostKeys = await ensureHostKeys(name);
        milestones.delete(name); // a new install: show its milestones again
        const mailCredential = await readSecret(SECRETS.mail);
        const webCredential = await readSecret(SECRETS.web);
        // Spec 032: the certificates boot reinstall carried, unless they expire within a day.
        const { deliverable, describeCarry } = await import("../archon/web/acme.ts");
        const carriedRaw = await readSecret(SECRETS.acme(name));
        let carry: import("../archon/web/acme.ts").AcmeCarry | undefined;
        try {
          carry = carriedRaw ? JSON.parse(carriedRaw) : undefined;
        } catch {
          carry = undefined;
        }
        const acme = carry && deliverable(carry) ? carry.acme : undefined;
        if (carry && !acme) {
          o.log(
            `${from} ${name}: its carried Let's Encrypt certificate (${
              describeCarry(carry)
            }) is too close to expiry to reuse; it asks Let's Encrypt for a new one`,
          );
        }
        const extras = [
          deployKey && "deploy key",
          "SSH host keys",
          mailCredential && "mail token",
          webCredential && "Cloudflare DNS token",
          acme && carry && `Let's Encrypt certificate (${describeCarry(carry)})`,
        ].filter(Boolean).join(", ");
        o.log(
          `${from} ${name}: install config sent${
            bootMac ? ` (network on ${bootMac})` : ""
          } with its ${extras}`,
        );
        installStep(name, "starting the installer");
        return text(
          userData(
            {
              fleet: await loadFleet(),
              host,
              base: `${base}install/${name}/${token}/${bootMac ? `${bootMac}/` : ""}`,
              proxy: o.proxy,
              caPem: o.caPem,
              githubApi: o.githubApi,
              bootMac,
            },
            { passwordHash, deployKey, hostKeys, mailCredential, webCredential, acme },
          ),
        );
      }
      const via = req.headers.get("x-archon-via") === "tftp" ? "TFTP" : req.method;
      o.log(`${from} ${via} ${url.pathname}: not found`);
      return text("not found\n", 404);
    } catch (e) {
      o.log(`${from} ${path}: ${(e as Error).message}`);
      return text("error\n", 500);
    }
  };
}
