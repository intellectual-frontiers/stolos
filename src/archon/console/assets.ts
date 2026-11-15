/**
 * Specs 065 and 066: what both consoles serve besides their pages: one
 * stylesheet (color tokens, light and dark), the Archon and Stolos logos, and
 * Datastar (vendored, pinned by its SHA-256, served from the machine itself:
 * no CDN, no build step).
 *
 * @module
 */

import { ASSETS } from "../assets.auto.ts";
import { VERSION } from "../version.ts";
import { type Html, raw } from "./html.ts";

/** Datastar's file in the engine, and its SHA-256 (checked by the tests). */
export const DATASTAR = {
  path: "vendor/datastar/datastar-1.0.4.js",
  sha256: "727844adfc825ee651fb93c544a2a739986f9a21820a94524b35f0cac470cf91",
  /** Where the consoles serve it. */
  url: "/static/datastar-1.0.4.js",
} as const;

/** Datastar's source, as the engine carries it. */
export function datastarSource(): string {
  const s = ASSETS[DATASTAR.path];
  if (!s) throw new Error(`${DATASTAR.path} is missing from the engine's assets`);
  return s;
}

/** Archon's mark: an arch over its keystone. */
export const ARCHON_LOGO: Html = raw(
  `<svg class="logo" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/><path d="M8 25V15a8 8 0 0 1 16 0v10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><rect x="13.5" y="5.5" width="5" height="5" rx="1.2" fill="#fff"/><path d="M12 25h8" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>`,
);

/** Stolos's mark: three hulls in formation (a fleet). */
export const STOLOS_LOGO: Html = raw(
  `<svg class="logo" viewBox="0 0 40 24" width="40" height="24" aria-hidden="true"><path d="M4 9h12l-3 4H7z" fill="var(--accent)"/><path d="M14 15h12l-3 4h-6z" fill="var(--accent)" opacity=".75"/><path d="M24 5h12l-3 4h-6z" fill="var(--accent)" opacity=".5"/><path d="M2 21c6-2 12 2 18 0s12-2 18 0" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round"/></svg>`,
);

/** The favicon: Archon's mark. */
export const FAVICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4F46E5"/><path d="M8 25V15a8 8 0 0 1 16 0v10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><rect x="13.5" y="5.5" width="5" height="5" rx="1.2" fill="#fff"/></svg>`;

/** Both consoles' stylesheet: tokens first (light, then dark), then the parts. Served at {@link CSS_URL}. */
export const CONSOLE_CSS = `
@font-face { font-family: "JetBrainsMono NF"; font-weight: 400; font-display: swap; src: url("/static/fonts/JetBrainsMonoNerdFontMono-Regular.woff2") format("woff2"); }
@font-face { font-family: "JetBrainsMono NF"; font-weight: 700; font-display: swap; src: url("/static/fonts/JetBrainsMonoNerdFontMono-Bold.woff2") format("woff2"); }
:root {
  --bg: #F6F7FB; --panel: #FFFFFF; --rail: #EEF0F7; --ink: #161A2E; --muted: #5B6178; --line: #DDE1EC;
  --accent: #4F46E5; --accent-soft: #EEF2FF; --ok: #0F8A5F; --ok-soft: #E6F6EF; --warn: #A15C00;
  --warn-soft: #FFF4E0; --bad: #C2283A; --bad-soft: #FDECEE; --code: #F1F3F9;
  --shadow: 0 1px 2px rgba(22,26,46,.06), 0 8px 24px rgba(22,26,46,.06);
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "Cascadia Code", Consolas, monospace;
  --term: "JetBrainsMono NF", "JetBrainsMono Nerd Font", "Cascadia Code", ui-monospace, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0F1220; --panel: #171B2D; --rail: #13172A; --ink: #E7E9F3; --muted: #9AA0B8; --line: #2A3048;
    --accent: #8B87FF; --accent-soft: #23264A; --ok: #3CC98F; --ok-soft: #12302A; --warn: #F0B054; --warn-soft: #34290F;
    --bad: #FF6B7D; --bad-soft: #3A1820; --code: #1D2236; --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.3);
    color-scheme: dark; }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); }
