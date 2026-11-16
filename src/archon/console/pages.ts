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
import { logo, logoFor } from "./logos.ts";
import type { ServicesFacts, UnitRow } from "./machine.ts";
import type { Session } from "./auth.ts";
import { commandForm, type FormOptions, tierPill } from "./forms.ts";
import { type Html, html, text } from "./html.ts";
import { diagram, type NavItem } from "./layout.ts";

/** The Archon Console's menu. */
export const ARCHON_NAV: NavItem[] = [
  { group: "Server", label: "Overview", href: "/" },
  { group: "Server", label: "Services", href: "/services" },
  { group: "Server", label: "Apps", href: "/apps" },
  { group: "Server", label: "Data", href: "/data" },
  { group: "Server", label: "Logs", href: "/logs" },
  { group: "Server", label: "Compliance", href: "/compliance" },
  { group: "Server", label: "Activity", href: "/activity" },
  { group: "Actions", label: "This server", href: "/actions/server" },
  { group: "Actions", label: "PostgreSQL", href: "/actions/postgres" },
  { group: "Actions", label: "Storage and data", href: "/actions/storage" },
  { group: "Actions", label: "Web and telemetry", href: "/actions/web" },
  { group: "Actions", label: "Mail and alerts", href: "/actions/mail" },
  { group: "Actions", label: "Your shell", href: "/actions/shell" },
  { group: "Learn", label: "How it works", href: "/how" },
  { group: "Learn", label: "Guide", href: "/guide" },
];

