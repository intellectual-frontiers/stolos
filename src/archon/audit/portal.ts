/**
 * Spec 083: the auditor portal, served by the Stolos Console on 127.0.0.1.
 *
 * - `stolos audit portal <id>` starts the console and prints a one-time link
 *   (`/audit/launch?t=...`, two minutes, once) that becomes an audit-scoped
 *   session: it sees only `/audit/<id>/` and `/v1/audit/<id>/`, read-only
 *   (GET and HEAD), for at most {@link AUDIT_SESSION_MS}, and every request
 *   is refused once the engagement has expired or been closed.
 * - A fleet operator signed in to the console sees the same pages.
 *
 * | Page (HTML under `/audit/<id>/`, JSON under `/v1/audit/<id>/`) | What it shows |
 * | --- | --- |
 * | `` (the engagement) | the firm, the period, the controls in scope with their populations, the bundle's verification |
 * | `controls/<control>` | the population: every unit with its facts and evidence; a draw preview from a seed |
 * | `samples/<seq>` | a recorded sample: each unit's evidence items, their SHA-256, place in the manifest, chain link |
 * | `items/<sha256>` | one item: its text, hash, and manifest entry (`/raw` downloads it) |
 * | `trail` | requests, responses, and samples in order, each with its commit and signer |
 * | `verify` | `verifyBundle` and every check of the engagement, run now |
 * | `bundle.zip`, `export.zip` | the evidence bundle, and the export package to verify offline |
 *
 * ```mermaid
 * sequenceDiagram
 *   participant O as Operator (terminal)
 *   participant C as Stolos Console (127.0.0.1)
 *   participant A as Auditor (browser on this PC)
 *   O->>C: stolos audit portal soc2-2026
 *   C-->>O: /audit/launch?t=... (once, two minutes)
 *   A->>C: the link
 *   C-->>A: an audit-scoped session: /audit/soc2-2026/ only
 *   A->>C: GET /audit/soc2-2026/samples/3
 *   C-->>A: each item, its SHA-256, its manifest entry, verifyBundle's result
 * ```
 *
 * @module
 */

import type { Session } from "../console/auth.ts";
import { type Html, html } from "../console/html.ts";
import { bare } from "../console/layout.ts";
import { htmlResponse } from "../console/server.ts";
import { type AuditCase, caseProblems, type CheckedEntry } from "./case.ts";
import { accessEnds, engagementState, type ScopedControl } from "./engagement.ts";
import { type BundleItem, type Population, populationDef, type Unit } from "./populations.ts";
import { drawSample, SAMPLE_METHOD, SAMPLE_METHOD_DOC, SEED } from "./sample.ts";

/** How long an audit link works. */
export const AUDIT_LAUNCH_MS = 120_000;

/** How long an audit-scoped session lasts at most, however active (four hours). */
export const AUDIT_SESSION_MS = 4 * 3600_000;

/** The group an audit-scoped session carries: `audit:<engagement id>`. */
export const AUDIT_GROUP = "audit:";

/** One-time audit links, each for one engagement. */
export class AuditLaunch {
  #tokens = new Map<string, { id: string; at: number }>();
  #now: () => number;
  /** A clock (tests pass their own). */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  /** A new token for an engagement. */
  issue(id: string): string {
    const t = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((x) => x.toString(16).padStart(2, "0")).join("");
    this.#tokens.set(t, { id, at: this.#now() });
    return t;
  }
  /** The engagement a token is for: once, within AUDIT_LAUNCH_MS; else undefined. */
  redeem(t: string | null): string | undefined {
    if (!t) return undefined;
    const x = this.#tokens.get(t);
    this.#tokens.delete(t);
    return x && this.#now() - x.at <= AUDIT_LAUNCH_MS ? x.id : undefined;
  }
}

/** What the console needs to serve audits. */
export interface AuditDeps {
  /** The audit links. */
  launch: AuditLaunch;
  /** An engagement, read and checked (undefined: none with that id). */
  load(id: string): Promise<AuditCase | undefined>;
  /** The export package's bytes. */
  exportZip?(c: AuditCase): Promise<Uint8Array>;
  /** Now (tests pass their own). */
  now?(): Date;
}

