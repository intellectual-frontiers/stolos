/**
 * Spec 068: the Compliance tab, in both consoles: each SCF control with its
 * evidence, and each framework's requirements (SOC 2, HIPAA, PCI DSS, CMMC,
 * NIST SP 800-53 and 800-171, FedRAMP) with what their controls say, through
 * the SCF Council's own mappings (spec 071). Without the catalog on this
 * machine, the page says so and shows the controls alone. Spec 073: each
 * control shows its evidence's age, and stale evidence carries a stale pill.
 *
 * @module
 */

import type { ComplianceView, ControlStatus, Coverage } from "../compliance/report.ts";
import { criteriaOnly } from "../compliance/catalog.ts";
import { FRAMEWORKS } from "../compliance/scf.ts";
import { controlFreshness, formatAge } from "../compliance/freshness.ts";
import { type Html, html } from "./html.ts";
import { diagram } from "./layout.ts";

const pill = (s: Coverage | string) =>
  html`<span class="pill ${
    s === "pass"
      ? "ok"
      : s === "fail" || s === "stale"
      ? "bad"
      : s === "partial" || s === "warn" || s === "accepted"
      ? "warn"
      : "off"
  }">${s}</span>`;

function count(ss: Coverage[]): Html {
  const n = (s: Coverage) => ss.filter((x) => x === s).length;
  return html`
    <div class="row"
      style="gap:6px;flex-wrap:wrap">${pill("pass")} ${n("pass")} ${pill("partial")} ${n(
        "partial",
      )} ${pill("fail")} ${n("fail")} ${pill("no evidence")} ${n("no evidence")}</div>
  `;
}

/** Spec 073: the age of a control's evidence (newest, oldest), and a stale pill. */
function ages(c: ControlStatus, now: number): Html {
  const f = controlFreshness(c, now);
  if (f.newestAgeMs === undefined) return html``;
  const span = f.newestAgeMs === f.oldestAgeMs
    ? `observed ${formatAge(f.newestAgeMs)} ago`
    : `observed ${formatAge(f.newestAgeMs)} to ${formatAge(f.oldestAgeMs!)} ago`;
  return html`<span class="sub nowrap">${span}</span> ${f.stale ? pill("stale") : ""}`;
}

function controlBlock(c: ControlStatus, now: number, fw?: string): Html {
  return html`<details class="card" id="${c.control.id}" ${c.status === "fail" ? "open" : ""}>
    <summary class="row spread"><span><span class="mono nowrap">${c.control.id}</span> <b>${c.control.name}</b></span><span class="row" style="gap:6px">${
    ages(c, now)
  } ${pill(c.status)}</span></summary>
    <p class="sub">${c.control.how}</p>
    ${c.control.description ? html`<p class="sub"><i>SCF:</i> ${c.control.description}</p>` : ""}
    ${
    fw || !c.control.description
      ? ""
      : html`<p class="sub">Maps to: ${
        FRAMEWORKS.filter((f) => c.control.maps[f.id].length).map((f) =>
          `${f.short} ${
            (f.id === "soc2" ? criteriaOnly(c.control.maps[f.id]) : c.control.maps[f.id]).join(", ")
          }`
        ).join("; ")
      }.</p>`
  }
    ${
    c.evidence.length
      ? html`
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Check</th>
                <th>Result</th>
                <th>Found</th>
                <th>Observed</th>
                <th>Fix</th>
              </tr>
            </thead>
            <tbody>${c.evidence.map((e) =>
              html`
                <tr>
                  <td><b>${e.subject}</b> <span class="sub">${e.source}</span></td>
                  <td>${e.check}</td>
                  <td>${pill(e.status)}</td>
                  <td class="sub">${e.detail}</td>
                  <td class="sub nowrap">${e.observedAt
                    ? `${formatAge(now - Date.parse(e.observedAt))} ago`
                    : "live"} ${e.stale ? pill("stale") : ""}</td>
                  <td class="sub">${e.status === "pass" ? "" : e.fix ?? ""}</td>
                </tr>
              `
            )}</tbody>
          </table>
        </div>
      `
      : html`
        <p
          class="sub">No evidence yet: nothing Stolos observes covers it here. Record how you meet it outside Stolos.</p>
      `
  }
  </details>`;
}

