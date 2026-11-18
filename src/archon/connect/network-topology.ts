/**
 * Spec 110-network-assets FR-007, FR-008: the topology the uplink edges give, laid out by a typed function and drawn as SVG on the server
 * (no graph library, no script). The gateway is at the top, below it the switches and access points it connects, and under each device
 * its clients (a few by name, then "+N more"). A device with no uplink in the API's answer that is not a gateway is not guessed a
 * parent: it is drawn apart, in a row of its own, and the page says why.
 *
 * ```mermaid
 * flowchart TB
 *   v["NetworkView: devices, clients, uplinks"] --> t["topology: roots, children, orphans"]
 *   t --> l["layoutTopology: one slot per leaf,<br/>a parent over its children"]
 *   l --> s["topologySvg: nodes, links, titles (escaped)"]
 * ```
 *
 * @example
 * ```ts
 * import { layoutTopology, topology } from "./network-topology.ts";
 * import { buildNetworkView } from "./network-view.ts";
 * const t = topology(buildNetworkView({ observations: [], assets: [], machines: [] }));
 * layoutTopology(t).nodes.length; // 0
 * ```
 *
 * @module
 */
// Spec: 110-network-assets FR-007, FR-008

import type { DeviceClass } from "./network-class.ts";
import type { NetworkView } from "./network-view.ts";

/** One node of the drawing: a device, a client, or the "+N more" of a device's clients. */
export interface TopoNode {
  /** Its key (a device's or a client's id at the controller). */
  key: string;
  /** What it is. */
  kind: "device" | "client" | "more";
  /** Its label. */
  label: string;
  /** A second line (a model, an address). */
  sub?: string;
  /** A device's class. */
  class?: DeviceClass;
  /** A device's state at the controller. */
  state?: string;
  /** The fleet's name for a device that is adopted. */
  asset?: string;
  /** What is below it. */
  children: TopoNode[];
  /** Where it is drawn (the centre), and its size, once laid out. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The trees of a view: those that start at a gateway or a device the API gave no parent to, and the devices drawn apart. */
export interface Topology {
  /** Trees from the top: a gateway, or a device with no uplink (a gateway first). */
  roots: TopoNode[];
  /** Devices that are not a gateway and have no uplink in the answer (no edge is guessed). */
  orphans: TopoNode[];
  /** What the drawing leaves out and why. */
  notes: string[];
}

const node = (n: Omit<TopoNode, "children" | "x" | "y" | "w" | "h">): TopoNode => ({
  ...n,
  children: [],
  x: 0,
  y: 0,
  w: n.kind === "device" ? 136 : 116,
  h: n.kind === "device" ? 46 : 26,
});

const ORDER: Readonly<Record<string, number>> = { gateway: 0, switch: 1, "access-point": 2 };

/** The trees of a network view: the uplink edges give the parents, the clients hang under their device. */
export function topology(view: NetworkView, o: { maxClients?: number } = {}): Topology {
  const maxClients = o.maxClients ?? 4;
  const nodes = new Map<string, TopoNode>();
  for (const r of view.devices) {
    const d = r.device;
    nodes.set(
      d.id,
      node({
        key: d.id,
        kind: "device",
        label: r.asset ?? d.name,
        sub: `${d.model}${d.ip ? ` · ${d.ip}` : ""}`,
        class: d.class,
        state: d.state,
        ...(r.asset === undefined ? {} : { asset: r.asset }),
      }),
    );
  }
  const order = (a: TopoNode, b: TopoNode): number =>
    (ORDER[a.class ?? ""] ?? 9) - (ORDER[b.class ?? ""] ?? 9) || a.label.localeCompare(b.label);
  const roots: TopoNode[] = [];
  const orphans: TopoNode[] = [];
  const placed = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const r of view.devices) {
    if (
      r.device.uplink !== undefined &&
      nodes.has(r.device.uplink) &&
      r.device.uplink !== r.device.id
    ) {
      parentOf.set(r.device.id, r.device.uplink);
    }
  }
  // A cycle (a device whose chain of parents returns to itself) is cut at the device that closes it: it is a root.
  for (const id of parentOf.keys()) {
    const seen = new Set<string>([id]);
    for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p)) {
      if (seen.has(p)) {
        parentOf.delete(id);
        break;
      }
      seen.add(p);
    }
  }
  for (const [id, n] of nodes) {
    const p = parentOf.get(id);
    if (p !== undefined) nodes.get(p)?.children.push(n);
  }
  for (const [id, n] of nodes) {
    if (parentOf.has(id)) continue;
    (n.class === "gateway" || n.children.length ? roots : orphans).push(n);
  }
  roots.sort(order);
  orphans.sort(order);
  const clients = view.clients.filter((c) => c.client.uplink !== undefined);
  const visit = (n: TopoNode): void => {
    if (placed.has(n.key)) return;
    placed.add(n.key);
    n.children.sort(order);
    for (const c of n.children) visit(c);
    const mine = clients.filter((c) => c.client.uplink === n.key);
    for (const c of mine.slice(0, maxClients)) {
      n.children.push(
        node({
          key: c.client.id,
          kind: "client",
          label: c.match?.machine ?? c.client.name,
          sub: c.client.ip ?? "",
        }),
      );
    }
    if (mine.length > maxClients) {
      n.children.push(
        node({
          key: `${n.key}:more`,
          kind: "more",
          label: `+${mine.length - maxClients} more client${mine.length - maxClients === 1 ? "" : "s"}`,
        }),
      );
    }
  };
  for (const n of [...roots, ...orphans]) visit(n);
  const notes: string[] = [];
  if (orphans.length) {
    notes.push(
      `${orphans.length} device${orphans.length === 1 ? "" : "s"} the API gave no uplink for (drawn apart: no edge is guessed)`,
    );
  }
  const loose = view.clients.filter(
    (c) => c.client.uplink === undefined || !nodes.has(c.client.uplink),
  ).length;
  if (loose) {
    notes.push(
      `${loose} client${loose === 1 ? "" : "s"} with no device to hang under (a VPN client has none)`,
    );
  }
  return { roots, orphans, notes };
}