/** The account an audit-scoped session is made for. */
export function auditAccount(id: string): { user: string; name: string; groups: string[] } {
  return { user: "auditor", name: `Auditor (${id})`, groups: [`${AUDIT_GROUP}${id}`] };
}

/** The engagement a session is scoped to, or undefined for an operator's session. */
export function auditScope(s: Pick<Session, "groups"> | undefined): string | undefined {
  return s?.groups.find((g) => g.startsWith(AUDIT_GROUP))?.slice(AUDIT_GROUP.length);
}

/** Whether a path is the portal's (HTML or JSON). */
export function isAuditPath(path: string): boolean {
  return path.startsWith("/audit/") || path.startsWith("/v1/audit/");
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json", ...HEADERS },
  });
}

function refuse(api: boolean, status: number, why: string): Response {
  return api ? json({ error: why }, status) : htmlResponse(
    bare(
      "Audit portal",
      html`
        <div class="card stack" style="max-width:560px;margin:12vh auto">
          <h1>Not available</h1>
          <p>${why}</p>
        </div>
      `,
    ),
    status,
  );
}

function download(bytes: Uint8Array, name: string, type: string): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": type,
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="${name}"`,
      ...HEADERS,
    },
  });
}

/** Links between the portal's pages: served ones, or anchors in the static export. */
export interface Links {
  /** The engagement's page. */
  home: string;
  /** A control's page. */
  control(id: string): string;
  /** A recorded sample's page. */
  sample(seq: number): string;
  /** An item's page, when served. */
  item?(sha256: string): string;
  /** An item's bytes, when served. */
  itemRaw?(sha256: string): string;
  /** The trail. */
  trail: string;
  /** The bundle, when served. */
  bundle?: string;
  /** The export package, when served. */
  export?: string;
}

/** The links of the served portal for an engagement. */
export function servedLinks(id: string): Links {
  const b = `/audit/${encodeURIComponent(id)}/`;
  return {
    home: b,
    control: (c) => `${b}controls/${encodeURIComponent(c)}`,
    sample: (n) => `${b}samples/${n}`,
    item: (s) => `${b}items/${s}`,
    itemRaw: (s) => `${b}items/${s}/raw`,
    trail: `${b}trail`,
    bundle: `${b}bundle.zip`,
    export: `${b}export.zip`,
  };
}

/** The links inside the static page of an export package (anchors). */
export const STATIC_LINKS: Links = {
  home: "#engagement",
  control: (c) => `#control-${c.replace(/[^A-Za-z0-9_-]/g, "_")}`,
  sample: (n) => `#sample-${n}`,
  trail: "#trail",
};

const pill = (ok: boolean, yes: string, no: string) =>
  html`<span class="pill ${ok ? "ok" : "bad"}">${ok ? yes : no}</span>`;

const factText = (v: unknown) => v === null || v === undefined ? "" : String(v);

/** The bundle items a unit's evidence names, from the bundle. */
function unitItems(c: AuditCase, u: Unit): BundleItem[] {
  const items = c.bundle?.view.items ?? [];
  return u.items.map((s) => items.find((i) => i.sha256 === s)).filter((x): x is BundleItem => !!x);
}

/** The JSON of a bundle item's manifest entry. */
function itemJson(i: BundleItem, l?: Links) {
  return {
    sha256: i.sha256,
    kind: i.kind,
    name: i.name,
    at: i.at,
    size: i.size,
    manifest: { index: i.index, chain: i.chain },
    ...(l?.itemRaw ? { href: l.itemRaw(i.sha256) } : {}),
  };
}

function entryJson(t: CheckedEntry) {
  return {
    path: t.file.path,
    ...(t.entry ?? {}),
    sha256: t.proof.sha256,
    commit: t.proof.commit ?? null,
    signer: t.proof.signer ?? null,
    problems: [...t.proof.problems, ...(t.redraw ?? [])],
  };
}

