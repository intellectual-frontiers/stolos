/**
 * Spec 066: the Stolos Console's pages, for the person who runs the fleet
 * from their PC: the fleet at a glance, every machine (managed, adopted, in
 * a cloud), the clouds, one SQL question to every machine, the changes
 * waiting in the repository and who may approve them, and every `stolos`
 * command as a form. Each page says what it is for and draws, from the
 * fleet's real state, how the pieces connect.
 *
 * @module
 */

import type { Command } from "../core/registry-types.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Observed } from "../adopt/adopt.ts";
import { type Html, html } from "./html.ts";
import { diagram, type NavItem } from "./layout.ts";
import { logo, logoFor } from "./logos.ts";

/** The logo for an operating system's name. */
export function osLogo(os: string): string | undefined {
  const n = os.toLowerCase();
  return n.includes("mac")
    ? "apple"
    : n.includes("ubuntu")
    ? "ubuntu"
    : n.includes("linux") || n.includes("arch") || n.includes("fedora") || n.includes("debian")
    ? "linux"
    : logoFor(os);
}
import type { PcCloud, PcFacts, PcMachine } from "./pc.ts";

/** The Stolos Console's menu. */
export const STOLOS_NAV: NavItem[] = [
  { group: "Fleet", label: "Overview", href: "/" },
  { group: "Fleet", label: "Machines", href: "/machines" },
  { group: "Fleet", label: "Clouds", href: "/clouds" },
  { group: "Fleet", label: "Ask every machine", href: "/query" },
  { group: "Fleet", label: "Installs", href: "/boot" },
  { group: "Fleet", label: "Changes", href: "/changes" },
  { group: "Fleet", label: "Trust", href: "/trust" },
  { group: "Fleet", label: "Compliance", href: "/compliance" },
  { group: "Fleet", label: "Activity", href: "/activity" },
  { group: "Actions", label: "The fleet", href: "/actions/fleet" },
  { group: "Actions", label: "Servers", href: "/actions/machines" },
  { group: "Actions", label: "Adopted machines", href: "/actions/adopted" },
  { group: "Actions", label: "Clouds", href: "/actions/clouds" },
  { group: "Actions", label: "Signers and keys", href: "/actions/trust" },
  { group: "Actions", label: "Vault and backups", href: "/actions/vault" },
  { group: "Learn", label: "How it works", href: "/how" },
  { group: "Learn", label: "Guide", href: "/guide" },
];

