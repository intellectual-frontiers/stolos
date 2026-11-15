/**
 * Spec 065: the Archon Console's pages, as typed functions of their data:
 * sign-in, Overview, Actions, Activity, and Guide. Written for developers who
 * have not run servers before: each page says what it is for, and the
 * diagrams (Mermaid, drawn from this server's real state) show how the pieces
 * connect: the fleet repository, signing, the 15-minute convergence, and
 * what happens when you press Run.
 *
 * @module
 */

import type { Command } from "../core/registry-types.ts";
import type { GuideItem } from "../guide/guide.ts";
import { CATEGORIES } from "../guide/guide.ts";
import type { WelcomeData } from "../web/welcome.ts";
import { ARCHON_LOGO, STOLOS_LOGO } from "./assets.ts";
import type { Session } from "./auth.ts";
import { commandForm, tierPill } from "./forms.ts";
import { type Html, html } from "./html.ts";
import { diagram, type NavItem } from "./layout.ts";

/** The Archon Console's menu. */
export const ARCHON_NAV: NavItem[] = [
  { group: "Server", label: "Overview", href: "/" },
  { group: "Operate", label: "Actions", href: "/actions" },
  { group: "Operate", label: "Activity", href: "/activity" },
  { group: "Learn", label: "How it works", href: "/how" },
  { group: "Learn", label: "Guide", href: "/guide" },
];

/** What the server's checkout of the fleet repository says about itself. */
export interface RepoFacts {
  /** The commit applied now: short hash, subject, author. */
  commit?: { sha: string; subject: string; author: string; at: string };
  /** Who signed it (a name from signers.ts), when the signature is good. */
  signer?: string;
  /** The engine release the fleet is pinned to ("v0.66.0"). */
  engine?: string;
  /** The fleet's signers: name and role. */
  signers: Array<{ name: string; role: string }>;
}

/** One line of the activity record. */
export interface ActivityEntry {
  /** When (ISO time). */
  at: string;
  /** Who (a username, or the address for a failed sign-in). */
  user: string;
  /** Where from (an address). */
  from: string;
  /** What kind of thing happened. */
  kind: "sign-in" | "sign-in failed" | "sign-out" | "run" | "refused";
  /** The command, or the reason. */
  detail: string;
  /** A run's exit code. */
  code?: number;
}

const ago = (iso?: string) => {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90
    ? "just now"
    : s < 5400
    ? `${Math.round(s / 60)} minutes ago`
    : s < 129600
    ? `${Math.round(s / 3600)} hours ago`
    : `${Math.round(s / 86400)} days ago`;
};

/** Mermaid text: a label made safe inside double quotes. */
const m = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, "");

/** The sign-in page. */
export function signinPage(
  o: { host: string; fqdn?: string; error?: string; user?: string },
): Html {
  return html`
    <main class="signin">
      <div class="card">
      <div class="logos"><span class="brand">${ARCHON_LOGO}<b>Archon</b></span>${STOLOS_LOGO}</div>
      <h1>Sign in to ${o.host}</h1>
      <p class="sub" style="margin:4px 0 18px">Use your account on this server: the same username and password as
        <code>ssh ${o.user || "you"}@${o.fqdn ??
          o.host}</code>. There is no separate web account.</p>
      ${o.error ? html`<p class="notice bad" role="alert">${o.error}</p>` : ""}
      <form class="stack" method="post" action="/signin">
        <label class="field"><span>Username</span><input type="text" name="user" value="${o.user ??
          ""}" autocomplete="username" autocapitalize="none" required autofocus></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn" type="submit">Sign in</button>
      </form>
      <p class="sub" style="margin-top:16px">Linux checks your password (PAM), as SSH and Cockpit do. Five wrong tries in a
        minute pause sign-ins from your address. Every sign-in is recorded in Activity.</p>
      </div>
    </main>
  `;
}