/** The engagement as JSON (`GET /v1/audit/<id>/`). */
export function engagementJson(c: AuditCase, now: Date): Record<string, unknown> {
  const e = c.engagement;
  return {
    engagement: e,
    state: engagementState(e, now),
    accessEnds: new Date(accessEnds(e)).toISOString(),
    commit: c.engagementProof.commit ?? null,
    signer: c.engagementProof.signer ?? null,
    bundle: c.bundle
      ? {
        file: e.bundle?.file,
        sha256: c.bundle.sha256,
        head: c.bundle.view.manifest.head,
        items: c.bundle.view.items.length,
        verified: c.bundle.verify.ok,
        signer: c.bundle.verify.signer ?? null,
      }
      : null,
    controls: e.controls.map((x) => {
      const p = c.populations.get(x.id);
      return { ...x, size: p?.units.length ?? null, hash: p?.hash ?? null };
    }),
    samples: c.trail.filter((t) => t.entry?.kind === "sample").map((t) => ({
      seq: t.entry!.seq,
      control: t.entry!.control,
      size: t.entry!.sample?.units.length,
    })),
    problems: caseProblems(c),
  };
}

function head(c: AuditCase, now: Date, l: Links, title: string): Html {
  const e = c.engagement;
  return html`
    <div class="pagehead">
      <div>
        <div
          class="crumb"><a href="${l.home}">${e.title}</a> · ${e.firm} · ${e.period.from} to ${e
            .period.to}</div>
        <h1>${title}</h1>
        <p class="sub">Read-only. Access ${engagementState(e, now) === "open"
          ? html`ends at the end of ${e.access.expires} (UTC)`
          : html`has ended`}.</p>
      </div>
      <div class="row">${l.bundle
        ? html`<a class="btn ghost" href="${l.bundle}" download>Evidence bundle</a>`
        : ""}${l.export
        ? html`<a class="btn ghost" href="${l.export}" download>Export package</a>`
        : ""}<a class="btn ghost" href="${l.trail}">Trail</a></div>
    </div>
  `;
}

function controlsTable(c: AuditCase, l: Links): Html {
  return html`
    <table>
      <thead>
        <tr>
          <th>Control</th>
          <th>Framework</th>
          <th>Population</th>
          <th>Units</th>
          <th>Population hash</th>
          <th>Samples</th>
        </tr>
      </thead>
      <tbody>${c.engagement.controls.map((x) => {
        const p = c.populations.get(x.id);
        const samples = c.trail.filter((t) =>
          t.entry?.kind === "sample" && t.entry.control === x.id
        );
        return html`
          <tr>
            <td><a href="${l.control(x.id)}"><b>${x.id}</b></a> ${x.title}</td>
            <td>${x.framework ?? ""}</td>
            <td>${populationDef(x.population)?.title ?? x.population}</td>
            <td>${p ? p.units.length : "no bundle"}</td>
            <td class="mono">${p ? p.hash.slice(0, 16) : ""}</td>
            <td>${samples.map((t) =>
              html`
                <a href="${l.sample(t.entry!.seq)}">#${t.entry!.seq}</a>
              `
            )}</td>
          </tr>
        `;
      })}</tbody>
    </table>
  `;
}

function verifyCard(c: AuditCase): Html {
  const problems = caseProblems(c);
  const v = c.bundle?.verify;
  return html`<div class="card stack">
    <h2>Verification ${
    pill(!problems.length, "everything checks out", `${problems.length} problem(s)`)
  }</h2>
    <p>${
    v
      ? html`The evidence bundle ${pill(v.ok, "verifies", "does not verify")}: every item unchanged,
        none missing or added, the chain whole, the manifest signed by ${
        v.signer ??
          "nobody the signers allow"
      }; ${
        v.commits.filter((x) => x.signer).length
      } of ${v.commits.length} commit(s) carry a valid signature.`
      : "No evidence bundle to verify yet."
  }</p>
    <p>engagement.ts is recorded in commit <span class="mono">${
    (c.engagementProof.commit ?? "none")
      .slice(0, 12)
  }</span>${c.engagementProof.signer ? html`, signed by ${c.engagementProof.signer}` : ""}.</p>
    ${problems.length ? html`<ul>${problems.map((p) => html`<li class="bad">${p}</li>`)}</ul>` : ""}
  </div>`;
}

