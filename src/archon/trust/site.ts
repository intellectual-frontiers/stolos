/**
 * Spec 081: the Trust Center's page. One self-contained HTML file: its
 * stylesheet and its one small script are inline (and pinned by SHA-256 in
 * its Content-Security-Policy, which also forbids every request to anywhere
 * else); it uses the system's fonts; it follows the reader's light or dark
 * setting; it reads at phone width; and every status is written in words, not
 * only in color. The script only turns "N before this page was built" into
 * "N ago" by the reader's clock, and shows the stale-bundle banner when the
 * page has aged past it; the page says the same without it.
 *
 * ```mermaid
 * flowchart TB
 *   head["the company, the period, the signer, the bundle's SHA-256"] --> warn["banners: stale bundle, failing and stale counts"]
 *   warn --> fw["each framework: requirements, status, SCF controls"]
 *   fw --> ctl["each SCF control: status, age, counts, the items behind it (SHA-256 links)"]
 *   ctl --> verify["how to check it yourself: stolos evidence verify, sha256sum, ssh-keygen"]
 * ```
 *
 * @module
 */

import { esc, type Html, html, raw } from "../console/html.ts";
import { formatAge } from "../compliance/freshness.ts";
import type { Coverage } from "../compliance/report.ts";
import type { ManifestItem } from "../evidence/bundle.ts";
import { NAMESPACE } from "../evidence/bundle.ts";
import type { TrustCheck, TrustControl, TrustModel } from "./model.ts";

/** Where the published evidence is, relative to the page. */
export const EVIDENCE_DIR = "evidence";

/** What the page links to and how much it shows. */
export interface PageOptions {
  /** Public (no subjects, details, or item names) or gated (everything in the bundle). */
  mode: "public" | "gated";
  /**
   * The bundle published beside the page, unzipped under `evidence/`: the
   * full bundle (gated) or the summary bundle (public). Absent: the evidence
   * is available on request, and the page says so.
   */
  published?: {
    /** The ZIP's file name under evidence/. */
    zip: string;
    /** Its manifest's items. */
    items: ManifestItem[];
    /** The signer of the published bundle. */
    signer: string;
  };
  /** The company's own link for questions and access requests (https: or mailto:). */
  contact?: string;
  /** The Stolos version building the page. */
  stolos: string;
}

const LABEL: Record<Coverage, [string, string]> = {
  pass: ["Passing", "ok"],
  fail: ["Failing", "bad"],
  partial: ["Partial", "warn"],
  "no evidence": ["No evidence", "off"],
};

const RESULT: Record<string, [string, string]> = {
  pass: ["pass", "ok"],
  fail: ["fail", "bad"],
  warn: ["warning", "warn"],
  unknown: ["unknown", "off"],
  accepted: ["risk accepted", "warn"],
};