/** The Compliance page: `fw` is a framework id, or undefined for every SCF control. */
export function compliancePage(
  v: ComplianceView,
  fw: string | undefined,
  scope: string,
  exportHref?: string,
  now = new Date(),
): Html {
  const f = v.frameworks.find((x) => x.id === fw);
  const tabs =
    html`<nav class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:14px" aria-label="Frameworks">
    <a class="btn ${f ? "ghost" : ""}" href="/compliance">SCF controls</a>
    ${
      v.frameworks.map((x) =>
        html`<a class="btn ${
          x.id === fw ? "" : "ghost"
        }" href="/compliance?fw=${x.id}">${x.short}</a>`
      )
    }
  </nav>`;
  return html`
    <div class="pagehead"><div><div class="crumb">${scope}</div><h1>Compliance</h1>
      <p>What the evidence Stolos already collects (verify, the adopted machines' and devices' policies, the SaaS and cloud accounts' posture, the signatures) says about each Secure Controls Framework (SCF) control, and through SCF's own mappings about each framework.</p></div>
      ${exportHref
        ? html`
          <div class="row"
            style="gap:6px;flex-wrap:wrap"><a class="btn ghost" href="${exportHref}" download>Evidence (JSON)</a>${v
                .catalog
              ? [
                ["system-security-plan.json", "OSCAL SSP"],
                ["assessment-results.json", "OSCAL assessment results"],
                ["poam.json", "OSCAL POA&M"],
                ["component-definition.json", "OSCAL component"],
              ].map(([f, l]) =>
                html`<a class="btn ghost" href="/export/oscal/${f}" download>${l}</a>`
              )
              : ""}</div>
        `
        : ""}</div>
    <p
      class="sub">As of ${now.toISOString().slice(0, 16).replace(
        "T",
        " ",
      )} UTC, from the last observations and verifies this console knows. Each source is observed on a cadence (managed servers verify every 15 minutes; adopted machines, devices, and accounts daily); evidence older than its service level is stale, and fails its controls and MON-02 (Continuous Monitoring) until it is observed again.</p>
    ${fw && !f
      ? html`<div class="notice bad">There is no framework "${fw}": choose one below.</div>`
      : ""}
    ${v.catalog
      ? html`
        <div
          class="notice">Names and mappings are the SCF Council's: <a href="${v.catalog
            .url}">SCF ${v
            .catalog
            .version}</a> and its Set Theory Relationship Mappings (STRM). Controls Stolos cannot observe (policies, training, contracts) are not here: they need evidence of their own.</div>
      `
      : html`
        <div
          class="notice warn">The SCF catalog is not on this machine yet, so there are no framework mappings to show. On the PC: <span class="mono">deno task stolos compliance catalog</span> (it downloads the SCF Council's workbook and checks its SHA-256).</div>
      `}
    ${tabs}
    ${diagram(
      `flowchart LR
  verify["Managed servers: archon verify"] --> scf["SCF controls (${v.controls.length})"]
  adopted["Adopted machines and devices: policies"] --> scf
  clouds["SaaS and clouds: posture"] --> scf
  git["Repository: signatures"] --> scf
  scf -- "SCF STRM" --> soc2["SOC 2"] & hipaa["HIPAA"] & pci["PCI DSS"] & cmmc["CMMC"] & nist["NIST 800-53, 800-171"] & fedramp["FedRAMP"]`,
      "Evidence flows one way: from what machines and accounts show, through SCF, to each framework's requirements.",
    )}
    ${f
      ? html`
        <div class="card"
          style="margin-top:14px"><div class="row spread"><h2>${f.title}</h2>${count(
            f.requirements.map((r) => r.status),
          )}</div>
                <div class="scroll"><table><thead><tr><th>Requirement</th><th>Status</th><th>SCF controls</th></tr></thead><tbody>${f
                  .requirements.map((r) =>
                    html`
                      <tr>
                        <td class="mono nowrap">${r.id}</td>
                        <td>${pill(r.status)}</td>
                        <td>${r.controls.map((c) => {
                          const cs = v.controls.find((x) => x.control.id === c)!;
                          return html`
                            <a href="#${c}" class="nowrap">${c}</a> <span class="sub">${cs.control
                              .name}</span>
                          `;
                        })}</td>
                      </tr>
                    `
                  )}</tbody></table></div>
                ${f.id === "soc2"
                  ? html`
                    <p
                      class="sub">SOC 2 Type 1 asks whether the controls are designed and in place on a date; Type 2 asks whether they worked over a period (often 6 to 12 months). The observations are commits, so <span class="mono">git log -p</span> on fleets/&lt;fleet&gt;/adopted and estate is the period's record.</p>
                  `
                  : ""}
                </div>
        <div class="stack" style="margin-top:14px">${v.controls.filter((c) =>
          c.control.maps[f.id].length
        ).map((c) => controlBlock(c, now.getTime(), f.id))}</div>
      `
      : html`
        <div class="card" style="margin-top:14px">
          <div class="row spread"><h2>SCF controls</h2>${count(
            v.controls.map((c) => c.status),
          )}</div>
        </div>
        <div class="stack" style="margin-top:14px">${v.controls.map((c) =>
          controlBlock(c, now.getTime())
        )}</div>
      `}
  `;
}
