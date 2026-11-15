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
import { GUIDES } from "../core/guides.ts";

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
import type { PcConnector, PcFacts, PcMachine } from "./pc.ts";

/** The Stolos Console's menu. */
export const STOLOS_NAV: NavItem[] = [
  { group: "Fleet", label: "Overview", href: "/" },
  { group: "Fleet", label: "Machines", href: "/machines" },
  { group: "Fleet", label: "Add a machine", href: "/add" },
  { group: "Fleet", label: "Connected accounts", href: "/clouds" },
  { group: "Fleet", label: "Ask every machine", href: "/query" },
  { group: "Fleet", label: "Installs", href: "/boot" },
  { group: "Fleet", label: "Changes", href: "/changes" },
  { group: "Fleet", label: "Trust", href: "/trust" },
  { group: "Fleet", label: "Compliance", href: "/compliance" },
  { group: "Fleet", label: "Activity", href: "/activity" },
  { group: "Actions", label: "The fleet", href: "/actions/fleet" },
  { group: "Actions", label: "Servers", href: "/actions/machines" },
  { group: "Actions", label: "Adopted and devices", href: "/actions/adopted" },
  { group: "Actions", label: "Connected accounts", href: "/actions/clouds" },
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
      "docs",
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
      "Machines Stolos installs and manages: add one (its model, deploy key, and an armed install), install it over the network from this PC, or turn a WSL distribution into a workstation. A change someone made by hand on a server arrives as a signed proposal: import it, look at it, accept or reject it (spec 095).",
    names: [
      "host add",
      "host bootstrap",
      "workstation add",
      "fleet trust",
      "proposal import",
      "proposal list",
      "proposal show",
      "proposal accept",
      "proposal reject",
    ],
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
    label: "Adopted machines and devices",
    intro:
      "Machines someone else installed (your laptop, a colleague's desktop): Stolos observes and checks them over SSH with a probe key that can run one read-only script, and never changes them.",
    names: [
      "compliance",
      "compliance fedramp",
      "controls list",
      "controls run",
      "evidence verify",
      "host integrate",
      "discover",
      "host adopt",
      "host observe",
      "host check",
      "host accept",
      "host release",
      "device add",
      "device observe",
      "device check",
      "device remove",
      "fleet query",
    ],
    first: "host integrate",
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
    label: "Connected accounts",
    intro:
      "What the fleet keeps in Cloudflare, Microsoft 365 and Azure, AWS, and Hetzner, read with read-only credentials. Stolos never changes a cloud.",
    names: [
      "connect",
      "estate observe",
      "estate check",
      "estate assets",
      "estate query",
      "estate diff",
      "estate build",
      "estate osquery",
      "estate schema",
      "disconnect",
      "connector list",
      "connector test",
    ],
    first: "estate check",
    diagram: (f) =>
      `flowchart LR
  vault["Vault: read-only credentials"] --> observe["estate observe"]
${
        f.clouds.map((c) =>
          `  observe --> ${c.id}["${m(c.title)}${c.connected ? "" : " (not connected)"}"]`
        ).join("\n")
      }
  observe --> git["fleets/${m(f.fleet.id)}/estate/*.ts"]`,
    caption: "Each observation is a file in Git: its history is the account's history.",
  },
  {
    id: "risks",
    label: "Risks and vendors",
    intro:
      "The risk register (risks.ts) and the vendors the fleet depends on (vendors.ts), as code in the fleet repository: discovered from SSO applications, DNS, and connected accounts, checked like any control, and changed only through a signed pull request (stolos risks review and stolos vendors triage --write, in the terminal).",
    names: ["risks list", "risks check", "vendors list"],
    first: "risks check",
    diagram: () =>
      `flowchart LR
  risks["risks.ts"] --> check["risks check: reviews, owners, accepted risks"]
  sso["SSO apps, DNS, accounts"] --> vendors["vendors list"]
  vendors -- "not in vendors.ts" --> triage["vendors triage --write: a pull request"]
  triage -- "a signer's signed merge" --> file["vendors.ts"]`,
    caption: "A review is a pull request; a fleet signer's signed merge approves it.",
  },
  {
    id: "audit",
    label: "Audits",
    intro:
      "Audit engagements (spec 083): each control in scope tested on a population drawn from the period's signed evidence bundle, samples drawn from the auditor's seed, and requests and responses as signed commits. Opening, sampling, recording, and the auditor's portal link are done in the terminal (deno task stolos audit open, audit sample, audit portal).",
    names: ["audit list", "audit show", "audit verify"],
    first: "audit list",
    diagram: () =>
      `flowchart LR
  bundle["evidence bundle (signed)"] --> pop["populations"]
  pop -- "the auditor's seed" --> sample["samples"]
  sample & req["requests, responses"] --> trail["audits/(id)/trail: signed commits"]
  trail --> portal["the portal, time-boxed"] & pkg["the export package, offline"]`,
    caption:
      "The auditor redraws every sample and verifies every item without asking for a screenshot.",
  },
  {
    id: "people",
    label: "People",
    intro:
      "Joiners and leavers, access reviews, policies, training, and screening (spec 077): the HR system against every account, and what people sign as signed commits. Writing a review or acknowledging a policy is done in the terminal (deno task stolos people review, people ack).",
    names: ["people status"],
    first: "people status",
    diagram: (f) =>
      `flowchart LR
  hr["HR system: people, managers, end dates"] --> estate[("estate graph")]
  accts["every connected account"] --> estate
  estate --> status["people status"]
  files["fleets/${m(f.fleet.id)}/people/, policies/"] --> status
  status -- "signed commits: reviews, acknowledgements" --> git["Git"]`,
    caption: "A leaver with an active account fails; a manager's signed commit approves a review.",
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
  html`<span class="pill ${
    k === "server" || k === "workstation"
      ? "ok"
      : k === "adopted" || k === "device"
      ? "tier"
      : k === "discovered"
      ? "warn"
      : "off"
  }">${k}</span>`;

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
        class="row"><a class="btn ghost" href="/export/machines.csv" download>Download CSV</a><a class="btn ghost" href="/export/evidence.json" download>Evidence (JSON)</a><a class="btn" href="/add">Add a machine</a></div>
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

function deviceBlock(f: PcFacts, name: string): Html {
  const d = f.devices.find((y) => y.device.name === name);
  if (!d) return html``;
  const o = d.observed;
  const row = (k: string, v: unknown) =>
    v === undefined || v === "" ? "" : html`
      <tr>
        <td class="sub">${k}</td>
        <td>${String(v)}</td>
      </tr>
    `;
  return html`
    <div class="grid cols-2">
      <div class="card scroll"><h2>Policies</h2>${policyTable(d.results)}</div>
      <div class="card scroll"><h2>What it said (SNMPv3)</h2>${o
        ? html`
          <table>
            <tbody>${row("Model", o.model)}${row("Description", o.description)}${row(
              "Serial",
              o.serial,
            )}${row("Firmware", o.firmware)}${row("Name", o.sysName)}${row(
              "Contact",
              o.contact,
            )}${row("Location", o.location)}${row("Up", `${o.uptimeDays} days`)}${row(
              "Interfaces",
              o.interfaces,
            )}</tbody>
          </table>
        `
        : html`<p class="sub">Never observed.</p>`}</div>
    </div>
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
        : x.kind === "device"
        ? `A device Stolos reads over encrypted SNMPv3 (read only). Observed ${ago(x.seen, now)}.`
        : x.kind === "discovered"
        ? `Discovered ${ago(x.seen, now)}: recorded, not yet adopted or managed.`
        : `Managed by Stolos: its description is fleets/${f.fleet.id}/hosts/${x.name}.ts. Installed ${
          ago(x.seen, now)
        }.`}</p></div>
      ${x.kind === "adopted"
        ? html`<a class="btn" href="/actions/adopted?cmd=host%20observe&name=${q}">Observe now</a>`
        : x.kind === "device"
        ? html`<a class="btn" href="/actions/adopted?cmd=device%20observe&name=${q}">Observe now</a>`
        : x.kind === "discovered" || x.kind === "cloud"
        ? html`<a class="btn" href="/add?name=${q}">Adopt it</a>`
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
      : x.kind === "device"
      ? deviceBlock(f, x.name)
      : x.kind === "cloud" || x.kind === "discovered"
      ? html`
        <div class="card">
          <p>If the fleet is responsible for it, adopt it: Stolos will observe and check it, and never change it.
          <a href="/add?name=${q}">Add a machine</a> gives the one line to run on it.</p>
          ${x.serial ? html`<p class="sub">Serial ${x.serial}</p>` : ""}
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

function cloudCard(c: PcConnector, now: number): Html {
  const kinds = new Map<string, number>();
  for (const a of c.observed?.assets ?? []) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  return html`<div class="card" id="${c.id}">
    <div class="row spread"><h2>${c.logo ? logo(c.logo, 20) : ""} ${c.title}</h2>${
    c.connected ? html`<span class="pill ok">connected</span>` : html`
      <a class="btn ghost"
        href="/actions/clouds?cmd=connect&provider=${c.id}">Connect (read-only)</a>
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
export function connectorsPage(f: PcFacts, now = Date.now()): Html {
  return html`
    <div class="pagehead"><div><div class="crumb">${f.fleet.title}</div><h1>Connected accounts</h1>
      <p>The fleet's outside accounts (clouds, identity, code, HR, and more), read with read-only credentials, and how each is set up. Stolos never changes them.</p></div>
      <a class="btn" href="/actions/clouds?cmd=estate%20observe">Observe every account now</a></div>
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
    <div class="card">
      <h3>For scripts: a read-only REST API</h3>
      <p>This console also answers JSON under <a href="/v1/">/v1/</a>: every estate table and view, the findings as OCSF, the OSCAL documents, and the evidence bundles. GET only, on this PC only, for this signed-in session (its cookie). Its OpenAPI 3.1 document is <a href="/v1/openapi.json">/v1/openapi.json</a>; the Console guide shows an example.</p>
    </div>
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
      "Eleven steps from power-on to Ready (the install-timeline guide): when one stops, its card says where.",
    )}
    <div class="card" style="margin-top:14px">
      <h2>boot.log</h2>
      <div class="term" id="bootlog">${tail.map((l) => html`<div>${l}</div>`)}</div>
    </div>
  `;
}

/** The guides, for the console's Guide page (one list: src/archon/core/guides.ts). */
export const PC_GUIDES: Array<{ name: string; title: string; why: string }> = GUIDES.map((
  { name, title, why },
) => ({
  name,
  title,
  why,
}));

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

/** What the "Add a machine" wizard offers, in plain words. */
export const ADD_CHOICES: Array<{ id: string; title: string; text: string }> = [
  {
    id: "adopt",
    title: "A laptop or desktop someone uses",
    text:
      "Stolos looks at it (read only) and checks it: disk encryption, firewall, updates. It never changes it.",
  },
  {
    id: "discover",
    title: "Just record a machine",
    text: "Nothing changes on it: it is listed, so the fleet knows it exists. Adopt it later.",
  },
  {
    id: "device",
    title: "A printer, router, switch, NAS, camera, or UPS",
    text: "Read over encrypted SNMPv3: model, serial, firmware, uptime.",
  },
  {
    id: "cloud",
    title: "A cloud or SaaS account",
    text: "Clouds, identity providers, code hosts, HR systems: read only, never changed.",
  },
  {
    id: "server",
    title: "A server we will manage",
    text: "Ubuntu installed by hand, made ready for Stolos to manage it.",
  },
  {
    id: "workstation",
    title: "This kind of PC as a fleet workstation",
    text: "Ubuntu, or Ubuntu in WSL on Windows: set up from the fleet repository.",
  },
];

function copyable(text: string, label: string): Html {
  return html`
    <div class="stack" style="gap:6px">
      <div class="sub">${label}</div>
      <pre class="term"
        style="height:auto;min-height:0;white-space:pre-wrap;word-break:break-all">${text}</pre>
      <div><button type="button" class="btn ghost" onclick="navigator.clipboard.writeText(this.parentElement.previousElementSibling.textContent).then(()=>{this.textContent='Copied'})">Copy</button></div>
    </div>
  `;
}

/** Step one: what is it, and its name. */
export function addPage(name = ""): Html {
  return html`
    <div class="pagehead">
      <div>
        <div class="crumb">Fleet</div>
        <h1>Add a machine</h1>
        <p>Bring a machine, a device, or a cloud account into the fleet. Choose what it is; the next page gives the one thing to do.</p>
      </div>
    </div>
    ${diagram(
      `flowchart LR
  you["1. Choose what it is"] --> cmd["2. Run one line on it (or give it to its owner)"]
  cmd --> code["3. It prints a check-in code"]
  code --> paste["4. Paste the code here"]
  paste --> fleet["It is in the fleet"]`,
      "Nothing on the machine changes until its owner reads what will change, and says yes.",
    )}
    <form class="card stack" method="get" action="/add" style="margin-top:14px">
      <fieldset class="stack"
        style="border:0;padding:0;margin:0"><legend class="sub">What are you adding?</legend>
      ${ADD_CHOICES.map((c, i) =>
        html`
          <label
            class="check"><input type="radio" name="what" value="${c.id}" ${i === 0
              ? "checked"
              : ""}> <span><b>${c.title}</b> <span class="sub">${c.text}</span></span></label>
        `
      )}</fieldset>
      <label
        class="field"><span>Its name in the fleet <span class="sub">(lowercase, digits, -: alice-laptop; not needed for a cloud account)</span></span><input type="text" name="name" value="${name}" autocomplete="off"></label>
      <label
        class="check"><input type="checkbox" name="osquery"> <span>Also allow SQL questions about it <span class="sub">(installs osquery; laptops and desktops)</span></span></label>
      <div><button class="btn" type="submit">Next</button></div>
    </form>
  `;
}

/** Step two: the line to run, and the box for the check-in code. */
export function addStep(o: {
  what: string;
  name: string;
  lines?: { posix: string; windows?: string };
  clouds: PcConnector[];
  recipes: Record<
    string,
    {
      open?: { href: string; label: string };
      shell?: { where: string; href: string; command: string };
    }
  >;
  snmpHelp: string[];
}): Html {
  const c = ADD_CHOICES.find((x) => x.id === o.what);
  const q = encodeURIComponent(o.name);
  const terminal = html`
    <div class="card" style="margin-top:14px">
      <div class="row spread"
        style="margin-bottom:8px"><h2>Output</h2><span class="sub" id="runstate">Nothing running</span></div>
      <div class="term" id="output" aria-live="polite">
        <div class="dim">After you paste the code, what happens shows here.</div>
      </div>
    </div>
  `;
  const paste = (command: string, field: string, extra: Html | string = "") =>
    html`
      <form class="card stack" id="cmdform" style="margin-top:14px"
        data-on:submit="@post('/actions/run', {contentType: 'form'})">
            <h2>2. Paste the check-in code</h2>
            <p class="sub" style="margin:0">The line ends by printing a code that starts with stolos1: (its owner can email or message it to you).</p>
            <input type="hidden" name="command" value="${command}">${extra}
            <label class="field"><span>Check-in code</span><textarea name="${field}" rows="3" autocomplete="off" spellcheck="false" placeholder="stolos1:..."></textarea></label>
            <div><button class="btn" type="submit">Add it</button></div>
          </form>
    `;
  const head = html`
    <div class="pagehead">
      <div>
        <div class="crumb"><a href="/add">Add a machine</a></div>
        <h1>${c?.title ?? "Add"}${o.name ? `: ${o.name}` : ""}</h1>
        <p>${c?.text ?? ""}</p>
      </div>
    </div>
  `;
  if (o.what === "cloud") {
    return html`${head}<div class="stack">${
      o.clouds.map((x) => {
        const r = o.recipes[x.id] ?? {};
        return html`<div class="card stack"><div class="row spread"><h2>${
          x.logo ? logo(x.logo, 20) : ""
        } ${x.title}</h2>${x.connected ? html`<span class="pill ok">connected</span>` : ""}</div>
        ${
          r.open
            ? html`<p><a href="${r.open.href}" target="_blank" rel="noopener">${r.open.label}</a></p>`
            : ""
        }
        ${
          r.shell
            ? html`
              <p class="sub"
                style="margin:0">Or, in <a href="${r.shell.href}" target="_blank" rel="noopener">${r
                  .shell.where}</a>:</p>${copyable(
                    r.shell.command,
                    "it makes a read-only identity and prints its keys",
                  )}
            `
            : ""
        }
        <div><a class="btn" href="/actions/clouds?cmd=connect&provider=${x.id}">Connect ${x.title} (read only)</a></div>
      </div>`;
      })
    }</div>`;
  }
  if (o.what === "device") {
    return html`${head}<div class="card stack"><h2>1. On the device</h2>${
      o.snmpHelp.map((l) => html`<p class="sub" style="margin:0">${l}</p>`)
    }
      <div><a class="btn" href="/actions/adopted?cmd=device%20add&name=${q}">2. Add it: its address and SNMPv3 user</a></div>
      <p class="sub">Its passphrases are typed in the terminal where the console runs, never here.</p></div>`;
  }
  if (!o.lines) {
    return html`${head}<div class="notice bad">Give it a name first: <a href="/add">back</a>.</div>`;
  }
  const where = o.what === "server"
    ? "On the server (Ubuntu), signed in as its administrator:"
    : "On the machine, in a terminal (macOS: Terminal; Linux; Windows: Ubuntu in WSL):";
  return html`
    ${head}
        <div class="card stack"><h2>1. Run this on ${o.name}</h2>
          <p class="sub" style="margin:0">Or send it to its owner. It shows what it will change and asks once; nothing changes until they say yes.</p>
          ${copyable(o.lines.posix, where)}
          ${o.lines.windows
            ? copyable(
              o.lines.windows,
              "Or on Windows, in PowerShell (right-click, Run as administrator):",
            )
            : ""}
        </div>
        ${o.what === "adopt"
          ? html`${
            paste(
              "host adopt",
              "check-in",
              html`<input type="hidden" name="name" value="${o.name}">`,
            )
          }${terminal}`
          : o.what === "discover"
          ? html`${
            paste("discover", "import", html`<input type="hidden" name="name" value="${o.name}">`)
          }${terminal}`
          : o.what === "server"
          ? html`
            <div class="card" style="margin-top:14px">
              <h2>2. Then</h2>
              <p>When it prints its code, add the server here: <a href="/actions/machines?cmd=host%20add&name=${q}">host add</a>, then <a href="/actions/machines?cmd=host%20bootstrap&name=${q}">host bootstrap</a>.</p>
            </div>
          `
          : html`
            <div class="card" style="margin-top:14px">
              <h2>2. Then</h2>
              <p>On the workstation, when it finishes: <span class="mono">deno task stolos apply</span>. It appears under Machines.</p>
            </div>
          `}
  `;
}