const m = (s: string) => s.replace(/"/g, "'").replace(/[<>]/g, "");

/** How long ago, in words. */
export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** A Stolos action group: its page, introduction, diagram, and commands. */
export interface StolosGroup {
  /** Its address: /actions/<id>. */
  id: string;
  /** Its name in the menu. */
  label: string;
  /** What it is about. */
  intro: string;
  /** Its commands. */
  names: string[];
  /** The command shown first. */
  first: string;
  /** How this part works (Mermaid), from the fleet's facts. */
  diagram(f: PcFacts): string;
  /** Under the diagram. */
  caption: string;
}

/** The Stolos Console's action groups, in menu order. */
export const STOLOS_GROUPS: StolosGroup[] = [
  {
    id: "fleet",
    label: "The fleet",
    intro:
      "The fleet is a Git repository: you describe machines in TypeScript, apply signs and pushes the change, and every server pulls it within 15 minutes.",
    names: [
      "where",
      "fleet status",
      "validate",
      "build",
      "apply",
      "decide",
      "update",
      "explain",
      "fleet use",
      "fleet init",
      "fleet upgrade",
      "export",
    ],
    first: "where",
    diagram: (f) =>
      `flowchart LR
  you["You: edit fleets/${m(f.fleet.id)}/"] --> validate["validate and build"]
  validate --> apply["apply: one signed commit, push"]
  apply --> gh["GitHub: ${m(f.fleet.repo)}"]
  gh -- "pulled every 15 minutes" --> servers["${
        f.machines.filter((x) => x.kind === "server").length
      } server(s)"]
  servers -- "check the signature, apply, verify" --> servers`,
    caption: "A change is a commit; a server applies only commits signed by a fleet signer.",
  },
  {
    id: "machines",
    label: "Servers",
    intro:
      "Machines Stolos installs and manages: add one (its model, deploy key, and an armed install), install it over the network from this PC, or turn a WSL distribution into a workstation.",
    names: ["host add", "host bootstrap", "workstation add", "fleet trust"],
    first: "host add",
    diagram: () =>
      `flowchart LR
  add["host add: model + deploy key + armed install"] --> boot["This PC serves the installer (boot)"]
  boot --> server["The machine installs Ubuntu"]
  server -- "registration.ts: its SSH keys" --> git["Fleet repository"]
  git -- "fleet trust" --> pc["Your known_hosts"]`,
    caption:
      "Each server's SSH host keys are recorded in Git, so you can trust them without guessing.",
  },
  {
    id: "adopted",
    label: "Adopted machines",
    intro:
      "Machines someone else installed (your laptop, a colleague's desktop): Stolos observes and checks them over SSH with a probe key that can run one read-only script, and never changes them.",
    names: [
      "compliance",
      "discover",
      "host adopt",
      "host observe",
      "host check",
      "host accept",
      "host release",
      "fleet query",
    ],
    first: "host check",
    diagram: (f) =>
      `flowchart LR
  pc["This PC"] -- "probe key (vault)" --> sshd["sshd on ${f.adopted.length} adopted machine(s)"]
  sshd -- "forced command" --> probe["stolos-probe: read-only"]
  probe -- "facts" --> obs["observed.ts in Git"]
  obs --> check["host check: policies (SCF)"]`,
    caption: "The probe key's authorized_keys line forbids a shell, a terminal, and forwarding.",
  },
  {
    id: "clouds",
    label: "Clouds",
    intro:
      "What the fleet keeps in Cloudflare, Microsoft 365 and Azure, AWS, and Hetzner, read with read-only credentials. Stolos never changes a cloud.",
    names: ["cloud connect", "cloud observe", "cloud check", "cloud assets", "cloud disconnect"],
    first: "cloud check",
    diagram: (f) =>
      `flowchart LR
  vault["Vault: read-only credentials"] --> observe["cloud observe"]
${
        f.clouds.map((c) =>
          `  observe --> ${c.id}["${m(c.title)}${c.connected ? "" : " (not connected)"}"]`
        ).join("\n")
      }
  observe --> git["fleets/${m(f.fleet.id)}/clouds/*.ts"]`,
    caption: "Each observation is a file in Git: its history is the account's history.",
  },
  {
    id: "trust",
    label: "Signers and keys",
    intro:
      "Who may approve changes: each signer's public key is in signers.ts, and servers refuse a commit no signer signed. Adding or removing a signer, and keys that change, are done in the terminal (deno task stolos signers add, keys setup), never here.",
    names: ["signers", "keys", "keys check-recovery"],
    first: "keys",
    diagram: (f) =>
      `flowchart LR
${
        f.signers.map((s, i) => `  s${i}["${m(s.name)} (${s.role})"] --> signers`).join("\n") ||
        '  none["no signers yet"] --> signers'
      }
  signers["signers.ts"] --> allowed["/etc/archon/allowed_signers on each server"]
  allowed -- "git verify-commit" --> apply["a server applies the commit"]`,
    caption:
      "The daily key signs every change; the recovery key, kept offline, replaces a lost one.",
  },
  {
    id: "vault",
    label: "Vault and backups",
    intro:
      "The vault on this PC holds every secret (deploy keys, the probe keys, cloud credentials). Back it up to a ZIP with a passphrase; a fresh PC restores it with vault restore.",
    names: ["vault status", "vault list", "vault backup"],
    first: "vault status",
    diagram: () =>
      `flowchart LR
  vault["Vault (this PC only)"] -- "vault backup: passphrase in the terminal" --> zip["backup ZIP"]
  zip -- "keep it off this PC" --> safe["your safe place"]
  safe -- "vault restore (on a new PC)" --> vault`,
    caption: "Secrets never go into Git; the backup is the only other copy.",
  },
];

/** The group a command is in. */
export function stolosGroupOf(name: string): StolosGroup {
  return STOLOS_GROUPS.find((g) => g.names.includes(name)) ?? STOLOS_GROUPS[0];
}

const kindPill = (k: PcMachine["kind"]) =>
  html`<span class="pill ${k === "server" ? "ok" : k === "adopted" ? "tier" : "off"}">${k}</span>`;

const score = (x?: { pass: number; total: number }) =>
  !x
    ? html`<span class="pill off">not checked</span>`
    : html`<span class="pill ${x.pass === x.total ? "ok" : "warn"}">${x.pass} of ${x.total}</span>`;

/** The fleet at a glance. */
export function stolosOverview(f: PcFacts, now = Date.now()): Html {
  const by = (k: PcMachine["kind"]) => f.machines.filter((x) => x.kind === k).length;
  const failing = f.machines.filter((x) => x.failing.length);
  const stuck = f.machines.filter((x) => x.sync?.blocked);
  const cloudFails = f.clouds.flatMap((c) =>
    c.results.filter((r) => r.status === "fail").map((r) => ({ c, r }))
  );
  return html`
    <div class="pagehead"><div><div class="crumb">${f.fleet.title}</div><h1>Overview</h1>
      <p>Every machine and cloud account this fleet is responsible for, and what needs you.</p></div>
      <a class="btn" href="/actions/fleet?cmd=fleet%20status">Ask every server now</a></div>
    <div class="grid cols-3">
      <div class="card">
        <div class="k">Managed</div>
        <div class="v">${by("server")} server(s), ${by("workstation")} workstation(s)</div>
        <div class="sub">installed and converged by Stolos</div>
      </div>
      <div class="card">
        <div class="k">Adopted</div>
        <div class="v">${by("adopted")} machine(s)</div>
        <div class="sub">observed and checked, never changed</div>
      </div>
      <div class="card">
        <div class="k">Clouds</div>
        <div class="v">${f.clouds.filter((c) => c.connected).length} of ${f.clouds
          .length} connected</div>
        <div class="sub">${f.clouds.filter((c) => c.observed).map((c) =>
          `${c.observed!.assets.length} in ${c.title}`
        ).join(", ") || "none observed yet"}</div>
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h2>Needs attention</h2>
        ${failing.length || cloudFails.length || f.git.unapproved.length || stuck.length
          ? html`${
            stuck.map((x) =>
              html`
                <div class="row spread"
                  style="padding:6px 0"><span><b>${x
                    .name}</b> did not take the newest change <span class="sub">${syncAdvice(
                      x.sync!.blocked!,
                    ).what}</span></span><a class="btn ghost" href="/machines/${encodeURIComponent(
                      x.name,
                    )}">Why</a></div>
              `
            )
          }${
            f.git.unapproved.length
              ? html`
                <div class="row spread"
                  style="padding:6px 0"><span>${f.git.unapproved
                    .length} commit(s) servers will refuse (not signed by a signer)</span><a class="btn ghost" href="/changes">Approve</a></div>
              `
              : ""
          }${
            failing.map((x) =>
              html`
                <div class="row spread"
                  style="padding:6px 0;border-top:1px solid var(--line)"><span><b>${x
                    .name}</b> ${kindPill(x.kind)} <span class="sub">not met: ${x.failing.slice(
                      0,
                      3,
                    ).join(
                      "; ",
                    )}</span></span><a class="btn ghost" href="/machines/${encodeURIComponent(
                      x.name,
                    )}">Open</a></div>
              `
            )
          }${
            cloudFails.map(({ c, r }) =>
              html`
                <div class="row spread"
                  style="padding:6px 0;border-top:1px solid var(--line)"><span>${c.logo
                    ? logo(c.logo, 16)
                    : ""} <b>${c.title}</b> <span class="sub">${r
                    .title}</span></span><a class="btn ghost" href="/clouds#${c.id}">Open</a></div>
              `
            )
          }`
          : html`<p class="sub">Nothing: every check that ran passes, and every commit is approved.</p>`}
      </div>
      <div class="card">
        <h2>The repository</h2>
        <div class="sub">${f.fleet.repo} · engine ${f.fleet.engine ?? "?"}</div>
        <div style="margin-top:8px">${f.git.dirty.length
          ? html`<span class="pill warn">${f.git.dirty.length} file(s) changed, not applied</span>`
          : html`<span class="pill ok">no local changes</span>`}</div>
        <div class="sub" style="margin-top:8px">Last commit: ${f.git.log[0]
          ? `"${f.git.log[0].subject}" by ${f.git.log[0].author}, ${ago(f.git.log[0].at, now)}`
          : "none"}</div>
      </div>
    </div>
    ${diagram(
      `flowchart LR
  pc["This PC: Stolos"] -- "apply (signed)" --> git["${m(f.fleet.repo)}"]
  git --> managed["${by("server")} managed server(s)"]
  pc -- "probe (read-only SSH)" --> adopted["${by("adopted")} adopted machine(s)"]
  pc -- "read-only API" --> clouds["${f.clouds.filter((c) => c.connected).length} cloud account(s)"]
  managed -- "Archon Console on each" --> you["You, in a browser"]`,
      "How this PC reaches everything: Git for managed servers, SSH for adopted machines, APIs for clouds.",
    )}
  `;
}

/** Why a server's last pull stopped, in plain words, and what to do. */
export function syncAdvice(blocked: string): { what: string; fix: string; href?: string } {
  if (/E047|not signed|signer|untrusted/i.test(blocked)) {
    return {
      what:
        "the newest commit is not signed by a fleet signer, so the server refuses it (that is the protection working)",
      fix: "Approve it here: Apply signs one commit that approves everything before it.",
      href: "/changes",
    };
  }
  if (/fetch failed|Authentication|could not read|403|401|resolve|timed out/i.test(blocked)) {
    return {
      what: "the server could not fetch from GitHub (network, DNS, or its deploy key)",
      fix:
        "Open its Archon Console and run network diagnostics (Actions, This server: doctor); check the deploy key is on GitHub.",
    };
  }
  if (/uncommitted|does not come after/i.test(blocked)) {
    return {
      what: "its checkout was changed on the server itself, so it will not overwrite it",
      fix:
        "Changes are made here and applied, never on the server: ask for help before discarding anything on it.",
    };
  }
  return {
    what: blocked,
    fix: "Open its Archon Console: Activity and Logs show the reconcile's last run.",
  };
}

const applies = (x: PcMachine) =>
  !x.applied
    ? ""
    : html`<span class="mono">${x.applied.commit}</span> ${
      x.sync?.blocked
        ? html`<span class="pill bad">stuck</span>`
        : x.upToDate === false
        ? html`<span class="pill warn">behind</span>`
        : x.upToDate
        ? html`<span class="pill ok">newest</span>`
        : ""
    }`;

/** A managed server's changes: what it applies, its last pull, and why it stopped. */
function changeCard(x: PcMachine, f: PcFacts, now: number): Html {
  if (x.kind !== "server") return html``;
  const newest = f.git.log[0];
  const advice = x.sync?.blocked ? syncAdvice(x.sync.blocked) : undefined;
  return html`<div class="card"><h2>Changes</h2>
    ${
    x.applied
      ? html`<p>It applies <span class="mono">${x.applied.commit}</span> "${x.applied.subject}" (${
        ago(x.applied.at, now)
      }).
        ${
        x.upToDate
          ? "That is the repository's newest commit."
          : newest
          ? html`The newest is <span class="mono">${
            newest.sha.slice(0, 7)
          }</span> "${newest.subject}".`
          : ""
      }</p>`
      : html`<p class="sub">This PC has no record of what it applies: Ask every server now (fleet status).</p>`
  }
    ${
    x.sync
      ? advice
        ? html`
          <div
            class="notice bad"><b>Its last pull (${ago(x.sync.at, now)}) stopped:</b> ${advice
              .what}.<br>${advice.fix} ${advice.href
              ? html`<a href="${advice.href}">Open Changes</a>`
              : ""}<details><summary class="sub">The server's words</summary><span class="mono">${x
              .sync.blocked}</span></details></div>
        `
        : html`
          <p
            class="sub">Its last pull (${ago(
              x.sync.at,
              now,
            )}) went fine. Servers pull every 15 minutes; a change you applied arrives within that.</p>
        `
      : ""
  }
  </div>`;
}