a { color: var(--accent); }
h1, h2, h3 { margin: 0; text-wrap: balance; }
h1 { font-size: 22px; font-weight: 600; } h2 { font-size: 15px; font-weight: 600; } h3 { font-size: 13px; font-weight: 600; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; }
button { font: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
.top { position: sticky; top: 0; z-index: 5; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px;
  height: 56px; padding: 0 max(16px, env(safe-area-inset-right, 0px)) 0 max(16px, env(safe-area-inset-left, 0px));
  background: var(--panel); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--ink); text-decoration: none; }
.brand b { font-weight: 700; } .brand small { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fleetmark { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.fleetmark b { color: var(--ink); font-weight: 600; letter-spacing: .14em; text-transform: uppercase; font-size: 12px; }
.me { justify-self: end; display: flex; align-items: center; gap: 10px; }
.me .who { text-align: right; line-height: 1.2; } .me .who small { color: var(--muted); font-size: 11.5px; }
.avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: grid;
  place-items: center; font-weight: 600; font-size: 13px; border: 1px solid var(--line); }
.shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: calc(100vh - 56px); }
.rail { background: var(--rail); border-right: 1px solid var(--line); padding: 14px 10px; display: flex; flex-direction: column; gap: 2px; }
.rail .group { font-size: 11px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; padding: 12px 10px 4px; }
.rail a { display: flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; padding: 7px 10px; border-radius: 8px; }
.rail a:hover { background: var(--panel); }
.rail a[aria-current="page"] { background: var(--panel); box-shadow: var(--shadow); color: var(--accent); font-weight: 600; }
main { padding: 22px max(16px, env(safe-area-inset-right, 0px)) 40px max(16px, env(safe-area-inset-left, 0px)); min-width: 0; }
.pagehead { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.pagehead p { margin: 4px 0 0; color: var(--muted); max-width: 70ch; }
.crumb { font-size: 12px; color: var(--muted); }
.grid { display: grid; gap: 14px; } .cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } .cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }
.k { font-size: 11.5px; color: var(--muted); letter-spacing: .06em; text-transform: uppercase; }
.v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sub { color: var(--muted); font-size: 12.5px; }
.pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.pill.ok { background: var(--ok-soft); color: var(--ok); } .pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.bad { background: var(--bad-soft); color: var(--bad); } .pill.off { background: var(--code); color: var(--muted); }
.pill.tier { background: var(--accent-soft); color: var(--accent); }
.btn { display: inline-block; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: 7px 14px; font-weight: 500; text-decoration: none; }
.btn.ghost { background: transparent; color: var(--accent); } .btn.danger { background: var(--bad); border-color: var(--bad); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 11.5px; color: var(--muted); font-weight: 500; letter-spacing: .04em; text-transform: uppercase; padding: 8px 10px; border-bottom: 1px solid var(--line); }
td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.scroll { overflow-x: auto; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; } .spread { justify-content: space-between; }
.stack { display: flex; flex-direction: column; gap: 10px; }
.ring { width: 76px; height: 76px; border-radius: 50%; display: grid; place-items: center; flex: none; }
.ring span { width: 60px; height: 60px; border-radius: 50%; background: var(--panel); display: grid; place-items: center; font-weight: 600; font-variant-numeric: tabular-nums; }
.grid.actions { grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); align-items: start; }
.grid.actions > .cmdlist { position: sticky; top: 70px; max-height: calc(100vh - 90px); overflow: auto; padding: 6px; }
.diagram pre.mermaid svg { max-height: 300px; }
.cmdlist a { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--line); padding: 7px 8px; border-radius: 6px; }
.cmdlist a .pill { font-size: 11px; padding: 1px 7px; }
.cmdlist .sub { font-size: 12px; line-height: 1.35; }
.cmdlist input[type=search] { width: 100%; margin-bottom: 6px; }
.cmdlist a:hover, .cmdlist a[aria-current="true"] { background: var(--accent-soft); }
.cmdlist .sub { grid-column: 1 / -1; }
label.field { display: grid; gap: 4px; } label.field span { font-size: 12.5px; font-weight: 500; }
label.check { display: flex; gap: 8px; align-items: center; }
input[type=text], input[type=password], select { font: inherit; width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--panel); color: var(--ink); }
.term { background: #0E1120; color: #D8DCEE; border-radius: 10px; padding: 14px 16px; font-family: var(--term); font-size: 13px; line-height: 1.45;
  height: max(420px, 62vh); overflow: auto; overscroll-behavior: contain; white-space: pre-wrap; word-break: break-word; resize: vertical; }
