/**
 * The network reference (spec 028), rendered from the site model by
 * `archon build` into out/site/network-reference.html: the document the owner
 * sends with each network change log (deno task boot notify --subject "Lab
 * Network Runbook Change Log <dates>" --attach out/site/network-reference.html).
 * Generated: edit fleets/<fleet>/site.ts, never this output. Names only, no secrets.
 *
 * @module
 */

import type { HostDef } from "../model/types.ts";
import type { FirewallPolicy, SiteDef } from "../model/site.ts";
import { SECRET_INVENTORY } from "../model/secret-inventory.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(
    /"/g,
    "&quot;",
  );

function table(head: string[], rows: unknown[][]): string {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}

const action = (a: FirewallPolicy["action"]) =>
  a === "allow-return" ? "Allow + return" : a === "allow" ? "Allow" : "Block";

function match(p: FirewallPolicy): string {
  const proto = p.protocol === "any" ? "Any" : p.protocol.toUpperCase();
  const ports = p.ports?.length
    ? ` ${p.ports.join(", ")}`
    : p.exceptPorts?.length
    ? `, all ports except ${p.exceptPorts.join(", ")}`
    : "";
  return `${proto}${ports}${p.ipVersion === "ipv4" ? ", IPv4" : ""}`;
}

/**
 * The network reference as one HTML page, from the site model and its hosts.
 * `commit` names the commit it was built at; `problems` are listed in their
 * own section.
 */