const pill = (s: Coverage) => html`<span class="pill ${LABEL[s][1]}">${LABEL[s][0]}</span>`;
const day = (iso: string) => iso.slice(0, 10);
const when = (iso: string) => iso.replace("T", " ").replace(/(:\d\d)(\.\d+)?Z$/, "$1 UTC");
const anchor = (id: string) => `control-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const objHref = (sha: string) => `${EVIDENCE_DIR}/objects/${sha}`;

/** An age relative to the bundle's signing ("10d before signing"). */
function beforeSigning(iso: string, signed: string): Html {
  const ms = Date.parse(signed) - Date.parse(iso);
  return html`<time datetime="${iso}">${day(iso)}</time> (${
    ms >= 0 ? `${formatAge(ms)} before signing` : `${formatAge(-ms)} after signing`
  })`;
}

/** An age relative to the build, which the script rewrites by the reader's clock. */
function sinceBuild(iso: string, asOf: string): Html {
  const ms = Math.max(0, Date.parse(asOf) - Date.parse(iso));
  return html`<time datetime="${iso}" data-ago>${formatAge(ms)} before this page was built</time>`;
}

const CSS = `
:root { --bg: #F6F7FB; --panel: #FFFFFF; --ink: #161A2E; --muted: #5B6178; --line: #DDE1EC; --accent: #4F46E5;
  --accent-soft: #EEF2FF; --ok: #0B6E4C; --ok-soft: #E6F6EF; --warn: #8A4E00; --warn-soft: #FFF4E0; --bad: #B4232F;
  --bad-soft: #FDECEE; --code: #F1F3F9; color-scheme: light dark;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --mono: ui-monospace, "Cascadia Code", Consolas, monospace; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0F1220; --panel: #171B2D; --ink: #E7E9F3; --muted: #A3A9C0; --line: #2A3048; --accent: #A5A2FF;
    --accent-soft: #23264A; --ok: #3CC98F; --ok-soft: #12302A; --warn: #F0B054; --warn-soft: #34290F; --bad: #FF7D8D;
    --bad-soft: #3A1820; --code: #1D2236; }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.skip { position: absolute; left: -999px; } .skip:focus { left: 16px; top: 8px; background: var(--panel); padding: 6px 10px; }
header, main, footer { max-width: 1040px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 28px; } footer { padding: 24px 16px 40px; color: var(--muted); font-size: 13px; }
h1 { font-size: 26px; margin: 0 0 4px; text-wrap: balance; } h2 { font-size: 19px; margin: 32px 0 10px; } h3 { font-size: 15px; margin: 0; }
p { max-width: 75ch; } .muted { color: var(--muted); }
code, .mono { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--code); padding: 12px; border-radius: 8px; overflow-x: auto; font: 13px/1.5 var(--mono); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 16px 0; padding: 0; list-style: none; }
.facts li, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.k { display: block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.tile b { display: block; font-size: 24px; font-variant-numeric: tabular-nums; }
.banner { border-radius: 10px; padding: 12px 14px; margin: 12px 0; border: 1px solid; }
.banner.bad { background: var(--bad-soft); color: var(--ink); border-color: var(--bad); }
.banner.warn { background: var(--warn-soft); color: var(--ink); border-color: var(--warn); }
.banner.ok { background: var(--ok-soft); color: var(--ink); border-color: var(--ok); }
.pill { display: inline-block; border-radius: 999px; padding: 1px 9px; font-size: 13px; font-weight: 600; white-space: nowrap; border: 1px solid; }
.pill.ok { background: var(--ok-soft); color: var(--ok); } .pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.bad { background: var(--bad-soft); color: var(--bad); } .pill.off { background: var(--code); color: var(--muted); }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; min-width: 560px; }
caption { text-align: left; padding: 10px 12px 0; color: var(--muted); font-size: 13px; }
th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 8px 12px; border-bottom: 1px solid var(--line); }
td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.controls { display: grid; gap: 12px; }
.control h3 { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.control dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 10px 0 0; }
.control dt { color: var(--muted); } .control dd { margin: 0; min-width: 0; }
.gap { margin-top: 18px; }
.items { margin: 0; padding-left: 18px; } details summary { cursor: pointer; color: var(--accent); }
nav ul { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 0; list-style: none; }
@media (max-width: 520px) { .control dl { grid-template-columns: 1fr; } .control dt { margin-top: 6px; } h1 { font-size: 22px; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const SCRIPT =
  `(function(){var n=Date.now();function f(ms){var s=Math.max(0,Math.round(ms/1000));if(s<60)return s+"s";if(s<3600)return Math.floor(s/60)+"m";if(s<172800)return Math.floor(s/3600)+"h";return Math.floor(s/86400)+"d";}document.querySelectorAll("time[data-ago]").forEach(function(t){t.textContent=f(n-Date.parse(t.getAttribute("datetime")))+" ago";});var b=document.getElementById("aged");if(b&&n-Date.parse(b.getAttribute("data-signed"))>Number(b.getAttribute("data-max")))b.hidden=false;})();`;

async function cspHash(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return `'sha256-${btoa(String.fromCharCode(...d))}'`;
}

/** The links (or, without a published bundle, the SHA-256s) of the items that back a control. */
function backing(c: TrustControl, o: PageOptions): Html {
  const gated = o.mode === "gated";
  const pub = o.published;
  if (gated && pub) {
    return html`<ul class="items">${
      c.items.map((i) =>
        html`<li><a href="${objHref(i.sha256)}" data-sha256="${i.sha256}">${i.kind} ${i.name}</a>
          <span class="mono muted">${i.sha256.slice(0, 16)}</span>, recorded ${when(i.at)}</li>`
      )
    }</ul>`;
  }
  const full = html`
    <details>
      <summary>${c.items.length} item(s) in the full bundle, by SHA-256</summary>
      <ul class="items">${c.items.map((i) =>
        html`<li><span class="mono">${i.sha256}</span> (${i.kind}, ${day(i.at)})</li>`
      )}</ul>
    </details>
  `;
  const mine = pub?.items.find((i) => i.name === `trust/controls/${c.id}.json`);
  return html`${
    mine
      ? html`
        <a href="${objHref(mine.sha256)}" data-sha256="${mine.sha256}">this control's summary</a>
                <span class="mono muted">${mine.sha256.slice(
                  0,
                  16,
                )}</span>, in the signed summary bundle;
      `
      : ""
  }the evidence behind it is available on request. ${full}`;
}

function checkRows(cs: TrustCheck[], signed: string): Html {
  return html`
    <div class="scroll">
      <table>
        <caption>Each check, as the bundle records it</caption>
        <thead>
          <tr>
            <th scope="col">Subject</th>
            <th scope="col">Check</th>
            <th scope="col">Result</th>
            <th scope="col">Observed</th>
            <th scope="col">Found</th>
          </tr>
        </thead>
        <tbody>${cs.map((e) => {
          const [label, cls] = RESULT[e.status] ?? [e.status, "off"];
          return html`
            <tr>
              <td>${e.subject}</td>
              <td>${e.check}</td>
              <td><span class="pill ${cls}">${label}</span>${e.stale
                ? html`
                  <span class="pill bad">stale (was ${e.stale.was})</span>
                `
                : ""}</td>
              <td>${e.observedAt
                ? beforeSigning(e.observedAt, signed)
                : "no time in the bundle"}</td>
              <td>${e.detail}</td>
            </tr>
          `;
        })}</tbody>
      </table>
    </div>
  `;
}

function controlCard(c: TrustControl, m: TrustModel, o: PageOptions): Html {
  const f = c.freshness;
  const n = c.counts;
  const parts = [
    n.pass && `${n.pass} pass`,
    n.fail && `${n.fail} fail`,
    n.warn && `${n.warn} warning`,
    n.unknown && `${n.unknown} unknown`,
    n.accepted && `${n.accepted} risk accepted`,
  ].filter(Boolean).join(", ");
  return html`<article class="card control" id="${anchor(c.id)}">
    <h3><span class="mono">${c.id}</span> ${c.name} ${pill(c.status)}${
    n.stale
      ? html`
        <span class="pill bad">${n.stale} stale</span>
      `
      : ""
  }${
    m.bundleStale
      ? html`
        <span class="pill bad">stale bundle</span>
      `
      : ""
  }</h3>
    <p class="muted">${c.how}</p>
    <dl>
      <dt>Checks</dt><dd>${c.checks.length}: ${parts}${
    n.stale ? `; ${n.stale} stale (older than their service level when signed, so failing)` : ""
  }</dd>
      <dt>Newest evidence</dt><dd>${
    f.newest ? beforeSigning(f.newest, m.created) : "no observation time in the bundle"
  }</dd>
      <dt>Oldest evidence</dt><dd>${f.oldest ? beforeSigning(f.oldest, m.created) : "none"}${
    f.untimed ? `; ${f.untimed} check(s) read live from Git or never observed` : ""
  }</dd>
      <dt>Backed by</dt><dd>${backing(c, o)}</dd>
    </dl>
    ${o.mode === "gated" ? checkRows(c.checks, m.created) : ""}
  </article>`;
}

function verifySection(m: TrustModel, o: PageOptions): Html {
  const pub = o.published;
  if (!pub) {
    return html`
      <h2 id="verify">Check it yourself</h2>
      <p>The evidence is not published with this page. It is available on request${o.contact
        ? html`
          (<a href="${o.contact}">contact us</a>)
        `
        : ""}: ask for the bundle whose SHA-256 is <code>${m.bundle.sha256}</code>, signed by
          <b>${m
            .signer}</b>, and check it with <code>stolos evidence verify</code>, or by hand as its README says.</p>
    `;
  }
  const z = `${EVIDENCE_DIR}/${pub.zip}`;
  return html`
    <h2 id="verify">Check it yourself</h2>
    <p>Every claim above links to the item that backs it, named by its SHA-256. The bundle is
      <a href="${z}">${pub
        .zip}</a>, and is also unpacked in <code>${EVIDENCE_DIR}/</code>. With Stolos, offline:</p>
    <pre>deno task stolos evidence verify ${pub.zip}</pre>
    <p>Or by hand, in the unpacked folder (its <a href="${EVIDENCE_DIR}/README.txt">README</a> says the same):</p>
    <pre>sha256sum objects/*          # each file is named by its SHA-256
    ssh-keygen -Y find-principals -s manifest.json.sig -f allowed_signers
    ssh-keygen -Y verify -f allowed_signers -I ${pub
      .signer} -n ${NAMESPACE} -s manifest.json.sig &lt; manifest.json</pre>
    <p>Each manifest entry is chained to the one before it, so nothing can be removed, added, or
      reordered unseen. The <code>allowed_signers</code> in the bundle vouch for themselves: compare the key
      with one you have from ${m.company} by another way.</p>
  `;
}

function scopeSection(m: TrustModel, o: PageOptions): Html {
  if (o.mode === "gated") {
    return html`
      <h2 id="scope">What this page shows</h2>
      <p>This page is for people ${m
        .company} has given access to. It shows everything in the evidence
          bundle: each check's subject (hostnames, accounts, the repository <code>${m
            .repo}</code>), what it
          found, and every item by name. Do not pass it on.</p>
    `;
  }
  return html`
    <h2 id="scope">What this page shows</h2>
    <p>This is the public Trust Center. It shows each control's and requirement's status, how many
      checks stand behind it, how old its evidence is, and the SHA-256 of each item behind it. It leaves
      out every subject (hostnames, accounts, people), what each check found, and item names; the full
      evidence is available on request${o.contact
        ? html`
          (<a href="${o.contact}">contact us</a>)
        `
        : ""}.</p>
  `;
}

/** The Trust Center's page for a model. */
export async function trustPage(m: TrustModel, o: PageOptions): Promise<string> {
  const withEv = m.controls.filter((c) => c.checks.length);
  const without = m.controls.filter((c) => !c.checks.length);
  const count = (s: Coverage) => withEv.filter((c) => c.status === s).length;
  const stale = withEv.filter((c) => c.counts.stale).length;
  const failing = count("fail");
  const ageText = sinceBuild(m.created, m.asOf);
  const body = html`<a class="skip" href="#main">Skip to the evidence</a>
<header>
  <p class="muted">Trust Center${o.mode === "gated" ? " (access controlled)" : ""}</p>
  <h1>${m.company}</h1>
  <p>Control status from signed evidence, ${m.period.from} to ${m.period.to}. Every status
  below is computed from the evidence bundle and nothing else; nothing is asserted without a check.</p>
  <ul class="facts">
    <li><span class="k">Period</span>${m.period.from} to ${m.period.to}</li>
    <li><span class="k">Signed by</span>${m.signer}</li>
    <li><span class="k">Signed</span><time datetime="${m.created}">${
    when(m.created)
  }</time>, ${ageText}</li>
    <li><span class="k">Bundle</span><span class="mono">${
    m.bundle.sha256.slice(0, 16)
  }</span>, ${m.bundle.items} item(s), verified when this page was built</li>
  </ul>
  <div id="aged" class="banner bad" role="alert" data-signed="${m.created}" data-max="${
    m.maxAgeDays * 86_400_000
  }"${m.bundleStale ? "" : raw(" hidden")}>
    <b>Stale evidence.</b> This bundle was signed more than ${m.maxAgeDays} days ago (the longest
    interval FedRAMP 20x allows between machine validations). Treat every status on this page as stale
    until ${m.company} publishes a newer one.
  </div>
  ${
    failing || stale
      ? html`
        <div
          class="banner bad"><b>${failing} control(s) failing</b>${stale
            ? html`, <b>${stale} with stale evidence</b> (counted as failing)`
            : ""}. They are listed below as they are.</div>
      `
      : html`
        <div
          class="banner ok">No control with evidence is failing, and none of its evidence was stale when signed.</div>
      `
  }
</header>
<main id="main">
  <h2 id="summary">Summary</h2>
  <div class="tiles">
    <div class="card tile"><span class="k">Passing</span><b>${count("pass")}</b></div>
    <div class="card tile"><span class="k">Failing</span><b>${failing}</b></div>
    <div class="card tile"><span class="k">Partial</span><b>${count("partial")}</b></div>
    <div class="card tile"><span class="k">Stale</span><b>${stale}</b></div>
    <div class="card tile"><span class="k">No evidence</span><b>${without.length}</b></div>
  </div>
  <nav aria-label="Frameworks"><ul>${
    m.frameworks.map((f) => html`<li><a href="#fw-${f.id}">${f.short}</a></li>`)
  }<li><a href="#controls">SCF controls</a></li><li><a href="#verify">Check it yourself</a></li></ul></nav>
  ${
    m.frameworks.map((f) => {
      const c = (s: Coverage) => f.requirements.filter((r) => r.status === s).length;
      return html`
        <section aria-labelledby="fw-${f.id}">
          <h2 id="fw-${f.id}">${f.title}</h2>
          <p class="muted">${f.requirements
            .length} requirement(s) reached through the Secure Controls Framework
            ${m.scf.version} (the SCF Council's mappings): ${c("pass")} passing, ${c(
              "fail",
            )} failing,
            ${c("partial")} partial, ${c("no evidence")} without evidence.</p>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Requirement</th>
                  <th scope="col">Status</th>
                  <th scope="col">SCF controls</th>
                </tr>
              </thead>
              <tbody>${f.requirements.map((r) =>
                html`
                  <tr>
                    <td class="mono">${r.id}</td>
                    <td>${pill(r.status)}</td>
                    <td>${r.controls.map((id, k) =>
                      html`${k ? ", " : ""}<a href="#${anchor(id)}" class="mono">${id}</a>`
                    )}</td>
                  </tr>
                `
              )}</tbody>
            </table>
          </div>
        </section>
      `;
    })
  }
  ${
    m.unavailable.length
      ? html`<p class="muted">Not shown: ${
        m.unavailable.map((u, k) => html`${k ? "; " : ""}${u.id} (${u.reason})`)
      }.</p>`
      : ""
  }
  <h2 id="controls">SCF controls</h2>
  <p class="muted">Each Secure Controls Framework control Stolos gives evidence for. Evidence ages are
  measured at signing; a source observed longer ago than its service level (30 minutes for managed
  servers, two days for machines, devices, and accounts) was stale, and a stale check fails.</p>
  <div class="controls">${withEv.map((c) => controlCard(c, m, o))}</div>
  ${
    without.length
      ? html`
        <h3 class="gap">No evidence in this bundle</h3>
        <p>${without.map((c, k) =>
          html`${k ? ", " : ""}<span class="mono" id="${anchor(c.id)}">${c.id}</span> ${c.name}`
        )}.</p>
      `
      : ""
  }
  ${
    m.omitted.length
      ? html`<p class="muted">The bundle notes what it could not include: ${
        m.omitted.join("; ")
      }.</p>`
      : ""
  }
  ${verifySection(m, o)}
  ${scopeSection(m, o)}
</main>
<footer>Built ${when(m.asOf)} by Stolos ${o.stolos} from a bundle made by Stolos ${m.stolos}.
This page makes no requests: it works offline and keeps no record of who reads it.</footer>`;
  const csp = `default-src 'none'; style-src ${await cspHash(CSS)}; script-src ${await cspHash(
    SCRIPT,
  )}; img-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="referrer" content="no-referrer">
${
    o.mode === "gated"
      ? `<meta name="robots" content="noindex, nofollow">\n`
      : ""
  }<meta name="color-scheme" content="light dark">
<title>${esc(m.company)}: Trust Center</title>
<style>${CSS}</style>
</head>
<body>
${body}
<script>${SCRIPT}</script>
</body>
</html>
`;
}