.term > div { min-height: 1.45em; }
.term .ok { color: #3CC98F; } .term .w { color: #F0B054; } .term .bad { color: #FF6B7D; } .term .dim { color: #8189A8; }
.help { border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 10px 10px 0; padding: 12px 14px; }
.help h3 { color: var(--accent); } .help p { margin: 6px 0 0; }
.notice { border-radius: 10px; padding: 10px 12px; } .notice.bad { background: var(--bad-soft); color: var(--bad); } .notice.ok { background: var(--ok-soft); color: var(--ok); }
.signin { min-height: 100vh; display: grid; place-items: center; padding: 40px max(16px, env(safe-area-inset-right, 0px)) 40px max(16px, env(safe-area-inset-left, 0px)); }
.signin .card { width: min(400px, 100%); padding: 28px; box-shadow: var(--shadow); }
.signin .logos { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.diagram { margin: 0; overflow-x: auto; } .diagram pre.mermaid { margin: 0; background: transparent; text-align: center; }
.diagram pre.mermaid.plain { text-align: left; font-family: var(--mono); font-size: 12px; white-space: pre; }
.diagram figcaption { margin-top: 8px; }
.prose { max-width: 78ch; } .prose pre { background: var(--code); padding: 10px; border-radius: 8px; overflow-x: auto; }
@media (max-width: 860px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .rail { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 8px; }
  .rail .group { display: none; } .rail a { white-space: nowrap; }
  .cols-3, .cols-2, .grid.actions { grid-template-columns: minmax(0, 1fr); }
  .grid.actions > .cmdlist { position: static; max-height: 40vh; }
  .fleetmark span, .brand small, .me .who { display: none; }
}
`;

/** Mermaid's browser bundle in the engine's repository, and its SHA-256 (5.5 MB: never in the modules). */
export const MERMAID = {
  path: "vendor/mermaid/mermaid-12.2.0.min.js",
  sha256: "a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f",
  /** Where the consoles serve it. */
  url: "/static/mermaid-12.2.0.min.js",
} as const;

/** JetBrainsMono Nerd Font (Nerd Fonts v3.5.0, OFL), for the consoles' terminals: fetched and checked like Mermaid. */
export const FONTS = [
  {
    path: "vendor/fonts/JetBrainsMonoNerdFontMono-Regular.woff2",
    sha256: "451a92bb8a46c3eb5225980660d891b113721dbea9bd132f060b0433a5a9272b",
    url: "/static/fonts/JetBrainsMonoNerdFontMono-Regular.woff2",
    weight: 400,
  },
  {
    path: "vendor/fonts/JetBrainsMonoNerdFontMono-Bold.woff2",
    sha256: "c577750dfa534a925c918af50b74b1c47bfb7e382a729c46fe603a34079c654d",
    url: "/static/fonts/JetBrainsMonoNerdFontMono-Bold.woff2",
    weight: 700,
  },
] as const;

/** SHA-256 of some bytes, as lowercase hex. */
export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A large vendored file, from beside this engine (the checkout, or the
 * release on GitHub this engine was imported from), checked against its
 * SHA-256 and kept in `cacheDir` (fetched once per version). Undefined when it
 * cannot be had or does not match: the page then works without it.
 */
export async function vendored(
  file: { path: string; sha256: string },
  cacheDir: string,
  base: string = new URL("../../../", import.meta.url).href,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const cached = `${cacheDir}/${file.path.split("/").pop()}`;
  try {
    const b = await Deno.readFile(cached);
    if ((await sha256Hex(b)) === file.sha256) return b;
  } catch { /* not cached yet */ }
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const url = new URL(file.path, base);
    bytes = url.protocol === "file:" ? await Deno.readFile(url) : new Uint8Array(
      await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).arrayBuffer(),
    );
  } catch {
    return undefined;
  }
  if ((await sha256Hex(bytes)) !== file.sha256) return undefined;
  try {
    await Deno.mkdir(cacheDir, { recursive: true });
    await Deno.writeFile(cached, bytes);
  } catch { /* serve it anyway; fetched again next time */ }
  return bytes;
}

/** The stylesheet's address: a new one per engine release, so a browser never keeps an old one. */
export const CSS_URL: string = `/static/console-${VERSION}.css`;
