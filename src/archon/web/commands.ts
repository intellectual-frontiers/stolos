/**
 * 032-web on a server: archon web credential | dns | status.
 *
 * @module
 */

import { ensureDir, exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { resolvePlan } from "../model/resolve.ts";
import type { FleetDef, HostDef } from "../model/types.ts";
import { backendUrl, dnsRecords, fqdn, WEB, zoneOf } from "./config.ts";
import { type CfCredential, upsertRecords } from "./cloudflare.ts";

async function hostOf(name: string): Promise<{ fleet: FleetDef; host: HostDef }> {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === name);
  if (!host) throw new Error(`no host ${name} in the model`);
  return { fleet, host };
}

/**
 * The address this server's records point at: the one it reaches the network
 * from now (the source of its default route), never a reserved or modeled one,
 * so a new DHCP lease is followed (spec 032). Its other IPv4 addresses
 * (container bridges, LXD) are only a fallback without a default route.
 */
export async function serverAddress(_host?: HostDef): Promise<string | undefined> {
  const r = await run(["ip", "-4", "-o", "route", "get", "1.1.1.1"]);
  const src = r.stdout.match(/\bsrc (\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (src) return src;
  const { lanAddresses } = await import("../core/net.ts");
  return lanAddresses()[0];
}

/** What archon web dns last published: the address, and when (root only). */
export const DNS_STATE = "/var/lib/archon/web-dns.json";

/** Whether Cloudflare must hear from this server: a new address, or a day since the last check. */
export function dnsDue(
  address: string,
  last: { address?: string; at?: string } | undefined,
  now = new Date(),
): "changed" | "daily" | undefined {
  if (!last?.address || last.address !== address) return "changed";
  const at = Date.parse(last.at ?? "");
  return Number.isNaN(at) || now.getTime() - at >= 24 * 3600_000 ? "daily" : undefined;
}

/**
 * archon web dns-check (the timer, every 5 minutes and at boot): quiet unless
 * the address changed (or a day passed), then archon web dns. No run log for
 * the checks that change nothing.
 */
export async function webDnsCheck(hostName: string): Promise<number> {
  const { fleet } = await hostOf(hostName);
  if (!fleet.web || !(await exists(WEB.credential))) return 0;
  const address = await serverAddress();
  if (!address) return 0;
  let last: { address?: string; at?: string } | undefined;
  try {
    last = JSON.parse((await readTextOr(DNS_STATE)) ?? "");
  } catch { /* none yet */ }
  const due = dnsDue(address, last);
  if (!due) return 0;
  const code = await webDns(hostName);
  if (due === "changed" && last?.address && code === 0) {
    const { journal } = await import("../core/log.ts");
    await journal(
      "archon-web",
      `address changed ${last.address} -> ${address}; Cloudflare updated`,
    );
    const { notify } = await import("../notify/events.ts");
    await notify({
      event: `${hostName}: new address ${address}`,
      level: "info",
      what:
        `${hostName}'s address changed from ${last.address} to ${address} (a new DHCP lease). Its Cloudflare records now point at ${address}.`,
      todo: "Nothing.",
      key: `dns:${hostName}:${address}`,
    }).catch(() => {});
  }
  return code;
}

/** Store the Cloudflare token (root only) for archon web dns and for Traefik. */
export async function installWebCredential(json: string): Promise<void> {
  const c = JSON.parse(json) as CfCredential;
  if (typeof c.token !== "string" || !/^\S{20,}$/.test(c.token)) {
    throw new Error("not an archon web credential");
  }
  await ensureDir("/etc/archon/web");
  await Deno.chmod("/etc/archon/web", 0o755);
  for (
    const [path, text] of [
      [WEB.credential, JSON.stringify(c, null, 2) + "\n"],
      // lego (Traefik's ACME client) reads both; one token with both permissions serves.
      [WEB.env, `CF_DNS_API_TOKEN=${c.token}\nCF_ZONE_API_TOKEN=${c.token}\n`],
    ] as const
  ) {
    await Deno.writeTextFile(path, text, { mode: 0o600 });
    await Deno.chmod(path, 0o600);
    await run(["chown", "root:root", path]);
  }
  await run(["systemctl", "try-restart", WEB.unit]);
}

/** archon web credential: the token from stdin (deno task stolos boot web-push), then the records. */
export async function webCredential(hostName: string): Promise<number> {
  const p = ui.phase("Cloudflare token");
  const json = await new Response(Deno.stdin.readable).text();
  try {
    await installWebCredential(json);
  } catch (e) {
    p.fail(
      (e as Error).message,
      "deno task stolos boot web-setup on the boot machine, then web-push",
    );
    return 1;
  }
  p.done(`stored (root only); ${WEB.unit} restarted`);
  return await webDns(hostName);
}

/** archon web dns: this server's name and wildcard in Cloudflare, to its address. */
export async function webDns(hostName: string): Promise<number> {
  const { fleet, host } = await hostOf(hostName);
  const p = ui.phase("DNS");
  if (!fleet.web) {
    p.done("no fleet.web: nothing to publish");
    return 0;
  }
  const raw = await readTextOr(WEB.credential);
  if (!raw) {
    p.warn(
      "no Cloudflare token on this server",
      "on the boot machine: deno task stolos boot web-setup, then deno task stolos boot web-push <host>",
    );
    return 1;
  }
  const address = await serverAddress(host);
  if (!address) {
    p.fail("no IPv4 address to publish (no default route)", "ip -4 route; networkctl status");
    return 1;
  }
  try {
    const token = (JSON.parse(raw) as CfCredential).token;
    const done = await upsertRecords(
      token,
      zoneOf(fleet.web),
      dnsRecords(fleet, host, address),
      `archon ${host.name} (spec 032)`,
    );
    p.done(done.map((d) => `${d.name} ${d.action}`).join(" · ") + ` → ${address}`);
    await Deno.writeTextFile(
      DNS_STATE,
      JSON.stringify({ address, at: new Date().toISOString() }) + "\n",
      { mode: 0o644 },
    ).catch(() => {}); // not root: nothing remembered, the next check publishes again
    return 0;
  } catch (e) {
    p.fail(
      (e as Error).message,
      "check the token's permissions: Zone Read and DNS Edit on the zone",
    );
    return 1;
  }
}

/** The certificate Traefik presents for a name: issuer and expiry (openssl). */
export async function certificateOf(
  name: string,
): Promise<{ issuer: string; notAfter: string } | undefined> {
  const r = await run([
    "sh",
    "-c",
    `echo | openssl s_client -connect 127.0.0.1:443 -servername ${name} 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null`,
  ]);
  const issuer = r.stdout.match(/^issuer=\s*(.*)$/m)?.[1];
  const notAfter = r.stdout.match(/^notAfter=(.*)$/m)?.[1];
  return issuer && notAfter ? { issuer, notAfter } : undefined;
}

/** archon web status: the proxy, the certificate, DNS, and every route. */
export async function webStatus(hostName: string): Promise<number> {
  const { fleet, host } = await hostOf(hostName);
  const plan = resolvePlan(host, fleet);
  const name = fqdn(fleet, host);
  const s = ui.phase("Proxy");
  const active = async (u: string) => (await run(["systemctl", "is-active", u])).stdout.trim();
  const t = await active(WEB.unit);
  const w = await active(WEB.welcomeUnit);
  if (t !== "active") s.fail(`${WEB.unit} is ${t}`, `journalctl -u ${WEB.unit} -n 50`);
  if (w !== "active") {
    s.fail(`${WEB.welcomeUnit} is ${w}`, `journalctl -u ${WEB.welcomeUnit} -n 50`);
  }
  s.done(`Traefik ${t} · welcome page ${w} · ports 80, 443 (local networks only behind them)`);

  const c = ui.phase("Certificate");
  const cert = await certificateOf(name ?? host.name);
  if (!cert) c.fail("no certificate answered on 443", `systemctl status ${WEB.unit}`);
  else if (!/Let's Encrypt/i.test(cert.issuer)) {
    c.warn(
      `${cert.issuer} (self-signed until Let's Encrypt answers)`,
      name
        ? (await exists(WEB.env))
          ? `journalctl -u ${WEB.unit} | grep -i acme`
          : "deno task stolos boot web-push <host> (no Cloudflare token here yet)"
        : "set fleet.web in fleets/<fleet>/fleet.ts for a Let's Encrypt certificate",
    );
    c.done(`expires ${cert.notAfter}`);
  } else c.done(`${cert.issuer} · expires ${cert.notAfter}`);

  if (name) {
    const d = ui.phase("DNS");
    const r = await run(["getent", "ahostsv4", name]);
    const got = r.stdout.split(/\s+/)[0];
    const want = await serverAddress(host);
    if (!got) d.warn(`${name} does not resolve`, "sudo archon web dns");
    else if (want && got !== want) d.warn(`${name} is ${got}, not ${want}`, "sudo archon web dns");
    else d.done(`${name} and *.${name} → ${got}`);
  }

  const rt = ui.phase("Routes");
  const lines = [
    `https://${name ?? host.name}   welcome page`,
    ...(name ? [`https://traefik.${name}   Traefik's dashboard`] : []),
    ...(name
      ? plan.routes.map((r) =>
        `https://${r.name}.${name}   → ${backendUrl(r)}${
          r.description ? `   ${r.description}` : ""
        }`
      )
      : []),
  ];
  ui.pause(); // the spinner would draw over these lines
  for (const l of lines) console.log(`  ${l}`);
  ui.resume();
  rt.done(
    `${plan.routes.length} published route(s) · containers: label traefik.enable=true (podman)`,
  );
  return ui.problems.some((x) => x.level === "fail") ? 1 : 0;
}
