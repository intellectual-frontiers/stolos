// archon-boot's HTTP server (spec 004): UEFI HTTP Boot files, GRUB menus
// per host (by Boot URI, or by MAC when the model has one), the verified installer image, and each host's install config with
// its secrets filled in at request time (Article 13).

import type { ArchonEvent } from "../archon/telemetry/events.ts";
import {
  FLEET_KEEP,
  FLEET_OTLP_PATH,
  FLEET_TELEMETRY_DIR,
  installTraceparent,
  otlpHandler,
} from "./telemetry.ts";
import { loadFleet, loadServers } from "../archon/model/load.ts";
import type { HostDef } from "../archon/model/types.ts";
import { metaData, userData } from "../archon/render/autoinstall.ts";
import { liveToken, loadTokens, readSecret, saveTokens, SECRETS } from "../archon/core/secrets.ts";
import type { Assets } from "./assets.ts";
import { chooserMenu, hostMenu, mainMenu } from "./grub.ts";
import { UBUNTU } from "./pins.ts";
import { ensureHostKeys, trustHost } from "../archon/install/host-keys.ts";
import { stallMessage, StallWatch } from "./stall.ts";
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
  /** Spec 049: every event, structured; the window and boot.log render it. */
  emit: (e: ArchonEvent) => void;
  /**
   * Spec 051, off by default (boot serve --stall-watch): name a machine whose
   * installer took the image and went quiet. It guesses which machine from DHCP
   * leases, which installers change mid-install; it is a hint, not a guarantee.
   */
  stallWatch?: boolean;
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
  // Spec 051: an installer that took the image and went quiet (too little RAM).
  // Keyed by host when known: the installer can take the image from one DHCP
  // lease and ask for its configuration from another.
  const stalls = new StallWatch(
    o.stallWatch
      ? (key) => {
        const host = key.startsWith("host:") ? key.slice(5) : installing.get(key);
        const address = key.startsWith("host:") ? undefined : key;
        o.emit({
          name: "boot.stalled",
          severity: "warn",
          address,
          host,
          message: `${stallMessage(host)} (archon explain E051-INSTALLER-STALLED)`,
          attrs: { code: "E051-INSTALLER-STALLED" },
        });
        if (host) {
          installProblem(host, "the installer went quiet after taking the image (too little RAM?)");
        }
      }
      : () => {},
  );
  const addressHost = (from: string): string | undefined => {
    const m = byAddress.get(from);
    return m && Date.now() - m.at < BOOT_URI_MEMORY_MS ? m.host : undefined;
  };
  // Which host each address is installing (spec 023: its requests join that install's trace).
  const installing = new Map<string, string>();
  // The host whose menu was served last: the installer may come back from another lease.
  let lastMenu: { host: string; at: number } | undefined;
  const menuFor = async (
    host: HostDef,
    from: string,
    base: string,
    method: string,
  ): Promise<Response> => {
    const t = liveToken(await loadTokens(), host.name);
    if (method !== "GET") return text(hostMenu(host, base, t?.token));
    o.emit({
      name: t ? "boot.starting" : "boot.own-disk",
      address: from,
      host: host.name,
      message: t ? "armed, starting its install" : "not armed, booting its own disk",
    });
    if (t) {
      installing.set(from, host.name);
      lastMenu = { host: host.name, at: Date.now() };
      installStep(host.name, "network boot", { "client.address": from });
    }
    return text(hostMenu(host, base, t?.token));
  };
  const milestones = new Map<string, Set<string>>();
  const fleetOtlp = otlpHandler(FLEET_TELEMETRY_DIR, FLEET_KEEP, FLEET_OTLP_PATH);
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
            o.emit({
              name: "boot.uri.unknown",
              address: from,
              message: `Boot URI names ${name}, which is not a host (archon host add ${name})`,
              attrs: { uri_host: name },
            });
            return text("unknown host\n", 404);
          }
          byAddress.set(from, { host: name, at: Date.now() });
        }
        const via = req.headers.get("x-archon-via") === "tftp" ? "TFTP" : req.method;
        o.emit({
          name: "boot.file",
          address: from,
          message: `${via} ${name ? `${name}/` : ""}${what}`,
          attrs: { via, file: what },
        });
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
            o.emit({
              name: "boot.http.missing",
              address: from,
              message:
                `loaded the installer over TFTP but has not reached HTTP port ${o.port} in 3 minutes: allow TCP ${o.port} inbound on this PC (README step 1), and between networks on the router`,
            });
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
        o.emit({
          name: "boot.file.substituted",
          address: from,
          message: `TFTP ${
            other[1]
          }: serving bootx64.efi instead (set the router's boot file name to bootx64.efi)`,
          attrs: { via: "TFTP", file: other[1] },
        });
        return await file(assets.files["bootx64.efi"], req);
      }
      if (path === "/boot/grub/grub.cfg" || path === "/grub/grub.cfg") {
        const name = addressHost(from);
        const host = name ? (await loadServers()).find((h) => h.name === name) : undefined;
        if (host) return await menuFor(host, from, base, req.method);
        if (req.method === "GET") {
          o.emit({
            name: "boot.menu",
            address: from,
            message: "GRUB menu (no host in its Boot URI: by MAC)",
          });
        }
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
          o.emit({
            name: "boot.claimed",
            address: from,
            host: t.host,
            message: `unknown machine ${menu[1]} claimed (boot arm --claim)`,
            attrs: { mac: menu[1] },
          });
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
          o.emit({
            name: "boot.recognized",
            address: from,
            host: byAddr[0].name,
            message: `recognized by its address; MAC ${
              menu[1]
            } learned (recorded in its registration.ts when its install finishes)`,
            attrs: { mac: menu[1] },
          });
          return await menuFor(byAddr[0], from, base, req.method);
        }
        const armed = hosts
          .map((h) => ({ host: h, token: liveToken(tokens, h.name)?.token }))
          .filter((a): a is { host: HostDef; token: string } => !!a.token);
        // Spec 051: a host armed for a network card that has not booted, while
        // another machine does: the MAC may have been mistyped (or it is the
        // wrong machine). Nothing installs; the boot window says what to do.
        const waiting = hosts.filter((h) => {
          const t = liveToken(tokens, h.name);
          return h.mac && t && !t.firstUse && !t.claimUntil;
        });
        if (req.method === "GET" && waiting.length) {
          for (const h of waiting) {
            o.emit({
              name: "boot.mismatch",
              address: from,
              host: h.name,
              attrs: { mac: menu[1], expected: h.mac!, code: "E051-MAC-MISMATCH" },
              message: `unknown machine ${
                menu[1]
              } network-booted while ${h.name} waits for ${h.mac}. If it is ${h.name}, its MAC was mistyped: deno task boot arm ${h.name} --mac-address ${
                menu[1]
              } (or --claim). Nothing was installed. (archon explain E051-MAC-MISMATCH)`,
            });
          }
        }
        if (req.method === "GET") {
          o.emit({
            name: "boot.unknown",
            address: from,
            attrs: { mac: menu[1] },
            message: `unknown machine ${menu[1]}: ${
              armed.length
                ? `menu of armed hosts (${
                  armed.map((a) => a.host.name).join(", ")
                }), default boots its own disk`
                : "nothing armed, booting its own disk"
            }`,
          });
        }
        return text(chooserMenu(armed, base));
      }
      if (path === "/health") return text("archon-boot ok\n");
      // Spec 049: the fleet's default (ephemeral) OpenTelemetry collector.
      if (path.startsWith(FLEET_OTLP_PATH + "/")) return await fleetOtlp(req);
      // Events from this PC's own commands (arm, reinstall): loopback only.
      if (path === "/local/event" && req.method === "POST") {
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(from)) return text("no\n", 403);
        const e = await req.json().catch(() => ({})) as Partial<ArchonEvent>;
        // Only events this PC's commands announce (spec 049): a known name and a message.
        if (
          typeof e.name === "string" && /^boot\.(armed|reboot|certificate)$/.test(e.name) &&
          typeof e.message === "string" && e.message.trim()
        ) {
          // Spec 049: an install's trace starts when it is armed.
          if (e.name === "boot.armed" && typeof e.host === "string") installStep(e.host, "armed");
          o.emit({
            name: e.name,
            message: e.message.trim().slice(0, 500),
            ...(typeof e.host === "string" ? { host: e.host } : {}),
          });
        } else return text("not an event\n", 400);
        return text("ok\n");
      }
      if (path === "/site-ca.crt" && o.caPem) {
        o.emit({ name: "boot.site-ca", address: from, message: "site CA" });
        return text(o.caPem);
      }
      if (path === `/iso/${UBUNTU.iso.name}`) {
        if (req.method === "GET") {
          o.emit({
            name: "boot.image",
            address: from,
            host: installing.get(from),
            message: `installer image (${req.headers.get("range") ?? "whole"})`,
          });
          const h = installing.get(from) ??
            (lastMenu && Date.now() - lastMenu.at < 10 * 60_000 ? lastMenu.host : undefined);
          if (h) installStep(h, "downloading Ubuntu");
          if (!req.headers.get("range")) stalls.imageServed(h ? `host:${h}` : from);
          served(UBUNTU.iso.name, (await Deno.stat(assets.iso)).size, "http");
        }
        return await file(assets.iso, req);
      }
      // GRUB puts the MAC it booted from into the URL (spec 004).
      const inst = path.match(
        /^\/install\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)\/(?:([0-9A-Fa-f:]{17})\/)?(user-data|meta-data|vendor-data|network-config|done|event|guard\.sh|facts)$/,
      );
      if (inst) {
        const [, name, token, rawMac, what] = inst;
        const bootMac = rawMac?.toLowerCase();
        stalls.heard(`host:${name}`);
        stalls.heard(from);
        if (what === "event") {
          // Progress: accepted during the install and for 3 hours after it finished.
          const rec = (await loadTokens()).find((x) => x.host === name && x.token === token);
          const fresh = rec && (!rec.done || Date.now() - Date.parse(rec.done) < 3 * 3600_000);
          if (!fresh || req.method !== "POST") return text("no\n", 403);
          const e = await req.json().catch(() => ({})) as InstallerEvent;
          if (!milestones.has(name)) milestones.set(name, new Set());
          const ev = describe(e, milestones.get(name)!);
          if (ev) {
            o.emit({ ...ev, address: from, host: name });
            // Spec 023: the install's trace follows the same milestones.
            if (ev.name === "boot.ready" || ev.name === "boot.done-with-problems") {
              installEnd(name, ev.name === "boot.ready", e.summary ?? "");
              // What now: how to reach and observe it (specs 021, 022).
              const h = (await loadServers()).find((x) => x.name === name);
              if (h) {
                const { nextSteps } = await import("../archon/observe/next.ts");
                o.emit({
                  name: "boot.next",
                  host: name,
                  message: `${
                    ev.name === "boot.ready" ? "ready" : "installed, with problems"
                  }. Next:`,
                });
                for (
                  const l of nextSteps({ host: h, fleet: await loadFleet(), address: from })
                ) {
                  o.emit({
                    name: "boot.next",
                    host: name,
                    message: l.trim(),
                    attrs: { step: true },
                  });
                }
              }
            } else if (ev.name === "boot.installer.failed" || ev.severity === "error") {
              installProblem(name, ev.message);
            } else {
              installStep(
                name,
                ev.name === "boot.firstboot.phase"
                  ? `first boot: ${ev.attrs?.phase}`
                  : ev.message.replace(/^installer: /, ""),
              );
            }
          }
          return text("ok\n");
        }
        const tokens = await loadTokens();
        const t = liveToken(tokens, name);
        if (!t || t.token !== token) {
          o.emit({
            name: "boot.refused",
            address: from,
            host: name,
            message: `refused ${what}: no live install token`,
          });
          return text("not armed\n", 403);
        }
        const host = (await loadServers()).find((h) => h.name === name);
        if (!host) return text("unknown host\n", 404);
        if (what === "done") {
          t.done = new Date().toISOString();
          if (bootMac) t.mac = bootMac;
          // Spec 051: the network card it installed from, as the machine reported
          // it, is its registered MAC from now on (a fact, not something typed).
          if (bootMac) {
            const { loadRegistration, writeRegistration } = await import(
              "../archon/fleet/registration.ts"
            );
            const reg = await loadRegistration(name).catch(() => undefined);
            if (reg && (reg.mac !== bootMac || reg.macSource !== "installed")) {
              const file = await writeRegistration(name, {
                ...reg,
                mac: bootMac,
                macSource: "installed",
              });
              o.emit({
                name: "boot.learned",
                host: name,
                attrs: { mac: bootMac },
                message:
                  `${file}: mac ${bootMac}, as the machine reported it; commit and push it (signed) to keep it`,
              });
            }
          }
          t.addresses = [...new Set([...(t.addresses ?? []), from])];
          await saveTokens(tokens);
          o.emit({
            name: "boot.finished",
            address: from,
            host: name,
            message: "install finished; disarmed (it boots its own disk from now on)",
          });
          installStep(name, "rebooting into Ubuntu");
          // It keeps its own SSH host keys (installed by cloud-init): trust them here
          // for its name and every address it used, so `ssh ${name}` just works.
          const names = await trustHost(name, t.addresses);
          o.emit({
            name: "boot.hostkeys",
            host: name,
            message: `this PC trusts its SSH host keys for ${names.join(", ")}`,
          });
          return text("ok\n");
        }
        // Spec 051: the blank-disk guard, before the installer touches a disk.
        if (what === "guard.sh") {
          const { GUARD_SCRIPT } = await import("./guard.ts");
          return text(GUARD_SCRIPT);
        }
        if (what === "facts") {
          const { parseFacts, describeFacts, guardDecision } = await import("./guard.ts");
          const { loadRegistration } = await import("../archon/fleet/registration.ts");
          const facts = parseFacts(await req.text());
          o.emit({
            name: "boot.machine",
            address: from,
            host: name,
            message: `the machine reports: ${describeFacts(facts)}`,
            attrs: {
              ...(facts.vendor ? { vendor: facts.vendor } : {}),
              ...(facts.model ? { model: facts.model } : {}),
              ...(facts.serial ? { serial: facts.serial } : {}),
              ...(facts.memKiB ? { mem_kib: facts.memKiB } : {}),
              ...(bootMac ? { mac: bootMac } : {}),
            },
          });
          const d = guardDecision(name, facts, t, bootMac, await loadRegistration(name));
          if (d.go) {
            o.emit({ name: "boot.guard", address: from, host: name, message: `disks: ${d.why}` });
            if (t.confirmDestroy) {
              // Spent: a later install of this host asks again.
              delete t.confirmDestroy;
              await saveTokens(tokens);
            }
            return text("ok\n");
          }
          o.emit({
            name: "boot.guarded",
            severity: "warn",
            address: from,
            host: name,
            message: `install stopped: ${d.why}. ${d.fix} (archon explain E051-DISK-NOT-BLANK)`,
            attrs: { code: "E051-DISK-NOT-BLANK" },
          });
          installProblem(name, `install stopped by the blank-disk guard: ${d.why}`);
          return text(`stop: ${d.why}. ${d.fix}\n`);
        }
        if (what === "meta-data") {
          o.emit({ name: "boot.config", address: from, host: name, message: "meta-data" });
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
          o.emit({
            name: "boot.config",
            severity: "warn",
            address: from,
            host: name,
            message: `its carried Let's Encrypt certificate (${
              describeCarry(carry)
            }) is too close to expiry to reuse; it asks Let's Encrypt for a new one`,
          });
        }
        const extras = [
          deployKey && "deploy key",
          "SSH host keys",
          mailCredential && "mail token",
          webCredential && "Cloudflare DNS token",
          acme && carry && `Let's Encrypt certificate (${describeCarry(carry)})`,
        ].filter(Boolean).join(", ");
        o.emit({
          name: "boot.config",
          address: from,
          host: name,
          message: `install config sent${
            bootMac ? ` (network on ${bootMac})` : ""
          } with its ${extras}`,
        });
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
              traceparent: installTraceparent(name),
            },
            { passwordHash, deployKey, hostKeys, mailCredential, webCredential, acme },
          ),
        );
      }
      const via = req.headers.get("x-archon-via") === "tftp" ? "TFTP" : req.method;
      // Files GRUB and the shim look for and do without: debug, not a problem.
      const probe =
        /^\/?(revocations\.efi|grub\/x86_64-efi\/[a-z]+\.lst|grub\/grub\.cfg-[0-9a-f-]+)$/i
          .test(path.replace(/^\//, ""));
      o.emit({
        name: probe ? "boot.file.probe" : "boot.not-found",
        address: from,
        message: `${via} ${url.pathname}: not found`,
        attrs: { via, file: path },
      });
      return text("not found\n", 404);
    } catch (e) {
      o.emit({ name: "boot.error", address: from, message: `${path}: ${(e as Error).message}` });
      return text("error\n", 500);
    }
  };
}
