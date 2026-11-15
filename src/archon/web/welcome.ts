/**
 * 032-web and 035-welcome-guide: the welcome page every server shows at
 * https://<host>.<domain> (and at any name or address nothing else claims),
 * written for someone new to the server: what it is, whether it's healthy, its
 * apps, what's installed and how to use it, and how changes are made. Rendered
 * per request by `archon web serve` (loopback only, behind Traefik, local
 * networks only). No secrets: the mailbox address and the admin's username are
 * the most personal things on it. Plain text only (no Nerd Font glyphs).
 *
 * @module
 */

import {
  type AgentSetup,
  agentSteps,
  CATEGORIES,
  type Category,
  type GuideItem,
} from "../guide/guide.ts";

/** An app or page on the server, listed on the welcome page. */
export interface Service {
  /** Its name, also the first label of its address (for example `cockpit`). */
  name: string;
  /** Its HTTPS address (for example `https://cockpit.alpha.lab.example.net`). */
  url: string;
  /** What it is, in a few words. */
  description?: string | undefined;
  /** Where it comes from: the server itself, its model, or a container's label. */
  source: "system" | "model" | "container";
}

/** Everything the welcome page shows, gathered per request by `archon web serve`. */
export interface WelcomeData {
  /** The host's name in the model. */
  host: string;
  /** Its full name (for example `alpha.lab.example.net`); unset without fleet.web. */
  fqdn?: string | undefined;
  /** The fleet's title. */
  title: string;
  /** "Ubuntu 26.04.1 LTS" */
  os: string;
  /** The server's address on the local network, if known. */
  address?: string | undefined;
  /** The fleet repository: `owner/name` and its GitHub URL. */
  repo: { slug: string; url: string };
  /**
   * Archon's last run on this host (its status file): the command, its
   * counts, whether commits wait to be pushed, and when.
   */
  lastRun?:
    | {
        command: string;
        failures: number;
        warnings: number;
        deferred: number;
        push: boolean;
        at: string;
      }
    | undefined;
  /** The last archon verify: when, how many checks passed of how many, and which failed. */
  verify?: { at: string; passed: number; total: number; failed: string[] } | undefined;
  /** The install record (spec 048): when, whether it succeeded, and its checks. */
  installed?:
    | {
        at?: string | undefined;
        ok?: boolean | undefined;
        checks?: { passed: number; total: number } | undefined;
      }
    | undefined;
  /** The certificate Traefik serves on 443: its issuer and expiry, as openssl prints them. */
  certificate?: { issuer: string; notAfter: string } | undefined;
  /**
   * Ubuntu's updates: how many wait (unset when unknown), whether a reboot is
   * needed and for which packages, and when they last installed by themselves.
   */
  updates?:
    | {
        pending?: number | undefined;
        reboot: boolean;
        rebootPackages: string[];
        lastRun?: string | undefined;
      }
    | undefined;
  /** The last backup run, when the host has the backup timer: when it ended and whether it succeeded. */
  backup?: { last?: string | undefined; ok?: boolean | undefined } | undefined;
  /** Article 23 (spec 044): durable or ephemeral, and why. */
  data?: { class: "durable" | "ephemeral"; reasons: string[] } | undefined;
  /** The apps and pages behind the proxy (none without fleet.web). */
  services: Service[];
  /** Ports open to the network with nothing published (internal ones excluded). */
  unrouted: number[];
  /** What is installed and how to use it, from the host's plan (spec 035). */
  guide: GuideItem[];
  /** How an AI agent reaches this server (spec 035); servers only. */
  agent?: AgentSetup | undefined;
  /** Guides served at /guide/<name>. */
  guides: Array<{ name: string; title: string }>;
  /** The fleet admin's username (for the ssh command shown). */
  admin: string;
  /** The fleet's mailbox, where alerts go; unset without mail. */
  mailbox?: string | undefined;
  /** When the data was gathered: `YYYY-MM-DD HH:MM UTC`. */
  generated: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** Nerd Font and other private-use glyphs, which browsers show as boxes. */
export const stripGlyphs = (s: string): string =>
  s
    .replace(/[-]|\uDB80[\uDC00-\uDFFF]|[\u{F0000}-\u{FFFFD}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();

function when(iso: string | undefined, now: Date): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (isNaN(t)) return esc(iso);
  const mins = Math.round((now.getTime() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The server's health, as the page shows it: healthy, something to look at, or failed. */
export type Level = "ok" | "warn" | "fail";

/** One plain sentence about the server's health, and what to do. */
export function health(d: WelcomeData): { level: Level; headline: string; todo: string[] } {
  const todo: string[] = [];
  let level: Level = "ok";
  const bump = (l: Level) => {
    if (l === "fail" || (l === "warn" && level === "ok")) level = l;
  };
  if (d.lastRun?.failures) {
    bump("fail");
    todo.push(`The last archon run (${d.lastRun.command}) had problems: run archon verify.`);
  }
  if (d.verify?.failed.length) {
    bump("warn");
    todo.push(
      `${d.verify.failed.length} check${d.verify.failed.length === 1 ? "" : "s"} need attention (${d.verify.failed
        .slice(0, 3)
        .join(
          ", ",
        )}${d.verify.failed.length > 3 ? ", ..." : ""}): archon verify shows a fix for each.`,
    );
  }
  if (d.updates?.reboot) {
    bump("warn");
    todo.push("An update needs a restart: sudo archon reboot when it suits you.");
  }
  if (d.fqdn && d.certificate && !/Let's Encrypt/i.test(d.certificate.issuer)) {
    bump("warn");
    todo.push("The web certificate is not the trusted one yet: archon web status says why.");
  }
  if (d.backup && d.backup.ok === false) {
    bump("warn");
    todo.push("The last backup failed: journalctl -u archon-backup shows why.");
  }
  const checks = d.verify ? `all ${d.verify.total} checks pass` : "no checks recorded yet";
  const headline =
    level === "ok"
      ? `Healthy: ${checks}.`
      : level === "warn"
        ? "Working, with something to look at."
        : "Something failed.";
  return { level, headline, todo };
}

const GLOSSARY: Array<[string, string]> = [
  ["SSH", "how you log in to the server from a terminal, securely, with a key or password"],
  ["HTTPS", "a web address with a padlock: the connection is encrypted and the server proven"],
  [
    "Certificate",
    "what proves the server is who it says it is; Let's Encrypt issues them free, and they renew by themselves",
  ],
  [
    "Container",
    "an app packaged with everything it needs, run without installing it on the server",
  ],
  ["Cockpit", "a web page for looking after the server: health, services, logs, a terminal"],
  ["Dotfiles", "your personal settings files (their names start with a dot), like .bashrc"],
  [
    "Repository",
    "the folder of files on GitHub that describes every server; changing it is how servers change",
  ],
  ["Local networks", "the networks at this site (home or office), not the internet"],
];

/** The stylesheet every page shares (light and dark, by the browser's preference). */
export const STYLE = `
:root { --bg: #f7f7f5; --fg: #1d1d1b; --muted: #66665f; --card: #ffffff; --line: #e3e3de; --ok: #2e7d32; --warn: #a15c00; --fail: #c62828; --link: #1a5fb4; --chip: #eef3fb; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecece8; --muted: #a2a29b; --card: #1f1f1d; --line: #33332f; --ok: #81c784; --warn: #ffb74d; --fail: #ef9a9a; --link: #8ab4f8; --chip: #22303f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 32px 16px 56px; }
h1 { font-size: 2.1rem; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 { font-size: 1.05rem; margin: 34px 0 10px; color: var(--muted); font-weight: 650; text-transform: uppercase; letter-spacing: 0.05em; }
h3 { font-size: 1.05rem; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 18px; }
.lead { font-size: 1.05rem; margin: 0 0 6px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; margin-bottom: 12px; }
.status { display: flex; gap: 14px; align-items: flex-start; }
.status .dot { width: 14px; height: 14px; border-radius: 50%; margin-top: 7px; flex: none; }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.fail { background: var(--fail); }
.status strong { font-size: 1.15rem; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 22px; margin-top: 12px; }
.facts div { border-top: 1px solid var(--line); padding-top: 8px; }
.facts span { display: block; color: var(--muted); font-size: 0.85rem; }
ul.todo { margin: 8px 0 0; padding-left: 20px; }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
code { font: 0.9em ui-monospace, "Cascadia Code", Menlo, monospace; background: var(--bg); border: 1px solid var(--line); padding: 1px 6px; border-radius: 5px; word-break: break-word; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
pre code { border: 0; padding: 0; background: none; }
.cmd { display: inline-flex; align-items: center; gap: 6px; }
button.copy { font: 0.75rem system-ui, sans-serif; border: 1px solid var(--line); background: var(--card); color: var(--muted); border-radius: 5px; padding: 1px 7px; cursor: pointer; }
button.copy:hover { color: var(--fg); }
ol.steps { padding-left: 22px; margin: 0; } ol.steps li { margin: 8px 0; }
table.uses { width: 100%; border-collapse: collapse; margin-top: 6px; }
table.uses td { padding: 5px 0; border-top: 1px solid var(--line); vertical-align: top; }
table.uses td:first-child { width: 48%; padding-right: 12px; }
.links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.links a { background: var(--chip); padding: 3px 10px; border-radius: 999px; font-size: 0.9rem; }
details { background: var(--card); border: 1px solid var(--line); border-radius: 12px; margin-bottom: 10px; }
details > summary { cursor: pointer; padding: 12px 18px; font-weight: 600; list-style: none; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "▸"; display: inline-block; width: 1.2em; color: var(--muted); }
details[open] > summary::before { content: "▾"; }
details .inner { padding: 0 18px 12px; }
.item { border-top: 1px solid var(--line); padding: 12px 0; }
.item:first-child { border-top: 0; }
.svc { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
.svc:first-child { border-top: 0; }
.tag { font-size: 0.75rem; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; }
dl.glossary dt { font-weight: 600; margin-top: 8px; } dl.glossary dd { margin: 0 0 4px; color: var(--muted); }
.doc h2 { text-transform: none; letter-spacing: 0; color: var(--fg); font-size: 1.35rem; }
.doc h3 { margin-top: 22px; } .doc table { border-collapse: collapse; width: 100%; margin: 10px 0; }
.doc th, .doc td { text-align: left; border-bottom: 1px solid var(--line); padding: 6px 8px 6px 0; vertical-align: top; }
footer { color: var(--muted); font-size: 0.85rem; margin-top: 30px; }
`;

const COPY_SCRIPT = `
for (const c of document.querySelectorAll("code[data-copy]")) {
  const b = document.createElement("button"); b.className = "copy"; b.type = "button"; b.textContent = "copy";
  b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(c.dataset.copy); b.textContent = "copied"; setTimeout(() => b.textContent = "copy", 1500); } catch { b.textContent = "select it"; } });
  c.after(b);
}`;

/** A full page with Archon's style. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
<script>${COPY_SCRIPT}</script>
</body>
</html>
`;
}

/** A command with a copy button (the button is added by the page's script). */
const cmd = (s: string) =>
  /^[a-z~.$]/.test(s) && !/ then /.test(s)
    ? `<span class="cmd"><code data-copy="${esc(s)}">${esc(s)}</code></span>`
    : `<code>${esc(s)}</code>`;

function guideSection(items: GuideItem[], guides: string[]): string {
  const order: Category[] = ["shell", "web", "watch", "safety", "email", "work"];
  return order
    .map((cat, i) => {
      const these = items.filter((x) => x.category === cat);
      if (!these.length) return "";
      const c = CATEGORIES[cat];
      return `<details${i < 2 ? " open" : ""}>
<summary>${c.emoji} ${esc(c.title)} <span class="tag">${these.length}</span></summary>
<div class="inner">
<p class="sub" style="margin:0 0 4px">${esc(c.intro)}</p>
${these
  .map(
    (x) =>
      `<div class="item" id="${esc(x.id)}">
<h3>${esc(x.title)}</h3>
<div>${esc(x.what)}</div>
${
  x.use?.length
    ? `<table class="uses">${x.use
        .map((u) => `<tr><td>${cmd(u.cmd)}</td><td>${esc(u.why)}</td></tr>`)
        .join("")}</table>`
    : ""
}
${
  x.links?.length || (x.guide && guides.includes(x.guide))
    ? `<div class="links">${[
        ...(x.links ?? []).map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`),
        ...(x.guide && guides.includes(x.guide)
          ? [`<a href="/guide/${esc(x.guide)}">Read the guide</a>`]
          : []),
      ].join("")}</div>`
    : ""
}
</div>`,
  )
  .join("\n")}
</div>
</details>`;
    })
    .join("\n");
}

/** The prominent "manage it with an AI agent" section (spec 035). */
function agentSection(a: AgentSetup, guide: boolean): string {
  const block = (c: string) =>
    c.includes("\n")
      ? `<pre><code data-copy="${esc(c)}">${esc(c)}</code></pre>`
      : `<div style="margin:4px 0">${cmd(c)}</div>`;
  return `<h2 id="agent">🤖 Manage this server with an AI agent</h2>
<div class="card" style="border-color:var(--link)">
<p style="margin-top:0">An AI coding agent on your own computer (any agent that speaks <strong>MCP</strong>) can check on this server, explain what it finds, and make changes for you, the right way: through the fleet's repository. Nothing AI-related runs on the server, and the server itself limits what an agent may do.</p>
<ol class="steps">
${agentSteps(a)
  .map(
    (s) => `<li><strong>${esc(s.title)}.</strong> ${esc(s.text)}${s.cmds.map(block).join("")}</li>`,
  )
  .join("\n")}
</ol>
<div class="links">${guide ? '<a href="/guide/agent">The full guide to agents</a>' : ""}<a href="${esc(
    a.repoUrl,
  )}">The repository</a></div>
</div>`;
}

/** The welcome page, as a full HTML document; `now` is used for "5 minutes ago" style times. */
export function renderWelcome(d: WelcomeData, now = new Date()): string {
  const h = health(d);
  const name = d.fqdn ?? d.host;
  const trusted = d.certificate && /Let's Encrypt/i.test(d.certificate.issuer);
  const fact = (k: string, v: string) => `<div><span>${esc(k)}</span>${v}</div>`;
  const lastRun = d.lastRun
    ? `archon ${esc(d.lastRun.command)}, ${
        d.lastRun.failures
          ? '<span style="color:var(--fail)">with problems</span>'
          : d.lastRun.warnings
            ? "with warnings"
            : "succeeded"
      }, ${when(d.lastRun.at, now)}${
        d.lastRun.push ? "<br><small>local commits not on GitHub yet</small>" : ""
      }`
    : "none recorded yet";
  const checks = d.verify
    ? `${d.verify.passed} of ${d.verify.total} pass, checked ${when(d.verify.at, now)}`
    : d.installed?.checks
      ? `${d.installed.checks.passed} of ${d.installed.checks.total} at install (run archon verify)`
      : "not checked yet";
  const updates = d.updates
    ? `${
        d.updates.pending === undefined
          ? ""
          : d.updates.pending === 0
            ? "up to date"
            : `${d.updates.pending} waiting`
      }${d.updates.lastRun ? `, installed by themselves ${when(d.updates.lastRun, now)}` : ""}${
        d.updates.reboot
          ? `<br><span style="color:var(--warn)">restart needed${
              d.updates.rebootPackages.length
                ? ` (${esc(d.updates.rebootPackages.slice(0, 3).join(", "))})`
                : ""
            }</span>`
          : ""
      }`
    : "unknown";
  const glossaryTerms = GLOSSARY.map(([t, def]) => `<dt>${esc(t)}</dt><dd>${esc(def)}</dd>`).join(
    "",
  );
  const containerExample =
    "sudo podman run -d --name hello --label traefik.enable=true docker.io/traefik/whoami";

  return page(
    `${d.host}: Archon server`,
    `<h1>${esc(d.host)}</h1>
<p class="sub">${esc(d.title)} · ${esc(d.os)}${d.address ? ` · ${esc(d.address)}` : ""}</p>

<p class="lead">This is <strong>${esc(
      d.host,
    )}</strong>, a server managed by Archon. Everything on it is described in one place, the fleet's <a href="${esc(
      d.repo.url,
    )}">repository</a>: changes are made there, and the server applies them by itself. You don't need to install or configure things here by hand, and anything done by hand is undone the next time the server is set up again.</p>

