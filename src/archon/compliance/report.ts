/**
 * Spec 068: compliance as evidence. Every result Stolos already has (a
 * managed server's verify, an adopted machine's policies, a cloud account's
 * posture, the repository's signatures) is evidence for one or more SCF
 * controls; each control's status is what its evidence says, and each
 * framework requirement's status is what its controls say. Nothing here is
 * asserted without evidence: a control with none says so.
 *
 * @module
 */

import type { PolicyResult } from "../adopt/policy.ts";
import type { PcFacts } from "../console/pc.ts";
import { type FrameworkId, FRAMEWORKS, SCF, type ScfControl } from "./scf.ts";

/** One piece of evidence. */
export interface Evidence {
  /** The SCF controls it supports. */
  scf: string[];
  /** What it is about: a machine, a cloud account, the repository. */
  subject: string;
  /** Where it came from. */
  source: "managed" | "adopted" | "device" | "cloud" | "estate" | "repository";
  /** The check, in words. */
  check: string;
  /** Its result. */
  status: PolicyResult["status"];
  /** What was found. */
  detail: string;
  /** How to make it pass. */
  fix?: string;
}

/** A status for a control or a requirement. */
export type Coverage = "pass" | "fail" | "partial" | "no evidence";

/** One control, with its evidence. */
export interface ControlStatus {
  /** The control. */
  control: ScfControl;
  /** Its status. */
  status: Coverage;
  /** Its evidence. */
  evidence: Evidence[];
}

/** One framework requirement, with the controls that map to it. */
export interface RequirementStatus {
  /** The requirement (for example 164.312(a)(2)(iv)). */
  id: string;
  /** Its status. */
  status: Coverage;
  /** The SCF controls mapped to it. */
  controls: string[];
}

/** What a set of statuses adds up to. */
export function combine(ss: Array<PolicyResult["status"] | Coverage>): Coverage {
  const real = ss.filter((s) => s !== "no evidence");
  if (!real.length) return "no evidence";
  if (real.some((s) => s === "fail")) return "fail";
  if (real.every((s) => s === "pass")) return "pass";
  // A warning, an unknown, or an accepted risk: in place, but not fully.
  return "partial";
}

/** Each control's status from the evidence. */
export function controls(evidence: Evidence[]): ControlStatus[] {
  return SCF.map((control) => {
    const ev = evidence.filter((e) => e.scf.includes(control.id));
    return { control, evidence: ev, status: combine(ev.map((e) => e.status)) };
  });
}