/** Every machine, one table. */
export function machinesPage(f: PcFacts, now = Date.now()): Html {
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">${f.fleet.title}</div>
        <h1>Machines</h1>
        <p>Managed servers and workstations, adopted machines, and servers seen in a cloud account. An auditor's asset list: download it as CSV, and every check's result with its SCF controls as JSON.</p>
      </div>
      <div
        class="row"><a class="btn ghost" href="/export/machines.csv" download>Download CSV</a><a class="btn ghost" href="/export/evidence.json" download>Evidence (JSON)</a><a class="btn" href="/actions/adopted?cmd=discover">Find machines not listed</a></div>
    </div>
    <div class="card scroll" data-signals="{q: ''}">
      <input type="search" data-bind:q placeholder="Filter by name, kind, OS, owner" aria-label="Filter machines" autocomplete="off" style="margin-bottom:10px">
      <table>
        <thead><tr><th>Name</th><th>Kind</th><th>OS</th><th>Where</th><th>Owner</th><th>Checks</th><th>Applies</th><th>Last record</th><th></th></tr></thead>
        <tbody>${f.machines.map((x) => {
          const text = `${x.name} ${x.title ?? ""} ${x.kind} ${x.os ?? ""} ${x.owner ?? ""} ${
            x.where ?? ""
          } ${x.failing.join(" ")}`
            .toLowerCase().replace(/[^a-z0-9 .:-]/g, " ");
          return html`
            <tr data-show="'${text}'.includes($q.trim().toLowerCase())">
              <td><a href="/machines/${encodeURIComponent(x.name)}"><b>${x.name}</b></a></td>
              <td>${kindPill(x.kind)}</td>
              <td>${x.os ? html`${logo(osLogo(x.os), 14)} ${x.os}` : ""}</td>
              <td class="mono">${x.where ?? ""}</td>
              <td>${x.owner ?? ""}</td>
              <td>${x.kind === "cloud" ? "" : score(x.score)}</td>
              <td>${applies(x)}</td>
              <td class="sub">${ago(x.seen, now)}</td>
              <td>${x.console
                ? html`<a class="btn ghost" href="${x.console}" target="_blank" rel="noopener">Archon Console</a>`
                : ""}</td>
            </tr>
          `;
        })}</tbody>
      </table>
      ${f.machines.length ? "" : html`
        <p
          class="sub">No machines yet: add a server (Actions, Servers) or adopt one (Actions, Adopted machines).</p>
      `}
    </div>
  `;
}

/** A fix: a command as code, anything else as words. */
export function fixText(fix?: string): Html | string {
  if (!fix) return "";
  return /^(sudo|deno|brew|yay|ssh|git) /.test(fix) ? html`<code>${fix}</code>` : fix;
}

function policyTable(rs: PolicyResult[]): Html {
  const pill = (s: PolicyResult["status"]) =>
    html`<span class="pill ${
      s === "pass" ? "ok" : s === "fail" ? "bad" : s === "warn" || s === "accepted" ? "warn" : "off"
    }">${s}</span>`;
  return html`
    <table>
      <thead>
        <tr>
          <th>Policy</th>
          <th>Result</th>
          <th>Found</th>
          <th>SCF</th>
          <th>Fix</th>
        </tr>
      </thead>
      <tbody>${rs.map((r) =>
        html`
          <tr>
            <td>${r.title}</td>
            <td>${pill(r.status)}</td>
            <td class="sub">${r.detail}</td>
            <td class="mono">${r.scf.join(", ")}</td>
            <td class="sub">${r.status === "pass" ? "" : r.fix ?? ""}</td>
          </tr>
        `
      )}</tbody>
    </table>
  `;
}