/** The engagement's page. */
export function engagementPage(c: AuditCase, now: Date, l: Links): Html {
  const e = c.engagement;
  return html`
    ${head(c, now, l, "Engagement")}
    <div class="card stack" id="engagement">
      <p><b>${e.firm}</b>: ${e.auditors.map((a) => a.name).join(", ")}. Frameworks: ${e.frameworks
        .join(", ") || "none named"}. Opened ${e.opened.on} by ${e.opened.by}${e.closed
        ? html`; closed ${e.closed.on} by ${e.closed.by}`
        : ""}.</p>
      <p>Evidence: ${e.bundle
        ? html`<span class="mono">${e.bundle.file}</span>, SHA-256 <span class="mono">${e.bundle.sha256}</span>`
        : "no bundle pinned yet"}.</p>
    </div>
    ${verifyCard(c)}
    <div class="card scroll"><h2>Controls in scope</h2>${controlsTable(c, l)}</div>
  `;
}

function unitsTable(c: AuditCase, p: Population, l: Links, only?: string[]): Html {
  const units = only
    ? only.map((id) => p.units.find((u) => u.id === id)).filter((u): u is Unit => !!u)
    : p.units;
  const keys = [...new Set(units.flatMap((u) => Object.keys(u.facts)))];
  return html`
    <table>
      <thead>
        <tr><th>Unit</th>${keys.map((k) =>
          html`<th>${k}</th>`
        )}<th>Evidence (SHA-256, manifest entry)</th></tr>
      </thead>
      <tbody>${units.map((u) =>
        html`<tr>
        <td><b>${u.label}</b><div class="sub mono">${u.id}</div></td>
        ${keys.map((k) => html`<td>${factText(u.facts[k])}</td>`)}
        <td>${
          unitItems(c, u).map((i) =>
            html`<div class="mono">${
              l.item ? html`<a href="${l.item(i.sha256)}">${i.sha256.slice(0, 16)}</a>` : i.sha256
            } #${i.index} ${i.kind}</div>`
          )
        }</td>
      </tr>`
      )}</tbody>
    </table>
  `;
}

/** A control's page: its population, and a draw preview. */
export function controlPage(
  c: AuditCase,
  x: ScopedControl,
  now: Date,
  l: Links,
  draw?: { seed: string; size: number; units: string[] },
): Html {
  const p = c.populations.get(x.id);
  const def = populationDef(x.population);
  return html`
    ${head(c, now, l, `${x.id}: ${x.title}`)}
    <div class="card stack" id="${l.control(x.id).replace(/^.*#/, "")}">
      <h2>Population: ${def?.title ?? x.population}</h2>
      <p>One unit is ${def?.unit ?? "?"}. ${def?.doc ?? ""}</p>
      <p>${p
        ? html`${p.units.length} unit(s); population hash <span class="mono">${p.hash}</span>.`
        : "No evidence bundle: no population yet."}</p>
    </div>
    ${l.item && p
      ? html`
        <form class="card row" method="get">
          <label>Seed <input name="seed" required maxlength="256" value="${draw?.seed ??
            ""}"></label>
          <label>Sample size <input name="size" type="number" min="1" required value="${draw
            ?.size ??
            ""}"></label>
          <button class="btn" type="submit">Preview the draw</button>
          <span
            class="sub">${SAMPLE_METHOD}: ${SAMPLE_METHOD_DOC} A preview is not recorded: the company records the sample (stolos audit sample) in the trail.</span>
        </form>
      `
      : ""}
    ${draw && p
      ? html`
        <div
          class="card scroll"><h2>Draw preview (seed ${draw.seed}, ${draw.units
            .length} unit(s))</h2>${unitsTable(c, p, l, draw.units)}</div>
      `
      : ""}
    ${p ? html`<div class="card scroll"><h2>Every unit</h2>${unitsTable(c, p, l)}</div>` : ""}
  `;
}