/** A framework's requirements, each with its status (from its controls). */
export function framework(id: FrameworkId, cs: ControlStatus[]): RequirementStatus[] {
  const reqs = new Map<string, string[]>();
  for (const c of cs) {
    for (const r of c.control.maps[id]) reqs.set(r, [...(reqs.get(r) ?? []), c.control.id]);
  }
  return [...reqs].map(([rid, ids]) => ({
    id: rid,
    controls: ids,
    // A requirement is met only as far as all its controls have evidence.
    status:
      ((ss) =>
        ss.every((x) => x === "no evidence")
          ? "no evidence"
          : combine(ss.map((x) => x === "no evidence" ? "partial" : x)))(
          ids.map((x) => cs.find((c) => c.control.id === x)!.status),
        ),
  })).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** The fleet's evidence, from what the Stolos Console gathers. */
export function fleetEvidence(f: PcFacts, now = Date.now()): Evidence[] {
  const out: Evidence[] = [];
  const recent = (iso?: string) => !!iso && now - Date.parse(iso) <= 7 * 86_400_000;
  for (const m of f.machines.filter((x) => x.kind === "server" || x.kind === "workstation")) {
    out.push({
      scf: ["CFG-02"],
      subject: m.name,
      source: "managed",
      check: "Matches its model (archon verify)",
      status: !m.score
        ? "unknown"
        : m.failing.length || m.score.pass < m.score.total
        ? "fail"
        : "pass",
      detail: m.score
        ? `${m.score.pass} of ${m.score.total} checks${
          m.failing.length ? `; failing: ${m.failing.join(", ")}` : ""
        }`
        : "not verified yet",
      fix:
        "deno task stolos fleet status, then the failing check's fix on the server (Archon Console)",
    });
    out.push({
      scf: ["CRY-05"],
      subject: m.name,
      source: "managed",
      check: "The disk is encrypted",
      status: "unknown",
      detail: "Archon does not check disk encryption on managed servers yet",
      fix:
        "record how this server's data at rest is protected (full-disk encryption at install, or an encrypted volume for its data)",
    });
    out.push({
      scf: ["AST-02", "MON-01"],
      subject: m.name,
      source: "managed",
      check: "Installed and recorded in the last 7 days",
      status: recent(m.seen) ? "pass" : m.seen ? "warn" : "unknown",
      detail: m.seen ? `last recorded ${m.seen.slice(0, 10)}` : "no record on this PC",
      fix: "deno task stolos fleet status",
    });
  }
  for (const a of f.adopted) {
    for (const r of a.results) {
      out.push({
        scf: r.scf,
        subject: a.machine.name,
        source: "adopted",
        check: r.title,
        status: r.status,
        detail: r.detail,
        ...(r.fix ? { fix: r.fix } : {}),
      });
    }
  }
  for (const r of f.estate ?? []) {
    out.push({
      scf: r.scf,
      subject: "across systems",
      source: "estate",
      check: r.title,
      status: r.status,
      detail: r.detail,
      ...(r.fix ? { fix: r.fix } : {}),
    });
  }
  for (const d of f.devices ?? []) {
    for (const r of d.results) {
      out.push({
        scf: r.scf,
        subject: d.device.name,
        source: "device",
        check: r.title,
        status: r.status,
        detail: r.detail,
        ...(r.fix ? { fix: r.fix } : {}),
      });
    }
  }
  for (const c of f.clouds.filter((x) => x.observed)) {
    for (const r of c.results) {
      out.push({
        scf: r.scf,
        subject: `${c.title} (${c.observed!.account})`,
        source: "cloud",
        check: r.title,
        status: r.status,
        detail: r.detail,
        ...(r.fix ? { fix: r.fix } : {}),
      });
    }
  }
  out.push({
    scf: ["CHG-02"],
    subject: f.fleet.repo,
    source: "repository",
    check: "Every commit servers apply is signed by a fleet signer",
    status: f.git.unapproved.length ? "fail" : "pass",
    detail: f.git.unapproved.length
      ? `${f.git.unapproved.length} commit(s) waiting for approval`
      : "the newest commit is approved",
    fix: "deno task stolos apply (approves with one signed commit)",
  });
  const daily = f.signers.filter((s) => s.role === "daily").length;
  const recovery = f.signers.filter((s) => s.role === "recovery").length;
  out.push({
    scf: ["IAC-10"],
    subject: f.fleet.repo,
    source: "repository",
    check: "Signing keys: one per person, and an offline recovery key",
    status: daily && recovery ? "pass" : daily ? "warn" : "fail",
    detail: `${daily} daily, ${recovery} recovery signer(s)`,
    fix: "deno task stolos keys setup (in the terminal)",
  });
  out.push({
    scf: ["AST-02"],
    subject: f.fleet.repo,
    source: "repository",
    check: "The asset inventory is in Git",
    status: f.machines.length ? "pass" : "unknown",
    detail: `${f.machines.length} machine(s): ${
      f.machines.filter((m) => m.kind === "server").length
    } server(s), ${f.adopted.length} adopted, ${
      f.machines.filter((m) => m.kind === "cloud").length
    } seen in a cloud`,
  });
  return out;
}

/** One server's evidence, for its Archon Console: what it can show about itself. */
export function serverEvidence(o: {
  host: string;
  verify?: { passed: number; total: number; failed: string[]; at?: string };
  signer?: string;
  commit?: string;
  https: boolean;
}, now = Date.now()): Evidence[] {
  const v = o.verify;
  return [
    {
      scf: ["CFG-02", "MON-01"],
      subject: o.host,
      source: "managed",
      check: "Matches its model (archon verify)",
      status: !v ? "unknown" : v.failed.length ? "fail" : "pass",
      detail: v
        ? `${v.passed} of ${v.total} checks${
          v.failed.length ? `; failing: ${v.failed.join(", ")}` : ""
        }`
        : "not verified yet",
      fix: "Actions, This server: verify",
    },
    {
      scf: ["MON-01"],
      subject: o.host,
      source: "managed",
      check: "Verified in the last day",
      status: v?.at && now - Date.parse(v.at) <= 86_400_000 ? "pass" : "warn",
      detail: v?.at ? `last verified ${v.at.slice(0, 16).replace("T", " ")}` : "never",
      fix: "the reconcile timer verifies every 15 minutes: is archon-reconcile.timer active?",
    },
    {
      scf: ["CHG-02"],
      subject: o.host,
      source: "repository",
      check: "The applied commit is signed by a fleet signer",
      status: o.signer ? "pass" : "fail",
      detail: o.signer
        ? `${o.commit ?? "HEAD"} signed by ${o.signer}`
        : "no signer's signature on the applied commit",
      fix: "on the PC: deno task stolos apply",
    },
    {
      scf: ["CRY-03"],
      subject: o.host,
      source: "managed",
      check: "Its web pages are served over HTTPS only",
      status: o.https ? "pass" : "unknown",
      detail: o.https ? "Traefik redirects HTTP to HTTPS" : "no web service",
    },
    {
      scf: ["AST-02"],
      subject: o.host,
      source: "repository",
      check: "Described in the fleet repository",
      status: "pass",
      detail: `hosts/${o.host}`,
    },
  ];
}

/** Everything a framework page shows. */
export interface ComplianceView {
  /** Every control, with its evidence. */
  controls: ControlStatus[];
  /** Each framework's requirements. */
  frameworks: Array<
    { id: FrameworkId; title: string; short: string; requirements: RequirementStatus[] }
  >;
}

/** The whole view from evidence. */
export function complianceView(evidence: Evidence[]): ComplianceView {
  const cs = controls(evidence);
  return {
    controls: cs,
    frameworks: FRAMEWORKS.map((f) => ({ ...f, requirements: framework(f.id, cs) })),
  };
}