/** Overview: health first, then how this server stays as described. */
export function overviewPage(d: WelcomeData, r: RepoFacts, s: Session): Html {
  const v = d.verify;
  const pct = v && v.total ? Math.round((v.passed / v.total) * 100) : 0;
  const healthy = !!v && v.passed === v.total;
  const ring = `background: conic-gradient(var(--${
    healthy ? "ok" : "warn"
  }) ${pct}%, var(--line) 0)`;
  return html`
    <div class="pagehead"><div><div class="crumb">${d.host}</div><h1>Overview</h1>
      <p>Whether this server matches its description in Git, and what to do when it doesn't.</p></div>
      <a class="btn" href="/actions?cmd=verify">Check everything now</a></div>
    <div class="grid cols-3">
      <div class="card row" style="flex-wrap:nowrap; gap:16px">
        <div class="ring" style="${ring}"><span>${v ? v.passed : "?"}</span></div>
        <div>
          <div class="k">Health</div>
          <div class="v">${!v
            ? "Not checked yet"
            : healthy
            ? "All checks pass"
            : `${v.total - v.passed} need attention`}</div>
          <div class="sub">${v
            ? `${v.passed} of ${v.total} · checked ${ago(v.at)}`
            : "run archon verify"}</div>
        </div>
      </div>
      <div class="card">
        <div class="k">Applied now</div>
        <div class="v mono" style="font-size:16px">${r.commit?.sha ?? "unknown"}</div>
        <div class="sub">${r.commit ? `"${r.commit.subject}" · ${ago(r.commit.at)}` : ""}${r.signer
          ? html`
            · signed by <b>${r.signer}</b>
          `
          : ""}</div>
      </div>
      <div class="card">
        <div class="k">Engine</div>
        <div class="v">Stolos ${r.engine ?? "?"}</div>
        <div class="sub">Last update ${ago(d.lastRun?.at)}; the next is within 15 minutes.</div>
      </div>
    </div>
    ${v && v.failed.length
      ? html`<div class="card" style="margin-top:14px"><h2>Needs attention</h2>${
        v.failed.map((f) =>
          html`
            <div class="row spread"
              style="padding:8px 0;border-bottom:1px solid var(--line)"><span class="mono">${f}</span><a class="btn ghost" href="/actions?cmd=verify">See the fix</a></div>
          `
        )
      }</div>`
      : ""}
    <div class="grid cols-2" style="margin-top:14px">
      ${diagram(
        convergenceDiagram(d, r),
        "Every 15 minutes this server pulls the fleet repository, refuses any commit not signed by a fleet signer, makes itself match, and checks itself.",
      )}
      <div class="card"><h2>This server</h2><div class="scroll"><table>
        <tr><td class="sub">System</td><td>${d.os}</td></tr>
        ${d.address
          ? html`
            <tr>
              <td class="sub">Address</td>
              <td class="mono">${d.address}</td>
            </tr>
          `
          : ""}
        ${d.fqdn
          ? html`
            <tr>
              <td class="sub">Name</td>
              <td class="mono">${d.fqdn}</td>
            </tr>
          `
          : ""}
        ${d.data
          ? html`
            <tr>
              <td class="sub">Data</td>
              <td><span class="pill ${d.data.class === "durable" ? "warn" : "off"}">${d.data
                .class}</span> ${d.data.reasons[0] ?? ""}</td>
            </tr>
          `
          : ""}
        ${d.certificate
          ? html`
            <tr>
              <td class="sub">Certificate</td>
              <td>${d.certificate.issuer} · until ${d.certificate.notAfter}</td>
            </tr>
          `
          : ""}
        ${d.updates
          ? html`
            <tr>
              <td class="sub">Ubuntu updates</td>
              <td>${d.updates.pending === undefined
                ? "unknown"
                : `${d.updates.pending} waiting`}${d.updates.reboot
                ? html`
                  · <span class="pill warn">restart needed</span>
                `
                : ""}</td>
            </tr>
          `
          : ""}
      </table></div></div>
    </div>
    ${d.services.length
      ? html`
        <div class="card" style="margin-top:14px">
          <h2>Apps on this server</h2>
          <div class="scroll">
            <table>${d.services.map((x) =>
              html`
                <tr>
                  <td><b>${x.name}</b></td>
                  <td class="sub">${x.description ?? ""}</td>
                  <td><a href="${x.url}" target="_blank" rel="noopener">${x.url.replace(
                    "https://",
                    "",
                  )}</a></td>
                </tr>
              `
            )}</table>
          </div>
        </div>
      `
      : ""}
    <div class="help" style="margin-top:14px">
      <h3>New to servers?</h3>
      <p>Nobody configures this server by hand. Its description lives in <a href="${d.repo.url}">${d
        .repo.slug}</a> on
      GitHub; the server reads it and makes itself match. Here you can look, check, and run safe operations (restart a
      service, turn on PostgreSQL). To change what the server <em>is</em> (packages, users, settings), change the
      repository: <a href="/how">How it works</a> shows the path a change takes.${s.role ===
          "viewer"
        ? " You can look at everything; operators (sudo or archon-ops) can also run changes."
        : ""}</p>
    </div>
  `;
}