/** A drawing: every node with its place, the links between a parent and its children, and the size. */
export interface Layout {
  /** Every node, with `x`, `y`, `w` and `h` set (the centre of the node). */
  nodes: TopoNode[];
  /** A parent to a child. */
  links: Array<{ from: TopoNode; to: TopoNode }>;
  /** The width of the drawing. */
  width: number;
  /** The height of the drawing. */
  height: number;
  /** Where the row of devices without an uplink starts, when there is one. */
  orphanY?: number;
}

const GAP_X = 16;
const GAP_Y = 44;
const PAD = 16;

/**
 * Lay a topology out: a leaf takes the next slot from the left, a parent is centred over its first and last child, a level is a row.
 * The devices without an uplink are laid out apart, below the trees, with a gap.
 */
export function layoutTopology(t: Topology): Layout {
  const nodes: TopoNode[] = [];
  const links: Layout["links"] = [];
  let cursor = PAD;
  const levelH: number[] = [];
  const place = (n: TopoNode, depth: number): void => {
    nodes.push(n);
    levelH[depth] = Math.max(levelH[depth] ?? 0, n.h);
    for (const c of n.children) {
      place(c, depth + 1);
      links.push({ from: n, to: c });
    }
    if (n.children.length === 0) {
      n.x = cursor + n.w / 2;
      cursor += n.w + GAP_X;
    } else {
      const first = n.children[0] as TopoNode;
      const last = n.children[n.children.length - 1] as TopoNode;
      n.x = (first.x + last.x) / 2;
    }
  };
  const rowTops = (): number[] => {
    const tops: number[] = [];
    let y = PAD;
    for (const h of levelH) {
      tops.push(y);
      y += h + GAP_Y;
    }
    return tops;
  };
  const assign = (n: TopoNode, depth: number, tops: number[], base: number): void => {
    n.y = base + (tops[depth] ?? PAD) + n.h / 2;
    for (const c of n.children) assign(c, depth + 1, tops, base);
  };
  for (const r of t.roots) place(r, 0);
  const treeTops = rowTops();
  const treeBottom = treeTops.length
    ? (treeTops[treeTops.length - 1] ?? 0) + (levelH[levelH.length - 1] ?? 0) + PAD
    : PAD;
  for (const r of t.roots) assign(r, 0, treeTops, 0);
  let orphanY: number | undefined;
  let treeWidth = cursor;
  if (t.orphans.length) {
    orphanY = treeBottom + GAP_Y;
    treeWidth = cursor;
    cursor = PAD;
    levelH.length = 0;
    for (const o of t.orphans) place(o, 0);
    const tops = rowTops();
    for (const o of t.orphans) assign(o, 0, tops, orphanY - PAD);
  }
  const width = Math.max(cursor, treeWidth, 2 * PAD);
  const height = Math.max(...nodes.map((n) => n.y + n.h / 2 + PAD), 2 * PAD);
  return { nodes, links, width, height, ...(orphanY === undefined ? {} : { orphanY }) };
}

