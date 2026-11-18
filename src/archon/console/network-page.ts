/**
 * Spec 110-network-assets FR-002, FR-008, FR-009: the Network page of the Stolos Console, shown only where a router-kind integration is
 * connected: the topology (SVG drawn on the server from the uplink edges), the console's one table (AG Grid, `table.ts`) of devices,
 * clients, VLANs and Wi-Fi networks, one device's page with its facts and an **Open in UniFi** link, and the class and way-of-joining badges
 * the machines table uses. The page holds no logic: it draws `NetworkView` (`connect/network-view.ts`).
 *
 * @module
 */
// Spec: 110-network-assets FR-002, FR-008, FR-009, FR-012

import { CLASS_LABEL, CLASS_PLURAL } from "../connect/network-class.ts";
import { glyphSvg, layoutTopology, topology, topologySvg } from "../connect/network-topology.ts";
import { NOT_GIVEN } from "../connect/network-view.ts";
import { integrationBadge } from "../adopt/joining.ts";
import type { DeviceClass } from "../ontology.auto.ts";
import { type Html, html, raw } from "./html.ts";
import type { NavItem } from "./layout.ts";
import type { PcFacts, PcMachine } from "./pc.ts";
import { tableMarkup, tableScript } from "./table.ts";
import { tagChips } from "./tags.ts";

/** The menu with the Network entry, present only where a router-kind integration is connected (spec 110-network-assets FR-008). */
export function withNetworkNav(nav: NavItem[], f: Pick<PcFacts, "network">): NavItem[] {
  if (!f.network) return nav;
  const at = nav.findIndex((n) => n.href === "/machines");
  const item: NavItem = { group: "Fleet", label: "Network", href: "/network" };
  return at < 0 ? [...nav, item] : [...nav.slice(0, at + 1), item, ...nav.slice(at + 1)];
}

/** A class as an icon and its label. */
export function classBadge(c: DeviceClass): Html {
  return html`<span class="pill tier" title="${CLASS_LABEL[c]}"
    >${raw(glyphSvg(c, 14))} ${CLASS_LABEL[c]}</span
  >`;
}

/** The badge of a network asset: `Adopted via UniFi`, or `Auto-adopted via UniFi`, its title naming the connected account. */
export function integrationPill(x: Pick<PcMachine, "network">): Html {
  const n = x.network;
  if (!n) return html``;
  return html`<span
    class="pill tier"
    title="${integrationBadge({ title: n.viaTitle, auto: n.auto })}, account ${n.account}"
    >${integrationBadge({ title: n.viaTitle, auto: n.auto })}</span
  >`;
}

/** The link to the native console for a device, built from the connector's address (UniFi OS path; the controller's own console decides the rest). */
export function openInUnifi(account: string, mac: string): string {
  return `https://${account}/network/default/devices/properties/${encodeURIComponent(mac)}`;
}

/** The link to the native console for the account. */
export function openAccount(account: string): string {
  return `https://${account}/network`;
}

const rowsOf = <T extends Record<string, unknown>>(
  list: T[],
  id: (r: T, i: number) => string,
): Array<T & { __id: string }> => list.map((r, i) => ({ ...r, __id: id(r, i) }));