/** A recorded sample's page: each unit's evidence, verifiable in place. */
export function samplePage(c: AuditCase, t: CheckedEntry, now: Date, l: Links): Html {
  const s = t.entry!.sample!;
  const p = [...c.populations.values()].find((x) => x.id === s.population);
  const problems = [...t.proof.problems, ...(t.redraw ?? [])];
  return html`
    ${head(c, now, l, `Sample #${t.entry!.seq}: ${s.control}`)}
    <div class="card stack" id="${l.sample(t.entry!.seq).replace(/^.*#/, "")}">
      <p>${s.units.length} of ${s.populationSize} unit(s) of ${s
        .population}, seed <span class="mono">${s
        .seed}</span>, method <span class="mono">${s
        .method}</span>, population hash <span class="mono">${s
        .populationHash}</span>. Recorded ${t.entry!.at} by ${t.entry!
        .by}, commit <span class="mono">${(t
          .proof.commit ?? "none").slice(0, 12)}</span>${t.proof.signer
        ? html`
          signed by ${t.proof.signer}
        `
        : ""}.</p>
      <p>${pill(
        !problems.length,
        "redrawn from its seed: the same units",
        "does not check out",
      )}</p>
      ${problems.length
        ? html`<ul>${problems.map((x) => html`<li class="bad">${x}</li>`)}</ul>`
        : ""}
      ${t.entry!.body ? html`<p>${t.entry!.body}</p>` : ""}
    </div>
    ${p
      ? html`<div class="card scroll"><h2>Each unit and its evidence</h2>${
        unitsTable(
          c,
          p,
          l,
          s.units,
        )
      }</div>`
      : ""}
    ${verifyCard(c)}
  `;
}

/** An item's page: its manifest entry, its text, its download. */
export function itemPage(c: AuditCase, i: BundleItem, now: Date, l: Links): Html {
  const text = i.content ? new TextDecoder().decode(i.content) : "";
  const shown = text.length > 200_000
    ? `${text.slice(0, 200_000)}\n... (download it for the rest)`
    : text;
  return html`
    ${head(c, now, l, `${i.kind}: ${i.name}`)}
    <div class="card stack">
      <p>SHA-256 <span class="mono">${i.sha256}</span>, ${i.size} bytes, recorded ${i.at}.</p>
      <p>Manifest entry #${i.index} of ${c.bundle?.view.items.length ??
        0}; its chain link <span class="mono">${i
        .chain}</span>. The manifest is signed by ${c.bundle?.verify.signer ??
        "nobody verified"}.</p>
      <p>Check it yourself: download it and run <span class="mono">sha256sum</span>; it is objects/${i
        .sha256} in the bundle.</p>
      ${l.itemRaw
        ? html`<p><a class="btn ghost" href="${
          l.itemRaw(i.sha256)
        }" download>Download the item</a></p>`
        : ""}
    </div>
    <div class="card">
      <pre class="mono" style="white-space:pre-wrap">${shown}</pre>
    </div>
  `;
}

/** The trail's page: requests, responses, and samples in order. */
export function trailPage(c: AuditCase, now: Date, l: Links): Html {
  return html`
    ${head(c, now, l, "Requests, responses, and samples")}
    <div class="stack" id="trail">${c.trail.map((t) => {
      const e = t.entry;
      const problems = [...t.proof.problems, ...(t.redraw ?? [])];
      return html`<div class="card stack">
        <div class="spread"><b>#${e?.seq ?? "?"} ${e?.kind ?? "unreadable"}${
        e?.control
          ? html`
            · ${e.control}
          `
          : ""
      }${
        e?.re
          ? html`
            · answers #${e.re}
          `
          : ""
      }</b>
          <span class="sub">${e?.at ?? ""} · ${e?.by ?? ""}</span></div>
        ${
        e?.kind === "sample"
          ? html`<p><a href="${
            l.sample(e.seq)
          }">The sample: ${e.sample?.units.length} unit(s), seed ${e.sample?.seed}</a></p>`
          : ""
      }
        ${e?.body ? html`<pre class="mono" style="white-space:pre-wrap">${e.body}</pre>` : ""}
        <p class="sub">${t.file.path}, SHA-256 <span class="mono">${
        t.proof.sha256.slice(0, 16)
      }</span>, commit <span class="mono">${
        (t
          .proof.commit ?? "none").slice(0, 12)
      }</span> ${pill(!problems.length, `signed by ${t.proof.signer}`, "does not check out")}</p>
        ${
        problems.length
          ? html`<ul>${problems.map((x) => html`<li class="bad">${x}</li>`)}</ul>`
          : ""
      }
      </div>`;
    })}${c.trail.length ? "" : html`<p class="sub">Nothing recorded yet.</p>`}</div>
  `;
}