function observedFacts(o: Observed): Html {
  const row = (k: string, v: unknown) =>
    v === undefined || v === "" ? "" : html`
      <tr>
        <td class="sub">${k}</td>
        <td>${String(v)}</td>
      </tr>
    `;
  return html`
    <table>
      <tbody>
        ${row("Operating system", `${o.os.name} ${o.os.version}`)}${row(
          "Kernel",
          `${o.os.kernel} ${o.os.arch}`,
        )}
        ${row("Model", o.os.model)}${row("Serial", o.os.serial)}${row("Hostname", o.os.hostname)}
        ${row("CPUs", o.hardware.cpus)}${row(
          "Memory",
          o.hardware.memoryMB ? `${Math.round(o.hardware.memoryMB / 1024)} GB` : undefined,
        )}
        ${row(
          "Disk",
          o.hardware.diskTotalGB
            ? `${o.hardware.diskTotalGB} GB, ${o.hardware.diskUsedPct}% used`
            : undefined,
        )}
        ${row("Disk encryption", o.security.diskEncryption)}${row("Firewall", o.security.firewall)}
        ${row("Automatic updates", o.security.autoUpdates)}${row(
          "Administrators",
          o.security.admins.join(", "),
        )}
        ${row("Packages", o.software.packages ?? o.software.brewPackages)}${row(
          "Updates waiting",
          o.software.pendingUpdates,
        )}
        ${row("osquery", o.software.osquery ?? "not installed")}${row(
          "Listening ports",
          o.listening.join(", "),
        )}
      </tbody>
    </table>
  `;
}