/** Text safe in SVG and HTML. */
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The glyph of a class: strokes in a 16 by 16 box (`currentColor`), the same everywhere a class is shown (the machines table, the
 * topology, a device's page).
 */
export function classGlyph(c: DeviceClass | "client"): string {
  switch (c) {
    case "gateway":
      return `<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.5 2.5 2.5 9.5 0 12M8 2c-2.5 2.5-2.5 9.5 0 12"/>`;
    case "switch":
      return `<rect x="1.5" y="4.5" width="13" height="7" rx="1"/><path d="M4 8h.01M6.5 8h.01M9 8h.01M11.5 8h.01"/>`;
    case "access-point":
      return `<path d="M2.5 6.5a8 8 0 0 1 11 0M4.7 8.9a5 5 0 0 1 6.6 0M6.9 11.2a2 2 0 0 1 2.2 0"/><circle cx="8" cy="13" r=".6"/>`;
    case "camera":
      return `<rect x="1.5" y="4.5" width="9" height="7" rx="1"/><path d="M10.5 7.5l4-2v5l-4-2"/>`;
    case "recorder":
      return `<rect x="1.5" y="3.5" width="13" height="9" rx="1"/><circle cx="8" cy="8" r="2.2"/>`;
    case "door-controller":
      return `<rect x="3.5" y="1.5" width="9" height="13" rx="1"/><circle cx="10.5" cy="8.5" r=".7"/>`;
    case "phone":
      return `<rect x="4" y="1.5" width="8" height="13" rx="1.5"/><path d="M6.5 11.5h3"/>`;
    case "client":
      return `<rect x="2" y="3.5" width="12" height="8" rx="1"/><path d="M5.5 13.5h5"/>`;
    case "other":
      return `<path d="M8 1.5l6.5 6.5L8 14.5 1.5 8z"/>`;
  }
}

/** A glyph as a small inline SVG (for a table cell or a heading). */
export function glyphSvg(c: DeviceClass | "client", size = 16): string {
  return `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${classGlyph(c)}</svg>`;
}

/**
 * The drawing as SVG text. The colours are the console's own variables (with fallbacks), so it follows light and dark; every label is
 * escaped. `href` makes a node a link (a device's page).
 */
export function topologySvg(
  l: Layout,
  o: { label?: string; href?: (n: TopoNode) => string | undefined } = {},
): string {
  const link = (a: TopoNode, b: TopoNode): string => {
    const y1 = a.y + a.h / 2;
    const y2 = b.y - b.h / 2;
    const m = (y1 + y2) / 2;
    return `<path class="lk" d="M${a.x} ${y1}V${m}H${b.x}V${y2}"/>`;
  };
  const draw = (n: TopoNode): string => {
    const x = n.x - n.w / 2;
    const y = n.y - n.h / 2;
    const cls = n.kind === "device" ? (n.class ?? "other") : n.kind;
    const bad = n.kind === "device" && n.state !== undefined && n.state !== "ONLINE";
    const inner =
      n.kind === "device"
        ? `<rect x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="6"${bad ? ' class="off"' : ""}/>
<g transform="translate(${x + 8} ${y + 6})" class="gl">${classGlyph(n.class ?? "other")}</g>
<text x="${x + 30}" y="${y + 19}" class="t1">${esc(clip(n.label, 16))}</text>
<text x="${x + 30}" y="${y + 34}" class="t2">${esc(clip(n.sub ?? "", 19))}</text>`
        : n.kind === "client"
          ? `<rect x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="13"/>
<text x="${n.x}" y="${y + 17}" class="t3" text-anchor="middle">${esc(clip(n.label, 16))}</text>`
          : `<text x="${n.x}" y="${y + 17}" class="t2" text-anchor="middle">${esc(n.label)}</text>`;
    const href = o.href?.(n);
    const title = `<title>${esc(`${n.label}${n.sub ? `, ${n.sub}` : ""}${n.state ? `, ${n.state}` : ""}`)}</title>`;
    const g = `<g class="n n-${esc(cls)}">${title}${inner}</g>`;
    return href === undefined ? g : `<a href="${esc(href)}">${g}</a>`;
  };
  return `<svg class="topo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(l.width)} ${Math.ceil(l.height)}" width="${Math.ceil(l.width)}" height="${Math.ceil(l.height)}" role="img" aria-label="${esc(o.label ?? "Network topology")}">
<style>
.topo .lk{fill:none;stroke:var(--line,#b8bcc4);stroke-width:1.4}
.topo .n rect{fill:var(--panel,#fff);stroke:var(--line,#b8bcc4);stroke-width:1.2}
.topo .n rect.off{stroke:var(--bad,#c0392b)}
.topo .n-client rect{fill:var(--rail,#f3f4f6)}
.topo .t1{font:600 12px var(--sans,system-ui,sans-serif);fill:var(--ink,#111)}
.topo .t2{font:11px var(--sans,system-ui,sans-serif);fill:var(--muted,#6b7280)}
.topo .t3{font:11px var(--sans,system-ui,sans-serif);fill:var(--ink,#111)}
.topo .gl{fill:none;stroke:var(--accent,#2563eb);stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}
.topo a{cursor:pointer}
</style>
${l.links.map((k) => link(k.from, k.to)).join("\n")}
${l.nodes.map(draw).join("\n")}
</svg>`;
}