export function renderNetworkDoc(
  site: SiteDef,
  hosts: HostDef[],
  o: { commit?: string; problems?: string[] } = {},
): string {
  const n = (name: string) => site.networks.find((x) => x.name === name);
  const boot = site.bootServer;
  const sections: Array<[string, string, string]> = [];
  const add = (id: string, title: string, body: string) => sections.push([id, title, body]);

  add(
    "glance",
    "At a glance",
    `<dl class="glance">
      <div><dt>Gateway</dt><dd>${esc(site.gateway.model)}<br>${
      esc(n(site.gateway.network)?.gateway)
    } · ${esc(site.gateway.name)}</dd></div>
      <div><dt>Networks</dt><dd>${site.networks.filter((x) => x.vlan).length} VLANs${
      site.wireguard ? " + VPN" : ""
    }<br>${
      esc(site.networks.filter((x) => x.vlan).map((x) => `${x.name} ${x.vlan}`).join(" · "))
    }</dd></div>
      <div><dt>Wi-Fi</dt><dd>${site.wifi.length} SSIDs<br>${
      esc(site.wifi.map((w) => w.ssid).join(" · "))
    }</dd></div>
      <div><dt>Inbound from internet</dt><dd>${
      esc(site.security.inbound)
    }<br>${site.security.portForwards} port forwards · UPnP ${
      site.security.upnp ? "on" : "off"
    }</dd></div>
      <div><dt>Intrusion prevention</dt><dd>${esc(site.security.ips)}</dd></div>
      <div><dt>Network boot</dt><dd>${esc(boot.host)} ${
      esc(boot.address)
    }<br>TFTP ${boot.tftp} + HTTP ${boot.http}</dd></div>
    </dl>`,
  );

  add(
    "networks",
    "Networks and VLANs",
    table(
      [
        "Network",
        "VLAN",
        "Subnet",
        "Gateway",
        "Zone",
        "DHCP",
        "Network boot",
        "mDNS proxy",
        "IPv6",
        "Notes",
      ],
      site.networks.map((x) => [
        x.name,
        x.vlan ?? "-",
        x.cidr6 ? `${x.cidr} · ${x.cidr6}` : x.cidr,
        x.gateway,
        x.zone,
        typeof x.dhcp === "string" ? x.dhcp.replace(/-/g, " ") : `${x.dhcp.from} to ${x.dhcp.to}`,
        x.netboot ? `${x.netboot.server} / ${x.netboot.file}` : "-",
        x.mdnsReflect ? "in scope" : "-",
        x.ipv6 ? "routed" : "no",
        x.notes ?? "",
      ]),
    ),
  );

  add(
    "wifi",
    "Wi-Fi",
    table(
      ["SSID", "Network", "Bands (GHz)", "Security", "PMF", "Notes"],
      site.wifi.map((
        w,
      ) => [
        w.ssid,
        w.network,
        w.bands.join(" · "),
        w.security.toUpperCase(),
        w.pmf,
        `${w.guest ? "Guest. " : ""}${w.notes ?? ""}`,
      ]),
    ) + `<p class="note">Passwords live in UniFi and the owner's password manager, never here.</p>`,
  );

  add(
    "policies",
    "Firewall zones and policies",
    `<p>Zones: ${
      esc(site.zones.join(", "))
    }. Each network belongs to exactly one zone; UniFi's zone defaults apply, and these are the custom policies.</p>` +
      table(
        ["#", "Name", "From", "To", "Match", "Action", "Purpose"],
        site.policies.map((p) => [
          p.id,
          p.name,
          `${p.from.zone}${
            p.from.cidr ? ` ${p.from.cidr}` : p.from.network ? ` (${p.from.network})` : ""
          }`,
          `${p.to.zone}${p.to.address ? ` ${p.to.address}` : ""}`,
          match(p),
          action(p.action),
          p.purpose,
        ]),
      ),
  );

  add(
    "dns",
    "DNS and discovery",
    `<p>Upstream resolvers: ${esc(site.dns.upstream.join(", "))} (Auto DNS Server ${
      site.dns.autoDns ? "on" : "off"
    }). Clients ask the gateway, which answers the Local DNS records below. Services are found by these names, never by multicast (Article 20).</p>` +
      table(
        ["Local DNS record", "Address"],
        site.dns.localRecords.map((r) => [r.name, r.address]),
      ) +
      `<h3>mDNS proxy</h3><p>Scope: ${
        esc(site.mdnsProxy.networks.join(", "))
      }. Repeated services: ${
        esc(site.mdnsProxy.services.join(", "))
      }. Servers and DMZ are never in the scope.</p>`,
  );

  if (site.wireguard || site.ddns) {
    const wg = site.wireguard;
    add(
      "remote",
      "Remote access",
      (wg
        ? table(["WireGuard", ""], [
          ["Server", wg.name],
          ["Listen", `UDP ${wg.listen}`],
          ["Endpoint for clients", `${wg.endpoint}:${wg.listen}`],
          ["Tunnel network", `${wg.network} (${n(wg.network)?.cidr ?? "?"})`],
          ["Clients", wg.clients.map((c) => `${c.name} ${c.address}`).join("; ")],
          ["Reaches", wg.reach.join(", ")],
        ])
        : "") +
        (site.ddns
          ? table(["Dynamic DNS", ""], [
            ["Provider", site.ddns.provider],
            [
              "Record",
              `${site.ddns.record} ${site.ddns.type} (${
                site.ddns.proxied ? "proxied" : "DNS only"
              })`,
            ],
            ["Zone", site.ddns.zone],
          ])
          : "") +
        `<p class="note">Keys and tokens stay in UniFi and on the clients.</p>`,
    );
  }

  const bootNets = site.networks.filter((x) => x.netboot);
  add(
    "boot",
    "Network boot (Archon)",
    `<p>Boot server: ${esc(boot.host)} at ${esc(boot.address)} on ${
      esc(boot.network)
    }, TFTP UDP ${boot.tftp} and HTTP TCP ${boot.http}. A network that boots from it needs Network Boot (${
      esc(boot.address)
    } / bootx64.efi) and, outside the boot server's zone, two policies to ${
      esc(boot.address)
    }: UDP ${boot.tftp} and TCP ${boot.http}.</p>` +
      table(
        ["Network", "Next server / file", "Policies"],
        bootNets.map((x) => [
          x.name,
          `${x.netboot!.server} / ${x.netboot!.file}`,
          x.zone === n(boot.network)?.zone
            ? "same zone as the boot server"
            : site.policies.filter((p) => p.from.zone === x.zone && p.to.address === boot.address)
              .map((p) => `#${p.id}`).join(", ") || "MISSING",
        ]),
      ),
  );

  add(
    "hosts",
    "Devices, hosts, and switch ports",
    table(
      ["Name", "Address", "Network", "How", "DNS name", "Switch port"],
      [
        ...site.devices.map((
          d,
        ) => [d.name, d.address, d.network, d.how.replace(/-/g, " "), "", ""]),
        ...hosts.filter((h) => h.network || h.ip).map((
          h,
        ) => [
          h.name,
          h.ip ?? "-",
          h.network ?? "-",
          "fixed (Archon host)",
          h.dnsName ?? "-",
          h.switchPort ?? "-",
        ]),
      ],
    ),
  );

  add(
    "secrets",
    "Where secrets live",
    `<p>Names and places only. Boot-machine secrets are backed up as one ZIP (deno task boot vault backup) that the owner keeps somewhere safe and encrypted.</p>` +
      table(
        ["Secret", "Holder", "Where", "If lost"],
        SECRET_INVENTORY.map((
          s,
        ) => [
          s.purpose,
          s.holder === "owner" ? "owner" : "boot machine",
          s.holder === "owner" ? s.path : `%APPDATA%\\archon\\secrets\\${s.path}`,
          s.recreate,
        ]),
      ),
  );

  if (o.problems?.length) {
    add(
      "problems",
      "Model checks",
      `<ul class="problems">${o.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`,
    );
  }

  const nav = sections.map(([id, t], i) => `<a href="#${id}">${i + 1} ${esc(t)}</a>`).join("");
  const body = sections.map(([id, t, b], i) =>
    `<section id="${id}"><h2><span>${i + 1}</span> ${esc(t)}</h2>${b}</section>`
  ).join("\n");
  return `<!doctype html>
<!-- GENERATED by archon build from fleets/<fleet>/site.ts (spec 028). Do not edit. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(site.name)} network</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--accent:#2f5d8a;--head:#f1f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#171716;--fg:#e9e8e4;--muted:#9c9b95;--line:#33322f;--accent:#8db3db;--head:#22211f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:40px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}
h2 span{color:var(--muted);font-weight:400;margin-right:6px}h3{font-size:16px;margin:20px 0 8px}
.sub{color:var(--muted);margin:0 0 20px}nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 8px}nav a{color:var(--accent);text-decoration:none;font-size:14px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px;display:block;overflow-x:auto}
th,td{text-align:left;vertical-align:top;padding:6px 10px;border-bottom:1px solid var(--line)}th{background:var(--head);font-weight:600}
.glance{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:0}
.glance div{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.glance dt{color:var(--muted);font-size:13px}.glance dd{margin:2px 0 0}
.note{color:var(--muted);font-size:13px}.problems li{color:#b4532a}
</style></head><body><main>
<h1>${esc(site.name)} network</h1>
<p class="sub">Technical reference, generated from the Archon site model${
    o.commit ? ` at ${esc(o.commit)}` : ""
  }. The router is the authority: UniFi changes come first, then the model (constitution Article 21). No passwords or keys appear here.</p>
<nav>${nav}</nav>
${body}
</main></body></html>
`;
}