/** One machine's page. */
export function machinePage(f: PcFacts, name: string, now = Date.now()): Html | undefined {
  const x = f.machines.find((y) => y.name === name);
  if (!x) return undefined;
  const a = f.adopted.find((y) => y.machine.name === name);
  const q = encodeURIComponent(name);
  return html`
    <div
      class="pagehead"><div><div class="crumb"><a href="/machines">Machines</a></div><h1>${x
        .name} ${kindPill(x.kind)}</h1>
      <p>${x.kind === "adopted"
        ? `Adopted${
          a?.machine.owner ? ` (${a.machine.owner}'s)` : ""
        }: Stolos observes and checks it, and never changes it. Observed ${ago(x.seen, now)}.`
        : x.kind === "cloud"
        ? `Seen in ${x.where}; not managed or adopted.`
        : `Managed by Stolos: its description is fleets/${f.fleet.id}/hosts/${x.name}.ts. Installed ${
          ago(x.seen, now)
        }.`}</p></div>
      ${x.kind === "adopted"
        ? html`<a class="btn" href="/actions/adopted?cmd=host%20observe&name=${q}">Observe now</a>`
        : x.console
        ? html`<a class="btn" href="${x.console}" target="_blank" rel="noopener">Open its Archon Console</a>`
        : ""}</div>
    ${a
      ? html`
        <div class="grid cols-2">
          <div class="card scroll"><h2>Policies</h2>${policyTable(a.results)}</div>
          <div class="card scroll"><h2>What the probe found</h2>${a.observed
            ? observedFacts(a.observed)
            : html`<p class="sub">Never observed.</p>`}</div>
        </div>
        <div class="card" style="margin-top:14px">
          <h2>History</h2>
          <p
            class="sub">Every observation is a commit: <span class="mono">git log -p fleets/${f
              .fleet.id}/adopted/${x.name}/observed.ts</span></p>
        </div>
      `
      : x.kind === "cloud"
      ? html`
        <div class="card">
          <p>Adopt it if the fleet is responsible for it: <span class="mono">deno task stolos host adopt ${x
            .name.replace(/[^a-z0-9-]/gi, "-")
            .toLowerCase()} --ssh &lt;user&gt;@&lt;address&gt;</span></p>
        </div>
      `
      : html`
        ${changeCard(x, f, now)}
        <div class="grid cols-2" style="margin-top:14px">
          <div class="card"><h2>Checks</h2><div class="v">${score(x.score)}</div>
                  ${x.failing.length
                    ? html`<ul>${x.failing.map((y) => html`<li class="mono">${y}</li>`)}</ul>`
                    : x.score
                    ? html`<p class="sub">Nothing failing at its last verify.</p>`
                    : html`<p class="sub">Not verified yet: this PC has no record of a verify from it.</p>`}
                  <a class="btn ghost" href="/actions/fleet?cmd=fleet%20status">Ask every server now</a></div>
          <div
            class="card"><h2>Ask every machine</h2><p class="sub">One SQL question, through osquery, to this server and every other (each over its MCP server):</p>
                  <a class="btn ghost" href="/query?sql=${encodeURIComponent(
                    "select name, version from os_version",
                  )}">What OS is every machine on?</a></div>
        </div>
      `}
  `;
}

function cloudCard(c: PcCloud, now: number): Html {
  const kinds = new Map<string, number>();
  for (const a of c.observed?.assets ?? []) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  return html`<div class="card" id="${c.id}">
    <div class="row spread"><h2>${c.logo ? logo(c.logo, 20) : ""} ${c.title}</h2>${
    c.connected ? html`<span class="pill ok">connected</span>` : html`
      <a class="btn ghost"
        href="/actions/clouds?cmd=cloud%20connect&provider=${c.id}">Connect (read-only)</a>
    `
  }</div>
    ${
    c.observed
      ? html`
        <div class="sub">${c.observed.account} · observed ${ago(c.observed.at, now)} · ${c.observed
          .assets.length} assets</div>
                <div class="row" style="flex-wrap:wrap;gap:6px;margin:8px 0">${[...kinds].map((
                  [k, n],
                ) => html`<span class="pill off">${n} ${k}</span>`)}</div>
                ${c.observed.gaps.length
                  ? html`
                    <details>
                      <summary class="sub">${c.observed.gaps
                        .length} part(s) the credential may not read</summary>
                      <ul class="sub">${c.observed.gaps.map((g) => html`<li>${g}</li>`)}</ul>
                    </details>
                  `
                  : ""}
                <div class="scroll" style="margin-top:8px">${policyTable(c.results)}</div>
                <details style="margin-top:8px">
          <summary>Every asset</summary>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Name</th>
                  <th>Where</th>
                  <th>Fleet</th>
                  <th>Facts</th>
                </tr>
              </thead>
              <tbody>${c.observed.assets.map((a) =>
                html`
                  <tr>
                    <td>${a.kind}</td>
                    <td class="mono">${a.name}</td>
                    <td class="sub">${a.where ?? ""}</td>
                    <td>${a.fleetMachine ?? ""}</td>
                    <td class="sub">${Object.entries(a.facts ?? {}).map(([k, v]) => `${k}=${v}`)
                      .join(" ")}</td>
                  </tr>
                `
              )}</tbody>
            </table>
          </div>
        </details>
      `
      : html`<p class="sub">${c.connected ? "Connected, not observed yet." : "Not connected."}</p>`
  }
  </div>`;
}