/** What the server's checkout of the fleet repository says about itself. */
export interface RepoFacts {
  /** The commit applied now: short hash, subject, author. */
  commit?: { sha: string; subject: string; author: string; at: string } | undefined;
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
export function signinPage(o: {
  host: string;
  fqdn?: string | undefined;
  error?: string | undefined;
  user?: string | undefined;
}): Html {
  return html`
    <main class="signin">
      <div class="card">
        <div class="logos">
          <span class="brand">${ARCHON_LOGO}<b>Archon</b></span
          >${STOLOS_LOGO}
        </div>
        <h1>Sign in to ${o.host}</h1>
        <p class="sub" style="margin:4px 0 18px">
          Use your account on this server: the same username and password as
          <code>ssh ${o.user || "you"}@${o.fqdn ?? o.host}</code>. There is no separate web account.
        </p>
        ${o.error ? html`<p class="notice bad" role="alert">${o.error}</p>` : ""}
        <form class="stack" method="post" action="/signin">
          <label class="field"
            ><span>Username</span
            ><input
              type="text"
              name="user"
              value="${o.user ?? ""}"
              autocomplete="username"
              autocapitalize="none"
              required
              autofocus
          /></label>
          <label class="field"
            ><span>Password</span
            ><input type="password" name="password" autocomplete="current-password" required
          /></label>
          <button class="btn" type="submit">Sign in</button>
        </form>
        <p class="sub" style="margin-top:16px">
          Linux checks your password (PAM), as SSH and Cockpit do. Five wrong tries in a minute
          pause sign-ins from your address. Every sign-in is recorded in Activity.
        </p>
      </div>
    </main>
  `;
}

const LEVEL: Record<string, { pill: string; word: string }> = {
  fail: { pill: "bad", word: "failing" },
  warn: { pill: "warn", word: "warning" },
  pending: { pill: "off", word: "not set up yet" },
};

/**
 * Every check that did not pass, each with what it found and how to fix it (a warning is never a
 * bare number). An older engine's record has only the failed names: they are listed, and the
 * button runs the checks again, which prints each fix.
 */
export function attentionCard(v: NonNullable<WelcomeData["verify"]>): Html {
  const items: Array<{
    resource: string;
    level: string;
    output: string;
    fix: string;
    code?: string;
  }> = v.attention?.length
    ? v.attention
    : v.failed.map((resource) => ({ resource, level: "fail", output: "", fix: "" }));
  return html`<div class="card" id="attention" style="margin-top:14px">
    <div class="row spread">
      <h2>Needs attention</h2>
      <a class="btn ghost" href="/actions/server?cmd=verify">Check again</a>
    </div>
    ${
      items.length
        ? items.map(
            (a) => html`
              <div style="padding:10px 0;border-bottom:1px solid var(--line)">
                <div class="row" style="gap:8px">
                  <span class="pill ${LEVEL[a.level]?.pill ?? "warn"}"
                    >${LEVEL[a.level]?.word ?? a.level}</span
                  >
                  <b class="mono">${a.resource}</b>
                </div>
                ${a.output ? html`<div class="sub" style="margin-top:4px">${a.output}</div>` : ""}
                ${
                  a.fix
                    ? html`<div style="margin-top:6px">
                        How to fix: <code>${a.fix}</code>${
                          a.code
                            ? html` <span class="sub"
                                >(details: <code>archon explain ${a.code}</code>)</span
                              >`
                            : ""
                        }
                      </div>`
                    : ""
                }
              </div>
            `,
          )
        : html`<p class="sub">
            ${v.total - v.passed} check(s) did not pass at the last verify, which recorded no
            details. Check again: it lists each one with its fix.
          </p>`
    }
  </div>`;
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
    <div class="pagehead">
      <div>
        <div class="crumb">${d.host}</div>
        <h1>Overview</h1>
        <p>Whether this server matches its description in Git, and what to do when it doesn't.</p>
      </div>
      <a class="btn" href="/actions/server?cmd=verify">Check everything now</a>
    </div>
    <div class="grid cols-3">
      <a
        class="card row"
        style="flex-wrap:nowrap; gap:16px; color:inherit; text-decoration:none"
        href="${v && !healthy ? "#attention" : "/actions/server?cmd=verify"}"
        title="${v && !healthy ? "What needs attention, and how to fix it" : "Check everything now"}"
      >
        <div class="ring" style="${ring}"><span>${v ? v.passed : "?"}</span></div>
        <div>
          <div class="k">Health</div>
          <div class="v">
            ${
              !v
                ? "Not checked yet"
                : healthy
                  ? "All checks pass"
                  : `${v.total - v.passed} need attention`
            }
          </div>
          <div class="sub">
            ${v ? `${v.passed} of ${v.total} · checked ${ago(v.at)}` : "run archon verify"}
          </div>
          ${v && !healthy ? html`<div class="sub"><u>See what, and how to fix it</u></div>` : ""}
        </div>
      </a>
      <div class="card">
        <div class="k">Applied now</div>
        <div class="v mono" style="font-size:16px">${r.commit?.sha ?? "unknown"}</div>
        <div class="sub">
          ${r.commit ? `"${r.commit.subject}" · ${ago(r.commit.at)}` : ""}${
            r.signer ? html` · signed by <b>${r.signer}</b> ` : ""
          }
        </div>
      </div>
      <div class="card">
        <div class="k">Engine</div>
        <div class="v">Stolos ${r.engine ?? "?"}</div>
        <div class="sub">Last update ${ago(d.lastRun?.at)}; the next is within 15 minutes.</div>
      </div>
    </div>
    ${v && !healthy ? attentionCard(v) : ""}
    <div class="grid cols-2" style="margin-top:14px">
      ${diagram(
        convergenceDiagram(d, r),
        "Every 15 minutes this server pulls the fleet repository, refuses any commit not signed by a fleet signer, makes itself match, and checks itself.",
      )}
      <div class="card">
        <h2>This server</h2>
        <div class="scroll">
          <table>
            <tr>
              <td class="sub">System</td>
              <td>${d.os}</td>
            </tr>
            ${
              d.address
                ? html`
                    <tr>
                      <td class="sub">Address</td>
                      <td class="mono">${d.address}</td>
                    </tr>
                  `
                : ""
            }
            ${
              d.fqdn
                ? html`
                    <tr>
                      <td class="sub">Name</td>
                      <td class="mono">${d.fqdn}</td>
                    </tr>
                  `
                : ""
            }
            ${
              d.data
                ? html`
                    <tr>
                      <td class="sub">Data</td>
                      <td>
                        <span class="pill ${d.data.class === "durable" ? "warn" : "off"}"
                          >${d.data.class}</span
                        >
                        ${d.data.reasons[0] ?? ""}
                      </td>
                    </tr>
                  `
                : ""
            }
            ${
              d.certificate
                ? html`
                    <tr>
                      <td class="sub">Certificate</td>
                      <td>${d.certificate.issuer} · until ${d.certificate.notAfter}</td>
                    </tr>
                  `
                : ""
            }
            ${
              d.updates
                ? html`
                    <tr>
                      <td class="sub">Ubuntu updates</td>
                      <td>
                        ${
                          d.updates.pending === undefined
                            ? "unknown"
                            : `${d.updates.pending} waiting`
                        }${
                          d.updates.reboot
                            ? html` · <span class="pill warn">restart needed</span> `
                            : ""
                        }
                      </td>
                    </tr>
                  `
                : ""
            }
          </table>
        </div>
      </div>
    </div>
    ${
      d.services.length
        ? html`
            <div class="card" style="margin-top:14px">
              <h2>Apps on this server</h2>
              <div class="scroll">
                <table>
                  ${d.services.map(
                    (x) => html`
                      <tr>
                        <td><b>${x.name}</b></td>
                        <td class="sub">${x.description ?? ""}</td>
                        <td>
                          <a href="${x.url}" target="_blank" rel="noopener"
                            >${x.url.replace("https://", "")}</a
                          >
                        </td>
                      </tr>
                    `,
                  )}
                </table>
              </div>
            </div>
          `
        : ""
    }
    <div class="help" style="margin-top:14px">
      <h3>New to servers?</h3>
      <p>
        Nobody configures this server by hand. Its description lives in
        <a href="${d.repo.url}">${d.repo.slug}</a> on GitHub; the server reads it and makes itself
        match. Here you can look, check, and run safe operations (restart a service, turn on
        PostgreSQL). To change what the server <em>is</em> (packages, users, settings), change the
        repository: <a href="/how">How it works</a> shows the path a change
        takes.${
          s.role === "viewer"
            ? " You can look at everything; operators (sudo or archon-ops) can also run changes."
            : ""
        }
      </p>
    </div>
  `;
}

/** The convergence loop, with this server's real commit and signer. */
export function convergenceDiagram(d: WelcomeData, r: RepoFacts): string {
  const sha = r.commit?.sha ?? "main";
  return `flowchart LR
  repo["GitHub: ${m(d.repo.slug)}<br/>main @ ${m(
    sha,
  )}"] -->|"pull, every 15 min"| sig{"signed by a<br/>fleet signer?"}
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
        <p>
          Three ideas explain everything this server does: the description lives in Git, every
          change is signed, and the server converges to what it reads. If you know Git and CI, you
          already know most of it.
        </p>
      </div>
    </div>
    <div class="grid cols-2">
      ${diagram(
        `flowchart TB
  engine["Engine: intellectual-frontiers/stolos<br/>release ${m(r.engine ?? "vX.Y.Z")} (public)"]
  fleet["Fleet: ${m(d.repo.slug)}<br/>fleet.ts, hosts/${m(d.host)}/host.ts (private)"]
  pc["Your PC: stolos<br/>edit, build, sign, push"]
  srv["${m(d.host)}: archon<br/>pull, check signature, apply, verify"]
  fleet -->|"package.json pins the engine;<br/>bun.lock holds its integrity"| engine
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
  You->>PC: bun run stolos apply
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
  list -->|"copied to /etc/archon/allowed_signers<br/>when the server was installed"| srv["${m(
    d.host,
  )} trusts these keys,<br/>and only these"]`,
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

/** A group of actions: its own page, introduction, diagram, and commands. */
export interface ActionGroup {
  /** Its address: /actions/<id>. */
  id: string;
  /** Its name in the menu. */
  label: string;
  /** What it is about, for someone new to servers. */
  intro: string;
  /** Which commands belong here. */
  has(name: string): boolean;
  /** The command shown first. */
  first: string;
  /** How this part of the server works (Mermaid), from the server's data. */
  diagram(d: WelcomeData): string;
  /** Under the diagram. */
  caption: string;
}

const SERVER_GROUP: ActionGroup = {
  id: "server",
  label: "This server",
  intro:
    "Bring the server up to date with Git, check it, and restart or turn it off. Updating is what the 15-minute timer does; running it here just does it now.",
  has: (n) =>
    [
      "update",
      "apply",
      "verify",
      "doctor",
      "capture",
      "state",
      "reboot",
      "poweroff",
      "tools sync",
      "guest sync",
      "report daily",
      "explain",
      "query",
    ].includes(n),
  first: "verify",
  diagram: (d) =>
    `flowchart LR
  u["archon update"] --> p["pull ${m(d.repo.slug)}"] --> s{"signed by a<br/>fleet signer?"}
  s -->|yes| a["apply: packages, accounts,<br/>files, services, tools"] --> v["verify: every check"]
  s -->|no| r["refuse: nothing changes"]
  v --> h["health on Overview"]`,
  caption: "archon update, step by step. archon verify is the last box alone: it only looks.",
};

/** The Archon Console's action groups, in menu order (every offered command is in exactly one). */
export const ACTION_GROUPS: ActionGroup[] = [
  SERVER_GROUP,
  {
    id: "postgres",
    label: "PostgreSQL",
    intro:
      "Databases on this server, off until an operator turns them on. You sign in with your Linux account: on the server without a password, from elsewhere with your Linux password over TLS.",
    has: (n) => n.startsWith("pg "),
    first: "pg status",
    diagram: (d) =>
      `flowchart LR
  you["you, on ${m(
    d.host,
  )}<br/>psql service=prime"] -->|"socket: who you are,<br/>no password"| pg[("PostgreSQL<br/>instance prime")]
  app["an app or a laptop"] -->|"TLS 1.3, your Linux password<br/>pg-prime.${m(
    d.fqdn ?? d.host,
  )}"| pg
  pg -->|"pg backup: a dump"| dump["/srv/archon-data<br/>(backed up when durable)"]`,
    caption:
      "How people and apps reach a database. Publishing (pg publish) opens the TLS path; the router decides from where.",
  },
  {
    id: "storage",
    label: "Storage and data",
    intro:
      "File sharing (SMB) and S3 buckets, and whether this server holds data that exists nowhere else. Turning a service on asks you to choose: durable (kept and backed up) or ephemeral (losing it is harmless).",
    has: (n) =>
      n.startsWith("fs ") || n.startsWith("backup ") || ["data", "data set", "opt-in"].includes(n),
    first: "data",
    diagram: () =>
      `flowchart TB
  on["turn on SMB, S3, or PostgreSQL"] --> q{"does it hold data that<br/>exists nowhere else?"}
  q -->|"yes: durable"| d["kept across reinstalls,<br/>backed up, erased only with<br/>--confirm-destroy typed by a person"]
  q -->|"no: ephemeral"| e["recreated as needed;<br/>a reinstall starts it empty"]`,
    caption: "Durable or ephemeral: the one question every service that stores data asks.",
  },
  {
    id: "web",
    label: "Web and telemetry",
    intro:
      "Traefik answers HTTPS for this server and its apps, with certificates from Let's Encrypt. Telemetry collects logs and metrics, and can show the whole fleet's in one place.",
    has: (n) => n.startsWith("web ") || n.startsWith("otel ") || n.startsWith("observe"),
    first: "web status",
    diagram: (d) =>
      `flowchart LR
  b["your browser"] -->|"HTTPS"| t["Traefik<br/>*.${m(d.fqdn ?? d.host)}"]
  le["Let's Encrypt"] -->|"certificate<br/>(DNS challenge in Cloudflare)"| t
  t --> c["Archon Console"]
  t --> k["Cockpit"]
  t --> a["apps and containers<br/>(label traefik.enable=true)"]
  o["OpenTelemetry Collector"] -->|"logs, metrics"| ui["telemetry UI"]`,
    caption: "Everything web goes through Traefik on 443; the certificate renews by itself.",
  },
  {
    id: "mail",
    label: "Mail and alerts",
    intro:
      "This server mails the fleet's mailbox when something needs a person: a failed update, a login from a new address, a change made here. Messages wait in a queue until they are sent.",
    has: (n) => n.startsWith("notify ") || n.startsWith("mail "),
    first: "notify status",
    diagram: (d) =>
      `flowchart LR
  ev["an event: a failure,<br/>a login, a change"] --> q["queue on ${m(d.host)}"]
  q -->|"Cloudflare Email Sending"| mb["${m(d.mailbox ?? "the fleet's mailbox")}"]`,
    caption: "How alerts reach you. notify status shows the queue; notify test sends one.",
  },
  {
    id: "shell",
    label: "Your shell",
    intro:
      "Your shell, prompt, and settings on this server come from the fleet repository (dotfiles), the same on every server. These show what you have and where each file comes from.",
    has: (n) => ["shell status", "dotfiles"].includes(n),
    first: "dotfiles",
    diagram: () =>
      `flowchart LR
  e["the engine's base layer"] --> f["the fleet's layer<br/>(home/ in the repository)"] --> u["your files on this server"]
  l["~/.bashrc.local, ~/.config/fish/local.fish<br/>(this machine only, never touched)"] --> u`,
    caption: "Dotfiles in layers: change one in the repository, and every server you use follows.",
  },
];

/** The group a command is in ("server" for anything not listed elsewhere). */
export function groupOf(name: string): ActionGroup {
  return ACTION_GROUPS.find((g) => g.id !== "server" && g.has(name)) ?? SERVER_GROUP;
}

/** What a search matches for a command: its name, summary, and group, lowercase, quote-free. */
export function searchText(c: Command): string {
  return `${c.name} ${c.summary} ${groupOf(c.name).label}`
    .toLowerCase()
    .replace(/[^a-z0-9 .,:/-]/g, " ");
}

/** One group's page: introduction, diagram, its commands, the form, and the terminal. */
export function actionsPage(
  group: ActionGroup,
  cmds: Command[],
  selected: Command,
  s: Session,
  d: WelcomeData,
): Html {
  return actionsView({
    group,
    groupOf,
    cmds,
    selected,
    role: s.role,
    diagram: group.diagram(d),
  });
}

/** What an Actions page shows (either console). */
export interface ActionsView {
  /** The group shown. */
  group: { id: string; label: string; intro: string; caption: string };
  /** Which group a command is in. */
  groupOf(name: string): { id: string; label: string };
  /** Every command offered (the search covers them all). */
  cmds: Command[];
  /** The command whose form is shown. */
  selected: Command;
  /** The person's role. */
  role: Session["role"];
  /** The group's diagram (Mermaid). */
  diagram: string;
  /** A note above the form (the Stolos Console: passphrases go in the terminal). */
  note?: Html;
  /** How the forms differ in this console. */
  form?: FormOptions;
  /** Values to fill in (from the address: ?name=...). */
  values?: Record<string, string>;
}

/** An Actions page: the group's commands on the left, the form and its live output on the right. */
export function actionsView(v: ActionsView): Html {
  const { group, cmds, selected } = v;
  const text = (c: Command) =>
    `${c.name} ${c.summary} ${v.groupOf(c.name).label}`
      .toLowerCase()
      .replace(/[^a-z0-9 .,:/-]/g, " ");
  const mine = cmds.filter((c) => v.groupOf(c.name).id === group.id);
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">Actions</div>
        <h1>${group.label}</h1>
        <p>${group.intro}</p>
      </div>
    </div>
    ${diagram(v.diagram, group.caption)}
    <div class="grid actions" style="margin-top:14px">
      <nav class="card cmdlist" aria-label="${group.label} commands" data-signals="{q: ''}">
        <input
          type="search"
          data-bind:q
          placeholder="Find any command"
          aria-label="Find any command"
          autocomplete="off"
        />
        ${mine.map(
          (c) => html`
            <a
              data-show="$q.trim() === ''"
              href="/actions/${group.id}?cmd=${encodeURIComponent(c.name)}"
              ${c.name === selected.name ? html`aria-current="true"` : ""}
              ><span class="mono">${c.name}</span>${tierPill(c.tier)}<span class="sub"
                >${c.summary}</span
              ></a
            >
          `,
        )}${cmds.map(
          (c) => html`
            <a
              style="display:none"
              data-show="$q.trim() !== '' && '${text(c)}'.includes($q.trim().toLowerCase())"
              href="/actions/${v.groupOf(c.name).id}?cmd=${encodeURIComponent(c.name)}"
              ><span class="mono">${c.name}</span>${tierPill(c.tier)}<span class="sub"
                >${v.groupOf(c.name).label} · ${c.summary}</span
              ></a
            >
          `,
        )}
      </nav>
      <div class="stack" style="min-width:0">
        ${v.note ?? ""} ${commandForm(selected, v.role, "/actions/run", v.values ?? {}, v.form)}
        <div class="card">
          <div class="row spread" style="margin-bottom:8px">
            <h2>Output</h2>
            <span class="sub" id="runstate">Nothing running</span>
          </div>
          <div class="term" id="output" aria-live="polite">
            <div class="dim">Run the command to see its output here, live.</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/** Activity: who did what, from where. */
export function activityPage(
  entries: ActivityEntry[],
  host: string,
  o: { from?: string | undefined; to?: string | undefined; note?: string | undefined } = {},
): Html {
  const pill = (e: ActivityEntry) =>
    e.kind === "run"
      ? html`<span class="pill ${e.code === 0 ? "ok" : "bad"}"
          >${e.code === 0 ? "done" : `exit ${e.code}`}</span
        >`
      : e.kind === "refused" || e.kind === "sign-in failed"
        ? html`<span class="pill bad">${e.kind === "refused" ? "refused" : "failed"}</span>`
        : html`<span class="pill ok">ok</span>`;
  const what = (e: ActivityEntry) =>
    e.kind === "run" ? e.detail : `${e.kind.replace("-", " ")}${e.detail ? ` (${e.detail})` : ""}`;
  const q = new URLSearchParams({
    ...(o.from ? { from: o.from } : {}),
    ...(o.to ? { to: o.to } : {}),
  }).toString();
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${host}</div>
        <h1>Activity</h1>
        <p>
          Who signed in and what they ran from this console, newest first. Commands also record
          themselves where they always do (the journal, this server's database), naming the
          person.${o.note ? ` ${o.note}` : ""}
        </p>
      </div>
      <a class="btn ghost" href="/export/activity.csv${q ? `?${q}` : ""}" download>Download CSV</a>
    </div>
    <form
      class="card row"
      method="get"
      action="/activity"
      style="gap:10px;flex-wrap:wrap;margin-bottom:14px"
    >
      <label class="field" style="max-width:200px"
        ><span>From (UTC date)</span><input type="date" name="from" value="${o.from ?? ""}"
      /></label>
      <label class="field" style="max-width:200px"
        ><span>To (UTC date)</span><input type="date" name="to" value="${o.to ?? ""}"
      /></label>
      <button class="btn ghost" type="submit">Show</button>
    </form>
    <div class="card scroll">
      <table>
        <thead>
          <tr>
            <th>When (UTC)</th>
            <th>Who</th>
            <th>From</th>
            <th>What</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          ${
            entries.length
              ? entries.map(
                  (e) => html`
                    <tr>
                      <td class="mono">${e.at.slice(0, 16).replace("T", " ")}</td>
                      <td>${e.user}</td>
                      <td class="mono">${e.from}</td>
                      <td class="mono">${what(e)}</td>
                      <td>${pill(e)}</td>
                    </tr>
                  `,
                )
              : html`
                  <tr>
                    <td colspan="5" class="sub">Nothing yet.</td>
                  </tr>
                `
          }
        </tbody>
      </table>
    </div>
  `;
}

/** Entries between two UTC dates (YYYY-MM-DD, both included); a bad date is ignored. */
export function activityBetween(
  entries: ActivityEntry[],
  from?: string,
  to?: string,
): ActivityEntry[] {
  const day = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
  const f = day(from),
    t = day(to);
  return entries.filter((e) => (!f || e.at.slice(0, 10) >= f) && (!t || e.at.slice(0, 10) <= t));
}

/** Activity as CSV, for an auditor. */
export function activityCsv(entries: ActivityEntry[]): string {
  const cell = (v: unknown): string => {
    const x = text(v);
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  return (
    [
      "at_utc,user,from,kind,detail,exit_code",
      ...entries.map((e) => [e.at, e.user, e.from, e.kind, e.detail, e.code].map(cell).join(",")),
    ].join("\r\n") + "\r\n"
  );
}

/** Guide: what's here and how to use it, each with the actions that do it. */
export function guidePage(
  items: GuideItem[],
  guides: Array<{ name: string; title: string }>,
  offered: Set<string>,
  host: string,
): Html {
  const action = (cmd: string) => {
    const name = (
      cmd.replace(/^(sudo\s+)?archon\s+/, "").split(/\s+--?|\s+[A-Z<]/)[0] ?? ""
    ).trim();
    return offered.has(name) ? name : undefined;
  };
  const cats = [...new Set(items.map((i) => i.category))];
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${host}</div>
        <h1>Guide</h1>
        <p>
          What is on this server and how to use it, in plain words. Commands that the console can
          run have a button.
        </p>
      </div>
    </div>
    <div class="stack">
      ${cats.map(
        (c) => html`
          <section class="stack">
            <h2>${CATEGORIES[c]?.title ?? c}</h2>
            <p class="sub" style="margin:0">${CATEGORIES[c]?.intro ?? ""}</p>
            <div class="grid cols-2">
              ${items
                .filter((i) => i.category === c)
                .map(
                  (i) => html`
                    <div class="card">
                      <h3>${i.title}</h3>
                      <p class="sub">${i.what}</p>
                      ${(i.use ?? []).map((u) => {
                        const a = action(u.cmd);
                        return html`
                          <div class="row spread" style="padding:4px 0">
                            <span><code>${u.cmd}</code> <span class="sub">${u.why}</span></span
                            >${
                              a
                                ? html`<a
                                    class="btn ghost"
                                    href="/actions?cmd=${encodeURIComponent(a)}"
                                    >Open</a
                                  >`
                                : ""
                            }
                          </div>
                        `;
                      })}${(i.links ?? []).map(
                        (l) => html`
                          <a href="${l.href}" target="_blank" rel="noopener">${l.label}</a>
                        `,
                      )}${
                        i.guide ? html`<p><a href="/guide/${i.guide}">Read the guide</a></p>` : ""
                      }
                    </div>
                  `,
                )}
            </div>
          </section>
        `,
      )}
      <div class="card">
        <h2>Guides</h2>
        <div class="stack">
          ${guides.map((g) => html`<a href="/guide/${g.name}">${g.title}</a>`)}
        </div>
      </div>
    </div>
  `;
}

/** A unit's state as a pill. */
function unitPill(u: UnitRow): Html {
  const cls =
    u.active === "active"
      ? "ok"
      : u.active === "failed"
        ? "bad"
        : u.enabled === "masked"
          ? "off"
          : "warn";
  const word = u.enabled === "masked" ? "off (masked)" : u.sub ? `${u.active}, ${u.sub}` : u.active;
  return html`<span class="pill ${cls}">${word}</span>`;
}

/** Services: the optional ones with their switches, then every unit of the plan with its state. */
export function servicesPage(sf: ServicesFacts, s: Session, host: string): Html {
  const group = (cmd: string) => groupOf(cmd.replace(/^archon\s+/, ""));
  const link = (cmd: string, label: string, ghost = true) => {
    const name = cmd.replace(/^archon\s+/, "");
    return html`<a
      class="btn${ghost ? " ghost" : ""}"
      href="/actions/${group(cmd).id}?cmd=${encodeURIComponent(name)}"
      >${label}</a
    >`;
  };
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${host}</div>
        <h1>Services</h1>
        <p>
          What runs on this server. Optional services are off until an operator turns one on;
          turning on one that keeps data asks whether its data is durable (kept, backed up) or
          ephemeral. Everything else is always on, because the model in Git says so.
        </p>
      </div>
    </div>
    <div class="card">
      <h2>Optional services</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>State</th>
              <th>Data</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${sf.optIns.map(
              (o) => html`
                <tr>
                  <td>
                    <span class="row" style="gap:8px"
                      >${logo(logoFor(o.title))}<b>${o.title}</b></span
                    >${
                      o.since
                        ? html`<div class="sub">
                            ${o.on ? "on" : "off"} since ${o.since.slice(0, 16).replace("T", " ")}
                            by ${o.by ?? "?"}
                          </div>`
                        : ""
                    }
                  </td>
                  <td><span class="pill ${o.on ? "ok" : "off"}">${o.on ? "on" : "off"}</span></td>
                  <td>
                    ${
                      o.data
                        ? html`<span class="pill ${o.data === "durable" ? "warn" : "off"}"
                            >${o.data}</span
                          >`
                        : html`<span class="sub">none</span>`
                    }
                  </td>
                  <td class="row" style="justify-content:flex-end">
                    ${
                      o.on
                        ? [
                            link(o.commands.status, "Status"),
                            s.role === "operator" ? link(o.commands.off, "Turn off") : "",
                          ]
                        : s.role === "operator"
                          ? link(o.commands.on, "Turn on", false)
                          : html`<span class="sub">an operator turns it on</span>`
                    }
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row spread">
        <h2>Always on</h2>
        <span class="sub">${sf.units.length} units from the model</span>
      </div>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>State</th>
              <th>Why it's here</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${sf.units.map(
              (u) => html`
                <tr>
                  <td>
                    <span class="row" style="gap:8px"
                      >${logo(logoFor(u.unit), 16)}<span class="mono">${u.unit}</span></span
                    >
                  </td>
                  <td>${unitPill(u)}</td>
                  <td class="sub">spec ${u.spec}</td>
                  <td>
                    <a class="btn ghost" href="/logs?unit=${encodeURIComponent(u.unit)}">Logs</a>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/** Apps: every address this server answers, with its logo. */
export function appsPage(d: WelcomeData): Html {
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${d.host}</div>
        <h1>Apps</h1>
        <p>
          Every address this server answers over HTTPS, each with a certificate that renews by
          itself. A container started with the label <code>traefik.enable=true</code> appears here
          on its own.
        </p>
      </div>
    </div>
    ${
      d.services.length
        ? html`<div class="grid cols-3">
            ${d.services.map(
              (x) => html`
                <a
                  class="card stack"
                  style="text-decoration:none;color:var(--ink)"
                  href="${x.url}"
                  target="_blank"
                  rel="noopener"
                >
                  <span class="row" style="gap:10px"
                    >${logo(logoFor(x.name), 24)}
                    <h2>${x.name}</h2>
                    ${
                      x.source === "container" ? html`<span class="pill off">container</span>` : ""
                    }</span
                  >
                  <span class="sub">${x.description ?? ""}</span
                  ><span class="mono sub">${x.url.replace("https://", "")}</span></a
                >
              `,
            )}
          </div>`
        : html`
            <div class="card sub">
              No apps yet: this server has no web domain (fleet.web), or nothing is published.
            </div>
          `
    }
    ${
      d.unrouted.length
        ? html`
            <div class="help" style="margin-top:14px">
              <h3>Listening but not published</h3>
              <p>
                Ports ${d.unrouted.join(", ")} accept connections but have no HTTPS address. Add a
                route in the model to give one an address.
              </p>
            </div>
          `
        : ""
    }
  `;
}

/** Data: durable or ephemeral, why, and the backups. */
export function dataPage(d: WelcomeData, sf: ServicesFacts): Html {
  const durable = d.data?.class === "durable";
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${d.host}</div>
        <h1>Data</h1>
        <p>
          Whether this server holds data that exists nowhere else. That decides what a reinstall may
          erase, and what is backed up.
        </p>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card stack">
        <div class="row">
          <span class="pill ${durable ? "warn" : "off"}">${d.data?.class ?? "unknown"}</span>
          <h2>
            ${
              durable
                ? "This server holds data that exists nowhere else"
                : "Nothing here exists only here"
            }
          </h2>
        </div>
        ${(d.data?.reasons ?? []).map((r) => html`<div class="sub">${r}</div>`)}
        <div class="sub">
          ${
            durable
              ? "A reinstall keeps it, and nothing erases it without --confirm-destroy typed by a person."
              : "A reinstall starts this server fresh; nothing is lost that is not also elsewhere."
          }
        </div>
      </div>
      ${diagram(
        `flowchart TB
  q{"data that exists<br/>nowhere else?"} -->|durable| k["kept across reinstalls<br/>backed up"]
  q -->|ephemeral| e["recreated as needed"]
  ${sf.optIns
    .flatMap((o) => (o.data ? [{ title: o.title, data: o.data }] : []))
    .map((o, i) => `s${i}["${m(o.title)}: ${m(o.data)}"] --> q`)
    .join("\n  ")}`,
        "Each service that stores data is either durable or ephemeral; the server is durable if any of them is.",
      )}
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Backups</h2>
      ${
        d.backup
          ? html`
              <p>
                Last backup:
                ${d.backup.last ? d.backup.last.slice(0, 16).replace("T", " ") : "never"}
                ${
                  d.backup.ok === false
                    ? html`<span class="pill bad">failed</span>`
                    : d.backup.last
                      ? html`<span class="pill ok">ok</span>`
                      : ""
                }
              </p>
              <a class="btn ghost" href="/actions/storage?cmd=backup%20run">Back up now</a>
            `
          : html`<p class="sub">This server has no backup timer: nothing on it needs one.</p>`
      }
    </div>
  `;
}

/** Logs: the journal, live, for one unit or everything. */
export function logsPage(units: string[], selected: string | undefined, host: string): Html {
  const q = selected ? `?unit=${encodeURIComponent(selected)}` : "";
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${host}</div>
        <h1>Logs</h1>
        <p>
          The system journal, live: the last 150 lines, then each new one as it is written. Choose a
          service to see only its lines. Older history is in Cockpit and the telemetry UI.
        </p>
      </div>
      <form method="get" action="/logs" class="row">
        <select name="unit" aria-label="Service" onchange="this.form.submit()">
          <option value="">everything</option>
          ${units.map(
            (u) => html`<option ${u === selected ? "selected" : ""}>${u}</option>`,
          )}</select
        ><noscript><button class="btn ghost">Show</button></noscript>
      </form>
    </div>
    <div class="term" id="logs" data-init="@get('/logs/stream${q}')" aria-live="off">
      <div class="dim">Connecting to the journal ...</div>
    </div>
  `;
}