/** The convergence loop, with this server's real commit and signer. */
export function convergenceDiagram(d: WelcomeData, r: RepoFacts): string {
  const sha = r.commit?.sha ?? "main";
  return `flowchart LR
  repo["GitHub: ${m(d.repo.slug)}<br/>main @ ${
    m(sha)
  }"] -->|"pull, every 15 min"| sig{"signed by a<br/>fleet signer?"}
  sig -->|"yes${
    r.signer ? `: ${m(r.signer)}` : ""
  }"| apply["apply<br/>packages, users, files, services"]
  sig -->|"no"| stop["refuse: nothing runs"]
  apply --> verify["verify<br/>${
    d.verify ? `${d.verify.passed}/${d.verify.total} checks` : "every check"
  }"]
  verify -->|"status"| you["this console<br/>and the mailbox"]`;
}

/** How it works: the repositories, signing, and the path of a change. */
export function howPage(d: WelcomeData, r: RepoFacts): Html {
  const signers = r.signers.length ? r.signers : [{ name: "your daily key", role: "daily" }];
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${d.host}</div>
        <h1>How it works</h1>
        <p>Three ideas explain everything this server does: the description lives in Git, every change is signed, and the
      server converges to what it reads. If you know Git and CI, you already know most of it.</p>
      </div>
    </div>
    <div class="grid cols-2">
      ${diagram(
        `flowchart TB
  engine["Engine: intellectual-frontiers/stolos<br/>release ${m(r.engine ?? "vX.Y.Z")} (public)"]
  fleet["Fleet: ${m(d.repo.slug)}<br/>fleet.ts, hosts/${m(d.host)}/host.ts (private)"]
  pc["Your PC: stolos<br/>edit, build, sign, push"]
  srv["${m(d.host)}: archon<br/>pull, check signature, apply, verify"]
  fleet -->|"deno.json pins the engine;<br/>deno.lock pins every file"| engine
  pc -->|"git push (signed)"| fleet
  srv -->|"git pull (read-only deploy key)"| fleet
  srv -->|"runs the pinned engine"| engine`,
        "Two repositories: the engine (how) and your fleet (what). The fleet pins an exact engine release, so every server runs the same, checked code.",
      )}
      ${diagram(
        `sequenceDiagram
  autonumber
  actor You
  participant PC as Your PC (stolos)
  participant GH as GitHub (${m(d.repo.slug)})
  participant S as ${m(d.host)} (archon)
  You->>PC: edit hosts/${m(d.host)}/host.ts
  You->>PC: deno task stolos apply
  PC->>PC: build and check the model
  PC->>You: passphrase? (your SSH signing key)
  PC->>GH: push one signed commit
  S->>GH: pull (within 15 minutes)
  S->>S: signature by a fleet signer? else refuse
  S->>S: apply and verify
  S-->>You: health here, and mail if something fails`,
        "The path of a change. Your passphrase unlocks your key on your PC only; servers check the signature, never a password.",
      )}
      ${diagram(
        `flowchart LR
  ${signers.map((s, i) => `k${i}["${m(s.name)}<br/>(${m(s.role)})"]`).join("\n  ")}
  list["fleets/.../signers.ts<br/>the public halves"]
  ${signers.map((_, i) => `k${i} --> list`).join("\n  ")}
  list -->|"copied to /etc/archon/allowed_signers<br/>when the server was installed"| srv["${
          m(d.host)
        } trusts these keys,<br/>and only these"]`,
        "Signing: the private keys stay on the PCs that own them, each locked by a passphrase. A recovery key replaces a lost daily key.",
      )}
      ${diagram(
        `flowchart LR
  b["your browser"] -->|"HTTPS"| t["Traefik<br/>(certificate)"]
  t --> c["Archon Console<br/>(account archon-console)"]
  c -->|"you are an operator?<br/>sudo -n"| e["archon console exec<br/>(root: checks you again)"]
  e -->|"systemd-run<br/>SUDO_USER=you"| a["archon &lt;command&gt;"]
  a -->|"output, live"| b`,
        "What happens when you press Run: the command runs as you (every record names you), and changes are mailed to the fleet's mailbox.",
      )}
    </div>
  `;
}

/** Actions: every command as a form, with live output. */
export function actionsPage(cmds: Command[], selected: Command, s: Session): Html {
  const groupOf = (c: Command) =>
    c.name.startsWith("pg ")
      ? "PostgreSQL"
      : c.name.startsWith("fs ")
      ? "Files and storage"
      : c.name.startsWith("web") || c.name.startsWith("otel")
      ? "Web and telemetry"
      : c.name.startsWith("notify") || c.name.startsWith("mail")
      ? "Mail and alerts"
      : ["update", "apply", "verify", "doctor", "capture", "reboot", "poweroff", "tools sync"]
          .includes(c.name)
      ? "This server"
      : "More";
  const groups = [...new Set(cmds.map(groupOf))].sort((a, b) =>
    a === "This server" ? -1 : b === "This server" ? 1 : a.localeCompare(b)
  );
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">archon</div>
        <h1>Actions</h1>
        <p>Every <code>archon</code> command for this machine, as a form: the same list as <code>archon help</code>, so
      nothing here is web-only. Each says what it does to the server before you run it.</p>
      </div>
    </div>
    <div class="grid" style="grid-template-columns: minmax(0, 340px) minmax(0, 1fr)">
      <nav class="card cmdlist" style="padding:6px" aria-label="Commands">
        ${groups.map((g) =>
          html`<div class="k" style="padding:10px 6px 4px">${g}</div>${
            cmds.filter((c) => groupOf(c) === g).map((c) =>
              html`
                <a href="/actions?cmd=${encodeURIComponent(c.name)}"
                  ${c.name === selected.name
                    ? html`aria-current="true"`
                    : ""}><span class="mono">${c.name}</span>${tierPill(
                      c.tier,
                    )}<span class="sub">${c.summary}</span></a>
              `
            )
          }`
        )}
      </nav>
      <div class="stack" style="min-width:0">
        ${commandForm(selected, s.role, "/actions/run")}
        <div class="card"><div class="row spread" style="margin-bottom:8px"><h2>Output</h2><span class="sub" id="runstate">Nothing running</span></div>
          <div class="term" id="output" aria-live="polite"><span class="dim">Run the command to see its output here, live.</span></div></div>
      </div>
    </div>
  `;
}