/** The clouds. */
export function cloudsPage(f: PcFacts, now = Date.now()): Html {
  return html`
    <div class="pagehead"><div><div class="crumb">${f.fleet.title}</div><h1>Clouds</h1>
      <p>What the fleet keeps in its cloud accounts, read with read-only credentials, and how each account is set up. Stolos never changes a cloud.</p></div>
      <a class="btn" href="/actions/clouds?cmd=cloud%20observe">Observe every cloud now</a></div>
    <div class="stack">${f.clouds.map((c) => cloudCard(c, now))}</div>
  `;
}

/** One question to every machine. */
export function queryPage(sql: string): Html {
  const examples: Array<[string, string]> = [
    ["Which OS is every machine on?", "select name, version from os_version"],
    ["What listens on the network?", "select port, address, protocol from listening_ports"],
    ["Who can sign in?", "select username, shell from users where shell not like '%nologin%'"],
    ["Which disks are encrypted?", "select name, encrypted, type from disk_encryption"],
    ["How long has each been up?", "select days, hours from uptime"],
  ];
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">Fleet</div>
        <h1>Ask every machine</h1>
        <p>One SQL question (osquery) to every managed server, over its MCP server, and every adopted machine with osquery, through its probe. Read-only: only one SELECT on the allowed tables, and each server checks again.</p>
      </div>
    </div>
    <form class="card stack" id="queryform" data-on:submit="@post('/query/run', {contentType: 'form'})">
      <label
        class="field"><span>SQL <span class="sub">(one SELECT)</span></span><input type="text" name="sql" value="${sql}" autocomplete="off" class="mono"></label>
      <div
        class="row"><button class="btn" type="submit">Ask</button><span class="sub" id="runstate">Nothing asked yet</span></div>
      <div class="row" style="flex-wrap:wrap;gap:6px">${examples.map(([t, q]) =>
        html`<a class="btn ghost" href="/query?sql=${encodeURIComponent(q)}">${t}</a>`
      )}</div>
    </form>
    <div class="card scroll" style="margin-top:14px" id="answer">
      <p class="sub">The answer appears here, one row per machine and result.</p>
    </div>
  `;
}

/** The answer to a fleet query, as a table. */
export function answerTable(
  answers: Array<
    { machine: string; kind: string; rows?: Array<Record<string, unknown>>; error?: string }
  >,
): Html {
  const rows = answers.flatMap((a) => (a.rows ?? []).map((r) => ({ machine: a.machine, ...r })));
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const errors = answers.filter((a) => a.error);
  return html`<div class="card scroll" id="answer">
    ${
    rows.length
      ? html`
        <table>
          <thead>
            <tr>${cols.map((c) => html`<th>${c}</th>`)}</tr>
          </thead>
          <tbody>${rows.map((r) =>
            html`<tr>${
              cols.map((c) =>
                html`<td class="mono">${String((r as Record<string, unknown>)[c] ?? "")}</td>`
              )
            }</tr>`
          )}</tbody>
        </table>
      `
      : html`<p class="sub">No rows.</p>`
  }
    ${
    errors.length
      ? html`<div style="margin-top:10px">${
        errors.map((e) => html`<div class="notice warn"><b>${e.machine}</b>: ${e.error}</div>`)
      }</div>`
      : ""
  }
    <p class="sub">${rows.length} row(s) from ${
    answers.filter((a) => a.rows).length
  } of ${answers.length} machine(s).</p>
  </div>`;
}

/** The changes waiting, and the history. */
export function changesPage(f: PcFacts, now = Date.now()): Html {
  return html`
    <div class="pagehead"><div><div class="crumb">${f.fleet.repo}</div><h1>Changes</h1>
      <p>What you changed and have not applied, the commits servers would refuse because no signer signed them, and the history. Apply checks, builds, signs one commit, and pushes: servers take it within 15 minutes.</p></div>
      <a class="btn" href="/actions/fleet?cmd=apply">Apply</a></div>
    <div class="grid cols-2">
      <div class="card"><h2>Not applied yet</h2>${f.git.dirty.length
        ? html`<ul class="mono">${f.git.dirty.map((l) => html`<li>${l}</li>`)}</ul>${
          f.git.diff
            ? html`
              <details>
                <summary>What Apply will commit (the diff)</summary>
                <pre class="term" style="height:auto;max-height:420px">${f.git.diff}</pre>
              </details>
            `
            : ""
        }`
        : html`<p class="sub">Nothing: the repository matches its last commit.</p>`}</div>
      <div class="card"><h2>Waiting for approval</h2>${f.git.unapproved.length
        ? html`
          <p
            class="sub">Servers refuse these until a signer approves them (apply does, with one signed commit):</p>
          <ul class="mono">${f.git.unapproved.map((l) => html`<li>${l}</li>`)}</ul>
        `
        : html`<p class="sub">Nothing: the newest commit is signed by a signer.</p>`}</div>
    </div>
    ${diagram(
      `flowchart LR
  edit["Edit fleets/${m(f.fleet.id)}/"] --> apply["apply"]
  apply --> sign["sign with your daily key"]
  sign --> push["push to ${m(f.fleet.repo)}"]
  push --> verify["each server: git verify-commit"]
  verify -- "signed by a signer" --> converge["apply and verify"]
  verify -- "not signed" --> refuse["refuse, and say so"]`,
      "Why a change you pushed by hand may not reach a server: it must be signed.",
    )}
    <div class="card scroll" style="margin-top:14px">
      <h2>History</h2>
      <table>
        <thead>
          <tr>
            <th>Commit</th>
            <th>Subject</th>
            <th>Author</th>
            <th>When</th>
            <th>Approved</th>
          </tr>
        </thead>
        <tbody>${f.git.log.map((c) =>
          html`
            <tr>
              <td class="mono">${c.sha}</td>
              <td>${c.subject}</td>
              <td>${c.author}</td>
              <td class="sub">${ago(c.at, now)}</td>
              <td>${c.approved
                ? html`<span class="pill ok">signed</span>`
                : html`<span class="pill warn">waiting</span>`}</td>
            </tr>
          `
        )}</tbody>
      </table>
    </div>
  `;
}

/** Who may approve changes. */
export function trustPage(f: PcFacts): Html {
  return html`
    <div class="pagehead"><div><div class="crumb">${f.fleet.repo}</div><h1>Trust</h1>
      <p>Servers apply a commit only when a signer signed it. Each signer is a public key in fleets/${f
        .fleet
        .id}/signers.ts; the private keys stay on the signers' own machines (the daily key) or offline (the recovery key). Stolos never sees a passphrase.</p></div>
      <a class="btn" href="/actions/trust?cmd=keys">Check my keys</a></div>
    <div
      class="card scroll"><table><thead><tr><th>Signer</th><th>Role</th><th>Added</th><th>Public key</th></tr></thead><tbody>${f
        .signers.map((s) =>
          html`
            <tr>
              <td><b>${s.name}</b></td>
              <td><span class="pill ${s.role === "daily" ? "ok" : "tier"}">${s.role}</span></td>
              <td class="sub">${s.added}</td>
              <td class="mono">${s.key.slice(0, 40)}...</td>
            </tr>
          `
        )}</tbody></table>${f.signers.length
        ? ""
        : html`<p class="sub">No signers yet: deno task stolos keys setup, in the terminal.</p>`}</div>
    ${diagram(
      STOLOS_GROUPS.find((g) => g.id === "trust")!.diagram(f),
      "From a signature on your PC to a server applying the change.",
    )}
  `;
}

/** How Stolos works, drawn. */
export function stolosHowPage(f: PcFacts): Html {
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">Learn</div>
        <h1>How it works</h1>
        <p>Stolos runs on this PC and describes the fleet; Archon runs on each server and makes it match. Git connects them.</p>
      </div>
    </div>
    ${diagram(
      `flowchart TB
  subgraph pc["This PC"]
    stolos["Stolos (deno task stolos)"] --- vault["Vault: secrets"]
    stolos --- repo["Checkout of ${m(f.fleet.repo)}"]
  end
  subgraph gh["GitHub"]
    remote["${m(f.fleet.repo)}"]
    engine["intellectual-frontiers/stolos (engine ${m(f.fleet.engine ?? "?")})"]
  end
  subgraph server["Each server"]
    archon["Archon"] --- checkout["Checkout (deploy key, read-only)"]
  end
  repo -- "apply: signed push" --> remote
  remote -- "pull every 15 minutes" --> checkout
  engine -- "pinned in deno.json" --> archon`,
      "Two repositories: your fleet (private) and the engine (public, pinned by version).",
    )}
    ${diagram(
      `sequenceDiagram
  participant You
  participant Stolos as Stolos (PC)
  participant Git as GitHub
  participant Server
  You->>Stolos: apply
  Stolos->>Stolos: validate, build, sign
  Stolos->>Git: push
  loop every 15 minutes
    Server->>Git: fetch
    Server->>Server: verify the signature, apply, verify
  end
  You->>Server: Archon Console (https)`,
      "A change, from your keyboard to every server.",
    )}
  `;
}

