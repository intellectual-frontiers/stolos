/**
 * Spec 068: the Compliance tab, in both consoles: each SCF control with its
 * evidence, and each framework's requirements (HIPAA, PCI DSS, CMMC, SOC 2)
 * with what their controls say. A starter mapping, said so on the page.
 *
 * @module
 */

import type { ComplianceView, ControlStatus, Coverage } from "../compliance/report.ts";
import { type Html, html } from "./html.ts";
import { diagram } from "./layout.ts";

const pill = (s: Coverage | string) =>
  html`<span class="pill ${
    s === "pass"
      ? "ok"
      : s === "fail"
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

function controlBlock(c: ControlStatus, fw?: string): Html {
  return html`<details class="card" id="${c.control.id}" ${c.status === "fail" ? "open" : ""}>
    <summary class="row spread"><span><span class="mono nowrap">${c.control.id}</span> <b>${c.control.name}</b></span>${
    pill(c.status)
  }</summary>
    <p class="sub">${c.control.how}${
    fw ? "" : html`
      Maps to: ${Object.entries(c.control.maps).filter(([, r]) => r.length).map(([k, r]) =>
        `${k.toUpperCase()} ${r.join(", ")}`
      ).join("; ")}.
    `
  }</p>
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
      <p>What the evidence Stolos already collects (verify, the adopted machines' policies, the clouds' posture, the signatures) says about each Secure Controls Framework (SCF) control, and through SCF about HIPAA, PCI DSS, CMMC, and SOC 2.</p></div>
      ${exportHref
        ? html`<a class="btn ghost" href="${exportHref}" download>Evidence (JSON)</a>`
        : ""}</div>
    <p
      class="sub">As of ${now.toISOString().slice(0, 16).replace(
        "T",
        " ",
      )} UTC, from the last observations and verifies this console knows.</p>
    ${fw && !f
      ? html`<div class="notice bad">There is no framework "${fw}": choose one below.</div>`
      : ""}
    <div
      class="notice">A starter mapping, for orientation: check each line against the SCF's own mappings (STRM) before an auditor relies on it. Controls Stolos cannot observe (policies, training, contracts) are not here at all: they need evidence of their own.</div>
    ${tabs}
    ${diagram(
      `flowchart LR
  verify["Managed servers: archon verify"] --> scf["SCF controls (${v.controls.length})"]
  adopted["Adopted machines: policies"] --> scf
  clouds["Clouds: posture"] --> scf
  git["Repository: signatures"] --> scf
  scf --> hipaa["HIPAA"] & pci["PCI DSS"] & cmmc["CMMC"] & soc2["SOC 2"]`,
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
                      class="sub">SOC 2 Type 1 asks whether the controls are designed and in place on a date; Type 2 asks whether they worked over a period (often 6 to 12 months). The observations are commits, so <span class="mono">git log -p</span> on fleets/&lt;fleet&gt;/adopted and clouds is the period's record.</p>
                  `
                  : ""}
                </div>
        <div class="stack" style="margin-top:14px">${v.controls.filter((c) =>
          c.control.maps[f.id].length
        ).map((c) => controlBlock(c, f.id))}</div>
      `
      : html`
        <div class="card" style="margin-top:14px">
          <div class="row spread"><h2>SCF controls</h2>${count(
            v.controls.map((c) => c.status),
          )}</div>
        </div>
        <div class="stack" style="margin-top:14px">${v.controls.map((c) => controlBlock(c))}</div>
      `}
  `;
}