/** Activity: who did what, from where. */
export function activityPage(entries: ActivityEntry[], host: string): Html {
  const pill = (e: ActivityEntry) =>
    e.kind === "run"
      ? html`<span class="pill ${e.code === 0 ? "ok" : "bad"}">${
        e.code === 0 ? "done" : `exit ${e.code}`
      }</span>`
      : e.kind === "refused" || e.kind === "sign-in failed"
      ? html`<span class="pill bad">${e.kind}</span>`
      : html`<span class="pill off">${e.kind}</span>`;
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${host}</div>
        <h1>Activity</h1>
        <p>Who signed in and what they ran from this console, newest first. Commands also record themselves where they
      always do (the journal, this server's database), naming the person.</p>
      </div>
    </div>
    <div class="card scroll">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>From</th>
            <th>What</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>${entries.length
          ? entries.map((e) =>
            html`
              <tr>
                <td class="mono">${e.at.slice(0, 16).replace("T", " ")}</td>
                <td>${e.user}</td>
                <td class="mono">${e.from}</td>
                <td class="mono">${e.detail}</td>
                <td>${pill(e)}</td>
              </tr>
            `
          )
          : html`
            <tr>
              <td colspan="5" class="sub">Nothing yet.</td>
            </tr>
          `}</tbody>
      </table>
    </div>
  `;
}

/** Guide: what's here and how to use it, each with the actions that do it. */
export function guidePage(
  items: GuideItem[],
  guides: Array<{ name: string; title: string }>,
  offered: Set<string>,
  host: string,
): Html {
  const action = (cmd: string) => {
    const name = cmd.replace(/^(sudo\s+)?archon\s+/, "").split(/\s+--?|\s+[A-Z<]/)[0].trim();
    return offered.has(name) ? name : undefined;
  };
  const cats = [...new Set(items.map((i) => i.category))];
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${host}</div>
        <h1>Guide</h1>
        <p>What is on this server and how to use it, in plain words. Commands that the console can run have a button.</p>
      </div>
    </div>
    <div class="stack">${cats.map((c) =>
      html`
        <section class="stack">
          <h2>${CATEGORIES[c]?.title ?? c}</h2>
          <p class="sub" style="margin:0">${CATEGORIES[c]?.intro ?? ""}</p>
          <div class="grid cols-2">${items.filter((i) => i.category === c).map((i) =>
            html`
              <div
                class="card"><h3>${i.title}</h3><p class="sub">${i.what}</p>${(i.use ?? []).map(
                  (u) => {
                    const a = action(u.cmd);
                    return html`
                      <div class="row spread"
                        style="padding:4px 0"><span><code>${u.cmd}</code> <span class="sub">${u
                          .why}</span></span>${a
                          ? html`<a class="btn ghost" href="/actions?cmd=${
                            encodeURIComponent(a)
                          }">Open</a>`
                          : ""}</div>
                    `;
                  },
                )}${(i.links ?? []).map((l) =>
                  html`
                    <a href="${l.href}" target="_blank" rel="noopener">${l.label}</a>
                  `
                )}${i.guide
                  ? html`<p><a href="/guide/${i.guide}">Read the guide</a></p>`
                  : ""}</div>
            `
          )}</div>
        </section>
      `
    )}
    <div class="card"><h2>Guides</h2><div class="stack">${guides.map((g) =>
      html`<a href="/guide/${g.name}">${g.title}</a>`
    )}</div></div></div>
  `;
}
