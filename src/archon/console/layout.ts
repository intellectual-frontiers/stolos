/**
 * Specs 065 and 066: both consoles' frame. A top bar (Archon on the left, the
 * fleet with Stolos in the middle, the signed-in person on the right), a menu
 * of pages, and the page. Datastar makes parts of a page live; Mermaid draws
 * the diagrams (from the page's own data), loaded only on pages that have one,
 * and drawn again when Datastar swaps one in.
 *
 * @module
 */

import { ARCHON_LOGO, DATASTAR, MERMAID, STOLOS_LOGO } from "./assets.ts";
import { type Html, html, raw } from "./html.ts";

/** One entry of the menu. */
export interface NavItem {
  /** Its group's title ("Server", "Operate", "Learn"). */
  group: string;
  /** What it says. */
  label: string;
  /** Where it goes. */
  href: string;
}

/** What every page shows besides its body. */
export interface Frame {
  /** "archon" (one machine) or "stolos" (the fleet). */
  product: "archon" | "stolos";
  /** The page's title (also the tab's). */
  title: string;
  /** Under the product's name: the machine and its OS, or the PC. */
  subtitle: string;
  /** The fleet and its repository, in the middle. */
  fleet: { id: string; repo: string };
  /** The person signed in: name, username, and role in words. */
  user: { name: string; user: string; role: string };
  /** The menu. */
  nav: NavItem[];
  /** The current page's href. */
  current: string;
}

/** Initials for the avatar. */
export function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

/** The scripts every page loads: Datastar always; Mermaid when the page has a diagram. */
const SCRIPTS = raw(`<script type="module" src="${DATASTAR.url}"></script>
<script>
(() => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  let loading;
  const draw = async () => {
    const nodes = [...document.querySelectorAll("pre.mermaid:not([data-processed])")];
    if (!nodes.length) return;
    loading ??= new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = "${MERMAID.url}";
      s.onload = ok; s.onerror = no;
      document.head.append(s);
    }).then(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base",
      themeVariables: dark
        ? { primaryColor: "#23264A", primaryBorderColor: "#8B87FF", primaryTextColor: "#E7E9F3", lineColor: "#9AA0B8", fontFamily: "IBM Plex Sans, system-ui, sans-serif" }
        : { primaryColor: "#EEF2FF", primaryBorderColor: "#6366F1", primaryTextColor: "#1E1B4B", lineColor: "#64748B", fontFamily: "IBM Plex Sans, system-ui, sans-serif" } }));
    try { await loading; await window.mermaid.run({ nodes }); }
    catch { nodes.forEach((n) => n.classList.add("plain")); }
  };
  addEventListener("DOMContentLoaded", draw);
  new MutationObserver(draw).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>`);

/** The head: title, styles, favicon, scripts. */
function head(title: string): Html {
  return html`<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/static/favicon.svg">
<link rel="stylesheet" href="/static/console.css">
${SCRIPTS}`;
}

/** A whole page: the frame around `body`. */
export function page(f: Frame, body: Html): string {
  const groups = [...new Set(f.nav.map((n) => n.group))];
  return html`
    <!doctype html>
    <html lang="en">
      <head>${head(`${f.title} · ${f.subtitle.split(" ")[0]}`)}</head>
      <body>
        <header class="top">
          <a class="brand" href="/">${ARCHON_LOGO}<b>Archon</b><small>${f.subtitle}</small></a>
          <div
            class="fleetmark">${STOLOS_LOGO}<b>Stolos</b><span>fleet ${f.fleet.id} · ${f.fleet
              .repo}</span></div>
          <div class="me">
            <div class="who"><div>${f.user.name}</div><small>${f.user.user} · ${f.user
              .role}</small></div>
            <div class="avatar" aria-hidden="true">${initials(f.user.name)}</div>
            <form method="post"
              action="/signout"><button class="btn ghost" type="submit">Sign out</button></form>
          </div>
        </header>
        <div class="shell">
          <nav class="rail" aria-label="Pages">
        ${groups.map((g) =>
          html`<div class="group">${g}</div>${
            f.nav.filter((n) => n.group === g).map((n) =>
              html`<a href="${n.href}" ${
                n.href === f.current ? raw('aria-current="page"') : ""
              }>${n.label}</a>`
            )
          }`
        )}
      </nav>
          <main id="main">${body}</main>
        </div>
      </body>
    </html>
  `.s;
}

/** A page without the frame (sign-in). */
export function bare(title: string, body: Html): string {
  return html`
    <!doctype html>
    <html lang="en">
      <head>${head(title)}</head>
      <body>${body}</body>
    </html>
  `.s;
}

/** A Mermaid diagram (its text is escaped; Mermaid reads the text, not markup). */
export function diagram(source: string, caption?: string): Html {
  return html`<figure class="card diagram"><pre class="mermaid">${source}</pre>${
    caption ? html`<figcaption class="sub">${caption}</figcaption>` : ""
  }</figure>`;
}