/** A CSV cell. */
const cell = (v: unknown) => {
  const t = String(v ?? "");
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** The asset list as CSV, for an auditor's spreadsheet. */
export function machinesCsv(f: PcFacts): string {
  const head = [
    "name",
    "title",
    "kind",
    "os",
    "where",
    "owner",
    "serial",
    "checks_passed",
    "checks_total",
    "not_met",
    "last_record",
  ];
  const rows = f.machines.map((x) =>
    [
      x.name,
      x.title,
      x.kind,
      x.os,
      x.where,
      x.owner,
      x.serial,
      x.score?.pass,
      x.score?.total,
      x.failing.join("; "),
      x.seen,
    ].map(cell).join(",")
  );
  return [head.join(","), ...rows].join("\r\n") + "\r\n";
}

/** Every policy result, with its SCF controls, as one JSON document for an auditor. */
export function evidence(f: PcFacts, now = new Date()): unknown {
  return {
    generated: now.toISOString(),
    fleet: f.fleet,
    note:
      "SCF mappings are a starter set: verify them against the Secure Controls Framework before relying on them.",
    managed: f.machines.filter((x) => x.kind === "server" || x.kind === "workstation").map((x) => ({
      name: x.name,
      kind: x.kind,
      installed: x.seen,
      checks: x.score,
      failing: x.failing,
    })),
    adopted: f.adopted.map((a) => ({
      name: a.machine.name,
      owner: a.machine.owner,
      observed: a.observed?.at,
      results: a.results,
    })),
    clouds: f.clouds.filter((c) => c.observed).map((c) => ({
      provider: c.id,
      account: c.observed!.account,
      observed: c.observed!.at,
      assets: c.observed!.assets.length,
      gaps: c.observed!.gaps,
      results: c.results,
    })),
    signers: f.signers.map(({ name, role, added }) => ({ name, role, added })),
  };
}

/** The boot server's installs, live. */
export function bootPage(cards: Html, tail: string[]): Html {
  return html`
    <div class="pagehead"><div><div class="crumb">Fleet</div><h1>Installs</h1>
      <p>Each machine the boot server on this PC is installing, step by step, as boot.log records it. The page follows the log while it is open.</p></div>
      <a class="btn" href="/actions/machines?cmd=host%20add">Add a server</a></div>
    <div data-init="@get('/boot/stream')">${cards}</div>
    ${diagram(
      `flowchart LR
  power["Power on"] --> pxe["Network boot (your router)"] --> files["Boot files (TFTP, this PC)"] --> image["Ubuntu image (HTTP, this PC)"]
  image --> config["Install config + secrets"] --> install["Unattended install"] --> first["First boot: clone, apply"] --> ready["Ready: checks pass"]`,
      "Eleven steps from power-on to Ready (docs/install-timeline.md): when one stops, its card says where.",
    )}
    <div class="card" style="margin-top:14px">
      <h2>boot.log</h2>
      <div class="term" id="bootlog">${tail.map((l) => html`<div>${l}</div>`)}</div>
    </div>
  `;
}

/** The guides a PC person reads. */
export const PC_GUIDES: Array<{ name: string; title: string; why: string }> = [
  {
    name: "console",
    title: "The Stolos Console",
    why: "How it signs you in, and where passphrases go.",
  },
  { name: "daily-use", title: "Daily use", why: "The commands you run most, and when." },
  {
    name: "fleet-repository",
    title: "The fleet repository",
    why: "What each file is, and who changes it.",
  },
  { name: "hosts", title: "Hosts", why: "Describing a server in TypeScript." },
  {
    name: "adopted",
    title: "Adopted machines and clouds",
    why: "Laptops, desktops, and cloud accounts: observed, never changed.",
  },
  {
    name: "compliance",
    title: "Compliance",
    why: "SCF controls, and what they mean for HIPAA, PCI DSS, CMMC, and SOC 2.",
  },
  { name: "boot-machine", title: "The boot machine", why: "Installing a server from this PC." },
  {
    name: "install-timeline",
    title: "What happens during an install",
    why: "The eleven steps, and where to look when one fails.",
  },
  { name: "workstation", title: "Workstations", why: "A WSL distribution as a fleet workstation." },
  {
    name: "disaster-recovery",
    title: "Disaster recovery",
    why: "A lost PC, a lost key, a dead server.",
  },
  { name: "troubleshooting", title: "Troubleshooting", why: "When something says no." },
];

/** The guide list. */
export function stolosGuidePage(guides: Array<{ name: string; title: string; why: string }>): Html {
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">Learn</div>
        <h1>Guide</h1>
        <p>Plain-words guides for running the fleet from this PC. Each command they mention is also under Actions.</p>
      </div>
    </div>
    <div class="grid cols-2">${guides.map((g) =>
      html`<a class="card" href="/guide/${g.name}"><h3>${g.title}</h3><p class="sub">${g.why}</p></a>`
    )}</div>
  `;
}

/** The Actions page's note: secrets go in the terminal. */
export function terminalNote(): Html {
  return html`
    <div
      class="notice">When a command asks for a passphrase or a token, it asks in the terminal where you started the console, never here: type it there. One command runs at a time.</div>
  `;
}

/** The page shown when the launch link is missing, used, or old. */
export function launchPage(): Html {
  return html`
    <div class="card stack" style="max-width:520px;margin:12vh auto">
      <h1>Start the console from your terminal</h1>
      <p>The Stolos Console opens with a one-time link that only your terminal shows. Run, in your fleet repository:</p>
      <pre class="mono">deno task stolos console</pre>
      <p class="sub">The link works once, for two minutes, from this PC only.</p>
    </div>
  `;
}

/** Commands for the search and grouping. */
export function stolosCommandsIn(cmds: Command[], g: StolosGroup): Command[] {
  return cmds.filter((c) => stolosGroupOf(c.name).id === g.id);
}