/** A whole portal page (the console's styles), with a header of its own. */
function frame(title: string, body: Html): string {
  return bare(
    `${title} · audit`,
    html`
      <header
        class="top"><b>Stolos audit portal</b><form method="post" action="/signout"><button class="btn ghost" type="submit">Sign out</button></form></header>
      <main id="main" style="padding:16px 24px">${body}</main>
    `,
  );
}

/** The static page inside an export package: every section on one page, styles inline. */
export function staticPortal(c: AuditCase, now: Date): string {
  const l = STATIC_LINKS;
  const body = html`
    ${engagementPage(c, now, l)}
    ${c.engagement.controls.map((x) => controlPage(c, x, now, l))}
    ${c.trail.filter((t) => t.entry?.kind === "sample" && t.entry.sample).map((t) =>
      samplePage(c, t, now, l)
    )}
    ${trailPage(c, now, l)}
  `;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.engagement.title}: audit package</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px;color:#1e1b4b;background:#fff}
.card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #eee;padding:4px 8px;text-align:left;vertical-align:top}
.mono{font-family:ui-monospace,monospace;font-size:12px}.sub{color:#555}.pill{border-radius:9px;padding:1px 8px;font-size:12px}
.ok{background:#dcfce7}.bad{background:#fee2e2}.row,.spread{display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap}
</style></head><body>
<p class="sub">A static copy of the auditor portal, made ${now.toISOString()}. Check the package with
<code>deno task stolos audit verify &lt;package&gt;</code>, or by hand: README.txt.</p>
${body.s}
</body></html>
`;
}

/** Serve a portal request for a signed-in session (audit-scoped or an operator's). */
export async function serveAudit(
  req: Request,
  s: Session,
  d: AuditDeps | undefined,
): Promise<Response> {
  const url = new URL(req.url);
  const api = url.pathname.startsWith("/v1/");
  const m = /^\/(?:v1\/)?audit\/([a-z0-9][a-z0-9-]{0,62})(\/.*)?$/.exec(url.pathname);
  const scope = auditScope(s);
  if (scope !== undefined && (!m || m[1] !== scope)) {
    return refuse(
      api,
      403,
      `this session may only read the audit portal of engagement ${scope} (/audit/${scope}/)`,
    );
  }
  if (!d || !m) return refuse(api, 404, "no such engagement");
  const [, id, rest = "/"] = m;
  const now = d.now?.() ?? new Date();
  if (scope !== undefined && now.getTime() - s.created > AUDIT_SESSION_MS) {
    return refuse(api, 401, "this audit session has ended: ask the company for a new link");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return refuse(api, 405, "the audit portal is read-only: GET and HEAD");
  }
  const c = await d.load(id);
  if (!c) return refuse(api, 404, "no such engagement");
  const state = engagementState(c.engagement, now);
  if (state !== "open") {
    return refuse(
      api,
      410,
      state === "closed"
        ? `this engagement was closed on ${c.engagement.closed!.on}`
        : `access to this engagement ended with ${c.engagement.access.expires}`,
    );
  }
  const l = servedLinks(id);
  const page = (title: string, body: Html) => htmlResponse(frame(title, body));
  const items = c.bundle?.view.items ?? [];
  const r = rest.replace(/\/$/, "") || "/";
  if (r === "/") {
    return api ? json(engagementJson(c, now)) : page(c.engagement.title, engagementPage(c, now, l));
  }
  if (r === "/verify") {
    return json({
      ok: !caseProblems(c).length,
      problems: caseProblems(c),
      bundle: c.bundle?.verify ?? null,
    });
  }
  if (r === "/trail") {
    return api ? json({ entries: c.trail.map(entryJson) }) : page("Trail", trailPage(c, now, l));
  }
  if (r === "/bundle.zip") {
    return c.bundle
      ? download(c.bundle.zip, c.engagement.bundle!.file, "application/zip")
      : refuse(api, 404, "no evidence bundle yet");
  }
  if (r === "/export.zip") {
    if (!d.exportZip || !c.bundle) return refuse(api, 404, "no export: no evidence bundle yet");
    return download(await d.exportZip(c), `${c.fleet}-audit-${id}.zip`, "application/zip");
  }
  const cm = /^\/controls\/([^/]+)$/.exec(r);
  if (cm) {
    let cid: string;
    try {
      cid = decodeURIComponent(cm[1]);
    } catch {
      return refuse(api, 400, "not a control's id");
    }
    const x = c.engagement.controls.find((y) => y.id === cid);
    if (!x) return refuse(api, 404, `no control ${cid} in scope`);
    const p = c.populations.get(x.id);
    const seed = url.searchParams.get("seed");
    const size = Number(url.searchParams.get("size"));
    let draw: { seed: string; size: number; units: string[] } | undefined;
    if (seed !== null && p) {
      if (!SEED.test(seed) || !Number.isInteger(size) || size < 1) {
        return refuse(api, 400, "seed: one line of printable text; size: a whole number from 1");
      }
      draw = { seed, size, units: (await drawSample(x.id, p, seed, size)).units };
    }
    if (!api) return page(x.id, controlPage(c, x, now, l, draw));
    return json({
      control: x,
      population: p
        ? {
          ...populationDef(x.population),
          query: undefined,
          hash: p.hash,
          size: p.units.length,
          units: p.units.map((u) => ({ ...u, evidence: unitItems(c, u).map((i) => itemJson(i)) })),
        }
        : null,
      ...(draw
        ? { draw: { ...draw, method: SAMPLE_METHOD, recorded: false, populationHash: p!.hash } }
        : {}),
    });
  }
  const sm = /^\/samples\/(\d{1,6})$/.exec(r);
  if (sm) {
    const t = c.trail.find((x) => x.entry?.kind === "sample" && x.entry.seq === Number(sm[1]));
    if (!t?.entry?.sample) return refuse(api, 404, `no sample #${sm[1]}`);
    if (!api) return page(`Sample #${sm[1]}`, samplePage(c, t, now, l));
    const p = [...c.populations.values()].find((x) => x.id === t.entry!.sample!.population);
    return json({
      ...entryJson(t),
      units: t.entry.sample.units.map((uid) => {
        const u = p?.units.find((x) => x.id === uid);
        return {
          id: uid,
          ...(u ? { label: u.label, facts: u.facts } : {}),
          evidence: u ? unitItems(c, u).map((i) => itemJson(i, l)) : [],
        };
      }),
      bundle: c.bundle
        ? { verified: c.bundle.verify.ok, problems: c.bundle.verify.problems }
        : null,
    });
  }
  const im = /^\/items\/([0-9a-f]{64})(\/raw)?$/.exec(r);
  if (im) {
    const i = items.find((x) => x.sha256 === im[1]);
    if (!i || !i.content) return refuse(api, 404, "no such item in the bundle");
    if (im[2]) return download(i.content, `${i.sha256}`, "application/octet-stream");
    return api ? json(itemJson(i, l)) : page(i.name, itemPage(c, i, now, l));
  }
  return refuse(api, 404, "no such page in the audit portal");
}