<h2>How it's doing</h2>
<div class="card">
<div class="status"><span class="dot ${h.level}"></span><div><strong>${esc(h.headline)}</strong>${
      h.todo.length
        ? `<ul class="todo">${h.todo.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
        : ""
    }</div></div>
<div class="facts">
${fact("Checks", checks)}
${fact("Last archon run", lastRun)}
${fact(
  "Web certificate",
  d.certificate
    ? `<span style="color:var(${trusted ? "--ok" : "--warn"})">${
        trusted ? "Trusted (Let's Encrypt)" : "Temporary (self-signed)"
      }</span>, renews by itself; valid until ${esc(d.certificate.notAfter)}`
    : "none yet",
)}
${
  d.data
    ? fact(
        "Data",
        d.data.class === "durable"
          ? `<span style="color:var(--warn)"><strong>Durable</strong></span>: ${esc(
              d.data.reasons.join(", "),
            )} hold data that exists nowhere else; reinstalls and wipes need a confirmation by name<br><small>your home directory is not kept across a reinstall</small>`
          : "Ephemeral: nothing here holds people's data that exists nowhere else<br><small>your home directory is not kept across a reinstall</small>",
      )
    : ""
}
${fact("Security updates", updates)}
${fact(
  "Backups",
  d.backup?.last
    ? `last ${when(d.backup.last, now)}${
        d.backup.ok === false ? ' <span style="color:var(--warn)">(failed)</span>' : ""
      }`
    : "none yet (every night)",
)}
${fact(
  "Set up",
  d.installed?.at
    ? `${esc(d.installed.at.slice(0, 16).replace("T", " "))} UTC, from the repository`
    : "no install record",
)}
</div>
</div>

${
  d.agent
    ? agentSection(
        d.agent,
        d.guides.some((g) => g.name === "agent"),
      )
    : ""
}

<h2>Apps on this server</h2>
<div class="card">
${
  d.services.length
    ? d.services
        .map(
          (s) =>
            `<div class="svc"><div><a href="${esc(s.url)}"><strong>${esc(s.name)}</strong></a>${
              s.description ? ` <span class="sub">· ${esc(s.description)}</span>` : ""
            }</div><div><a href="${esc(s.url)}">${esc(
              s.url.replace(/^https:\/\//, ""),
            )}</a> <span class="tag">${
              s.source === "container"
                ? "container"
                : s.source === "model"
                  ? "from the model"
                  : "built in"
            }</span></div></div>`,
        )
        .join("\n")
    : '<div class="svc">No apps yet.</div>'
}
</div>
<p class="sub">Every app here is reachable from wherever the router lets people in. To add one, run a container with the label ${cmd(
      "traefik.enable=true",
    )} (see <a href="#containers">Run an app in a container</a>), or add it to this server's model.${
      d.unrouted.length
        ? ` Open to the network here but not published yet: port${
            d.unrouted.length === 1 ? "" : "s"
          } ${d.unrouted
            .map((p) => `<code>${p}</code>`)
            .join(" ")}; to publish one, add <code>web: { routes: [{ name: "app", port: ${
            d.unrouted[0]
          } }] }</code> to this server's model.`
        : ""
    }</p>

<h2>First steps</h2>
<div class="card">
<ol class="steps">
<li><strong>Log in.</strong> From a terminal on your computer: ${cmd(
      `ssh ${d.admin}@${name}`,
    )} (or your own username).</li>
<li><strong>Check it's healthy.</strong> ${cmd(
      "archon verify",
    )} runs every check and shows a fix for anything that fails.</li>