/** The Network page. */
export function networkPage(f: PcFacts): Html {
  const n = f.network;
  if (!n) return html`<p class="sub">No router is connected.</p>`;
  const v = n.view;
  const topo = topology(v);
  const svg = topologySvg(layoutTopology(topo), {
    label: "Network topology: uplinks between devices, clients under their device",
    href: (node) =>
      node.kind === "device" ? `/network/devices/${encodeURIComponent(node.key)}` : undefined,
  });
  const dev = rowsOf(
    v.devices.map((r) => ({
      name: r.asset ?? r.device.name,
      class: CLASS_LABEL[r.device.class],
      model: r.device.model,
      firmware: r.device.firmware,
      address: r.device.ip,
      state: r.device.state,
      uplink: r.uplinkName ?? "",
      clients: r.clients,
      "how it joined": r.asset ? "adopted" : "discovered, not adopted",
    })),
    (r) => `dev:${r.name}`,
  );
  const cli = rowsOf(
    v.clients.map((c) => ({
      name: c.match?.machine ?? c.client.name,
      type: c.client.kind,
      address: c.client.ip ?? "",
      mac: c.client.mac ?? "",
      "connected through": c.uplinkName ?? "",
      guest: c.client.guest === true ? "yes" : "no",
      "last connected": c.client.connectedAt ?? "",
      fleet: c.match ? `machine (${c.match.by})` : "unmanaged",
    })),
    (_r, i) => `cli:${i}`,
  );
  const vl = rowsOf(
    v.vlans.map((x) => ({
      name: x.name,
      "VLAN id": x.vlanId,
      enabled: x.enabled ? "yes" : "no",
      default: x.default ? "yes" : "no",
    })),
    (r) => `vlan:${r.name}`,
  );
  const ss = rowsOf(
    v.ssids.map((x) => ({
      name: x.name,
      security: x.security,
      enabled: x.enabled ? "yes" : "no",
      guest: x.guest ? "yes" : "no",
      "broadcast by": x.broadcastBy
        ? x.broadcastBy
            .map((id) => v.devices.find((d) => d.device.id === id)?.device.name ?? id)
            .join(", ")
        : "every access point",
    })),
    (r) => `ssid:${r.name}`,
  );
  const table = (id: string, label: string, rows: Parameters<typeof tableMarkup>[0]["rows"]) =>
    tableMarkup({
      id,
      label,
      csvName: id,
      rows: rows ?? [],
      first: ["name"],
      last: [],
      empty: `No ${label.toLowerCase()}`,
    });
  return html`
    ${tableScript()}
    <div class="pagehead">
      <div>
        <div class="crumb">${f.fleet.title}</div>
        <h1>Network</h1>
        <p>
          What ${n.connectors.map((c) => c.title).join(", ")} manages, read-only: the devices (the
          fleet's assets once adopted), the clients, the networks and the Wi-Fi. Stolos never
          changes it.
        </p>
      </div>
      <div class="row">
        ${n.connectors.map(
          (c) =>
            html`<a
              class="btn ghost"
              href="${openAccount(c.account)}"
              target="_blank"
              rel="noopener"
              >Open in ${c.title}</a
            >`,
        )}
      </div>
    </div>
    ${
      v.gone.length
        ? html`<div class="notice bad" id="gone">
            ${v.gone.map(
              (g) =>
                html`<p>
                  <b>${g.asset.name} is gone from the integration:</b> ${g.asset.via} no longer
                  reports it. Observe again (<span class="mono"
                    >stolos estate observe ${g.asset.via}</span
                  >) or release it (<span class="mono">stolos host release ${g.asset.name}</span>);
                  it is never removed for you.
                </p>`,
            )}
          </div>`
        : ""
    }
    <div class="grid cols-3">
      ${(v.counts.length ? v.counts : []).map(
        (c) =>
          html`<div class="card">
            <div class="k">${CLASS_LABEL[c.class]}</div>
            <div class="v">${c.adopted} adopted</div>
            <div class="sub">${c.discovered} ${CLASS_PLURAL[c.class]} discovered, not adopted</div>
          </div>`,
      )}
    </div>
    <div class="card scroll" id="topology" style="margin-top:14px">
      <h2>Topology</h2>
      ${v.devices.length ? raw(svg) : html`<p class="sub">No device read yet: stolos estate observe unifi.</p>`}
      ${topo.notes.map((x) => html`<p class="sub">${x}</p>`)}
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Devices</h2>
      ${table("devices", "Devices", dev)}
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Clients</h2>
      <p class="sub">
        Observed, never adopted. ${v.unmanaged.length} unmanaged: to bring a machine into the fleet
        run <span class="mono">stolos pair</span>.
      </p>
      ${table("clients", "Clients", cli)}
    </div>
    <div class="card" style="margin-top:14px">
      <h2>VLANs</h2>
      ${table("vlans", "VLANs", vl)}
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Wi-Fi networks</h2>
      ${table("ssids", "Wi-Fi networks", ss)}
    </div>
    <div class="card" style="margin-top:14px" id="gaps">
      <h2>What the API does not give</h2>
      <ul>
        ${NOT_GIVEN.map((g) => html`<li>${g}</li>`)}
      </ul>
      ${
        v.gaps.length
          ? html`<h3>Not readable this time</h3>
              <ul>
                ${v.gaps.map((g) => html`<li class="mono">${g}</li>`)}
              </ul>`
          : ""
      }
    </div>
  `;
}

/** One device's page: its facts, its uplink, its clients, its Wi-Fi, and the link to the native console. */
export function networkDevicePage(f: PcFacts, id: string): Html | undefined {
  const r = f.network?.view.devices.find((d) => d.device.id === id);
  if (!r || !f.network) return undefined;
  const d = r.device;
  const machine = f.machines.find((m) => m.name === r.asset);
  const clients = f.network.view.clients.filter((c) => c.client.uplink === d.id);
  const row = (k: string, v: string | undefined) =>
    v === undefined || v === ""
      ? ""
      : html`<tr>
          <td class="sub">${k}</td>
          <td>${v}</td>
        </tr>`;
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb"><a href="/network">Network</a></div>
        <h1>${r.asset ?? d.name} ${classBadge(d.class)}</h1>
        <p>
          ${
            r.asset
              ? html`An asset of the fleet: ${machine ? integrationPill(machine) : ""} (<a
                    href="/machines/${encodeURIComponent(r.asset)}"
                    >its machine page</a
                  >).`
              : html`Discovered via ${d.via}, not adopted:
                  <span class="mono">stolos network adopt ${d.name}</span>.`
          }
        </p>
      </div>
      <a class="btn" href="${openInUnifi(d.account, d.mac)}" target="_blank" rel="noopener"
        >Open in UniFi</a
      >
    </div>
    ${machine?.tags?.length ? html`<div class="card" id="tags" style="margin-bottom:14px">${tagChips(machine.tags)}</div>` : ""}
    <div class="grid cols-2">
      <div class="card">
        <h2>Facts</h2>
        <table>
          <tbody>
            ${row("Name at the controller", d.name)}${row("Class", CLASS_LABEL[d.class])}${row("Facets", d.facets.join(", "))}
            ${row("Model", d.model)}${row("MAC", d.mac)}${row("Address", d.ip)}${row("State", d.state)}
            ${row("Firmware", d.firmware + (d.firmwareUpdatable ? " (an update is waiting)" : ""))}
            ${row("Connected through", r.uplinkName)}${row("Site", d.site)}${row("Wi-Fi networks", r.ssids.join(", "))}
          </tbody>
        </table>
        <p class="sub">The API gives no serial number: the MAC is its identity.</p>
      </div>
      <div class="card">
        <h2>Clients (${clients.length})</h2>
        ${
          clients.length
            ? html`<ul>
                ${clients.slice(0, 50).map((c) => html`<li>${c.match?.machine ?? c.client.name} <span class="sub mono">${c.client.ip ?? ""}</span></li>`)}
              </ul>`
            : html`<p class="sub">None connected through it.</p>`
        }
      </div>
    </div>
  `;
}