<li><strong>Look around in your browser.</strong> Open <a href="${
      d.services.find((s) => s.name === "cockpit")?.url ?? `https://${d.host}:9090`
    }">Cockpit</a> and log in with your username and password.</li>
<li><strong>Run your first app.</strong> ${cmd(containerExample)}${
      d.fqdn ? ` then open <a href="https://hello.${esc(d.fqdn)}">hello.${esc(d.fqdn)}</a>` : ""
    }.</li>
<li><strong>Learn what's here.</strong> ${cmd(
      "archon guide",
    )} lists it in the terminal, and the section below explains each part.</li>
<li><strong>Change something the right way.</strong> Edit the <a href="${esc(
      d.repo.url,
    )}">repository</a>, commit, and push; the server applies it within 15 minutes, or at once with ${cmd(
      "archon update",
    )}.</li>
</ol>
</div>

<h2>What's on this server, and how to use it</h2>
${guideSection(
  d.guide,
  d.guides.map((g) => g.name),
)}

<h2>Guides</h2>
<div class="card"><div class="links" style="margin:0">
${d.guides.map((g) => `<a href="/guide/${esc(g.name)}">${esc(g.title)}</a>`).join("\n")}
<a href="${esc(d.repo.url)}">The repository on GitHub</a>
</div></div>

<details>
<summary>📖 Words used on this page</summary>
<div class="inner"><dl class="glossary">${glossaryTerms}</dl></div>
</details>

<footer>Managed by Archon from <a href="${esc(d.repo.url)}">${esc(
      d.repo.slug,
    )}</a> · reachable from wherever the router lets people in${
      d.mailbox ? ` · alerts and mail go to ${esc(d.mailbox)}` : ""
    } · this page was made ${esc(d.generated)}; reload for the latest.</footer>`,
  );
}

/** A guide (docs/<name>.md) as a page. */
export function renderGuide(host: string, title: string, html: string): string {
  return page(
    `${title}: ${host}`,
    `<p class="sub"><a href="/">← ${esc(host)}</a></p>
<article class="doc">
${html}
</article>
<footer><a href="/">Back to ${esc(host)}</a></footer>`,
  );
}
