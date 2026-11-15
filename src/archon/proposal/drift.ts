/**
 * Spec 095-proposals: drift is what the host has, minus the plan, minus the
 * birth snapshot (what Ubuntu itself put on the host at install), so Ubuntu's
 * own changes (unattended upgrades, a package's own presets) are never drift
 * (Article 2). Each item carries who changed it and when (from the
 * observations), and the model change that would adopt it.
 *
 * ```mermaid
 * flowchart LR
 *   state["what the host has<br/>(packages, units, /etc, ports, accounts, files)"] --> minus1["minus the plan"]
 *   minus1 --> minus2["minus the birth snapshot"]
 *   minus2 --> items["drift items"]
 *   obs["observations<br/>(sudo, apt, etckeeper, osquery, ...)"] -->|who, when| items
 *   items --> edits["the edit that adopts each:<br/>packages.add, units.enable, ports.open, files.override"]
 * ```
 *
 * @module
 */

import { commandTargets, type UnitFileState, unitOn } from "./parse.ts";
import {
  type Alert,
  type DriftItem,
  type Edit,
  editText,
  type Observation,
  type ProposalDecisions,
  type SubjectKind,
} from "./types.ts";

/** What the plan says, reduced to what drift is compared with. */
export interface PlanView {
  /** apt packages. */
  packages: string[];
  /** Snaps. */
  snaps: string[];
  /** Units the plan sets, with the state it wants and the spec that sets it. */
  units: Record<string, { state: string; spec: string }>;
  /** Files the plan writes, with the spec that writes them. */
  files: Record<string, { spec: string }>;
  /** Ports it opens ("tcp/443"). */
  ports: string[];
  /** Accounts it makes. */
  users: string[];
  /** Paths under /usr/local and /opt that Archon itself puts there (its tools, its command). */
  ownPaths: string[];
}

/** What Ubuntu (and the first apply) put on the host at install: never drift. */
export interface Birth {
  /** When it was taken (ISO). */
  at: string;
  /** Taken after install, on a host installed before spec 095 (a person's earlier changes may count as Ubuntu's). */
  late?: boolean;
  /** `apt-mark showmanual`. */
  manualPackages: string[];
  /** Snaps. */
  snaps: string[];
  /** Unit files and their states. */
  units: Record<string, string>;
  /** Accounts with a login (UID 1000 and up). */
  users: string[];
  /** Listening ports ("tcp/22"). */
  listening: string[];
  /** /etc at the first etckeeper commit. */
  etcCommit: string;
}

/** A file under /etc that changed since birth by someone other than Ubuntu (and is not a package's unchanged file). */
export interface EtcChange {
  /** Its path. */
  path: string;
  /** added, edited, or deleted. */
  change: "added" | "edited" | "deleted";
}

/** What the host has now (the latest collection). */
export interface HostState {
  /** When it was read (ISO). */
  at: string;
  /** `apt-mark showmanual`. */
  manualPackages: string[];
  /** Snaps. */
  snaps: string[];
  /** Unit files: state and vendor preset. */
  units: Record<string, UnitFileState>;
  /** Listening ports ("tcp/443"), not loopback. */
  listening: string[];
  /** Accounts with a login. */
  users: string[];
  /** /etc files changed by a person since birth. */
  etc: EtcChange[];
  /** Files the plan writes whose content differs from the plan now. */
  managedFiles: string[];
  /** Files under /usr/local and /opt that no package owns. */
  unowned: string[];
  /** Containers (podman), by name. */
  containers: string[];
  /** Collectors that failed, with why. */
  failed?: Record<string, string>;
}

/** A proposal this host sent, as it keeps it (archon.sql, kind proposal). */
export interface SentProposal {
  /** Its id. */
  id: string;
  /** When (ISO). */
  at: string;
  /** Who proposed it. */
  by: string;
  /** Why. */
  reason: string;
  /** Its items and the action chosen for each. */
  items: Array<{ key: string; action: string; until?: string }>;
  /** Whether the message was queued. */
  sent: string;
}

/** A managed item held from the reconcile timer (archon.sql, kind hold). */
export interface Hold {
  /** The item's key. */
  key: string;
  /** Who changed it. */
  by: string;
  /** When the hold began (ISO). */
  since: string;
  /** When it ends at the latest (ISO): since + 7 days. */
  until: string;
  /** The sudo command that changed it. */
  command: string;
  /** The proposal it is in, once proposed. */
  proposal?: string;
}

/** Everything drift is computed from. */
export interface DriftInput {
  /** The plan. */
  plan: PlanView;
  /** The birth snapshot. */
  birth: Birth;
  /** The host now. */
  state: HostState;
  /** Observations (evidence of who and when). */
  observations: Observation[];
  /** Proposals sent from here. */
  proposals?: SentProposal[];
  /** Decisions in Git about this host's proposals. */
  decisions?: ProposalDecisions;
  /** Holds. */
  holds?: Hold[];
  /** Now (tests fix it). */
  now?: Date;
}

const MANUAL = {
  removedPackage:
    "the model cannot say a package is absent, and Archon never removes one (Article 11): keep it local, or put it back (revert: sudo apt install it)",
  user:
    "accounts carry personas and groups: add the person to the fleet's people or the host's users by hand",
  sudoer: "sudo rules are rendered from personas (spec 006): change the persona in the model",
  module: "a kernel module: load it from a capability's modules-load.d file, by hand",
  container: "containers are opt-ins or guests in the model: add one by hand, or remove this one",
  unowned:
    "nothing installs files outside packages and verified releases (Article 5): model it as a tool, or remove it",
  deleted: "a deleted file cannot be modeled: keep it local, or let Ubuntu's package put it back",
};

/** The flag for files no package owns. */
export const UNOWNED_FLAG =
  "Article 5: no package owns this file (built from source, or copied in by hand)";

/** Whether an observation is about this item (directly, or a sudo command that names it). */
export function explains(o: Observation, kind: SubjectKind, name: string): boolean {
  if (o.kind === kind && o.name === name) return true;
  if (o.kind === "package" && kind === "snap") return false;
  if (o.source !== "sudo") return false;
  return commandTargets(o.name).some((t) =>
    (t.kind === kind || (kind === "unowned" && t.kind === "file")) &&
    (t.name === name || t.name === "*" ||
      (kind === "unit" && t.name.replace(/\.service$/, "") === name.replace(/\.service$/, "")))
  );
}

/** Compute the drift items: the host minus the plan minus the birth snapshot, with who, when, and the adopting edit. */
export function computeDrift(input: DriftInput): DriftItem[] {
  const { plan, birth, state } = input;
  const now = input.now ?? new Date();
  const items: DriftItem[] = [];
  const push = (
    kind: SubjectKind,
    name: string,
    change: string,
    edits: Edit[],
    extra: Partial<DriftItem> = {},
  ) =>
    items.push({
      key: `${kind}:${name}`,
      kind,
      name,
      change,
      managed: false,
      at: state.at,
      evidence: [],
      edits,
      ...extra,
    });
  const inPlan = new Set(plan.packages);
  const born = new Set(birth.manualPackages);
  const have = new Set(state.manualPackages);
  for (const p of state.manualPackages) {
    if (!inPlan.has(p) && !born.has(p)) {
      push("package", p, "installed", [{ op: "packages.add", name: p }]);
    }
  }
  for (const p of birth.manualPackages) {
    if (!inPlan.has(p) && !have.has(p)) {
      push("package", p, "removed", [], { manual: MANUAL.removedPackage });
    }
  }
  const snapsPlan = new Set(plan.snaps), snapsBorn = new Set(birth.snaps);
  for (const s of state.snaps) {
    if (!snapsPlan.has(s) && !snapsBorn.has(s)) {
      push("snap", s, "installed", [{ op: "packages.add", name: s, source: "snap" }]);
    }
  }
  for (const [u, cur] of Object.entries(state.units)) {
    const want = plan.units[u];
    const unitEdit = (st: string): Edit[] =>
      st === "masked"
        ? [{ op: "units.mask", unit: u }]
        : unitOn(st)
        ? [{ op: "units.enable", unit: u }]
        : [{ op: "units.disable", unit: u }];
    const label = (st: string) => st === "masked" ? "masked" : unitOn(st) ? "enabled" : "disabled";
    if (want && want.state !== "ignore") {
      const ok = want.state === "masked"
        ? cur.state === "masked"
        : want.state === "enabled"
        ? unitOn(cur.state) || cur.state === "static"
        : !unitOn(cur.state);
      if (!ok) {
        push("unit", u, label(cur.state), unitEdit(cur.state), { managed: true, spec: want.spec });
      }
      continue;
    }
    if (want) continue;
    const before = birth.units[u];
    if (cur.state === "static" || cur.state === "generated" || cur.state === "transient") continue;
    if (before === undefined) {
      // New since birth (a package brought it): drift only when it differs from the package's preset.
      const preset = cur.preset === "enabled" ? "enabled" : "disabled";
      if (cur.preset && label(cur.state) !== preset) {
        push("unit", u, label(cur.state), unitEdit(cur.state));
      }
    } else if (label(before) !== label(cur.state)) {
      push("unit", u, label(cur.state), unitEdit(cur.state));
    }
  }
  const managedChanged = new Set(state.managedFiles);
  for (const f of state.managedFiles) {
    push("file", f, "edited", [], { managed: true, spec: plan.files[f]?.spec });
  }
  for (const e of state.etc) {
    if (plan.files[e.path]) continue; // managed: only when its content differs (above)
    if (managedChanged.has(e.path)) continue;
    push("file", e.path, e.change, [], e.change === "deleted" ? { manual: MANUAL.deleted } : {});
  }
  const portsPlan = new Set(plan.ports), portsBorn = new Set(birth.listening);
  for (const p of state.listening) {
    if (portsPlan.has(p) || portsBorn.has(p)) continue;
    const [protocol, port] = p.split("/");
    push("port", p, "listening", [{
      op: "ports.open",
      port: Number(port),
      protocol: protocol === "udp" ? "udp" : "tcp",
    }]);
  }
  const usersPlan = new Set(plan.users), usersBorn = new Set(birth.users);
  for (const u of state.users) {
    if (!usersPlan.has(u) && !usersBorn.has(u)) {
      push("user", u, "added", [], { manual: MANUAL.user });
    }
  }
  // Sudo rules and kernel modules: only osquery saw them (added and not removed since).
  for (const kind of ["sudoer", "module"] as const) {
    const last = new Map<string, Observation>();
    for (
      const o of input.observations.filter((x) => x.kind === kind).sort((a, b) =>
        a.at.localeCompare(b.at)
      )
    ) {
      last.set(o.name, o);
    }
    for (const [name, o] of last) {
      if (o.change === "added" || o.change === "loaded") {
        push(kind, name, o.change, [], { manual: MANUAL[kind], at: o.at });
      }
    }
  }
  const own = plan.ownPaths;
  for (const f of state.unowned) {
    if (own.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : `${p}/`))) continue;
    push("unowned", f, "added", [], { flag: UNOWNED_FLAG, manual: MANUAL.unowned });
  }
  for (const c of state.containers) push("container", c, "added", [], { manual: MANUAL.container });

  // Who and when, from the evidence.
  const obs = [...input.observations].sort((a, b) => a.at.localeCompare(b.at));
  for (const it of items) {
    const ev = obs.filter((o) => explains(o, it.kind, it.name));
    it.evidence = ev.map((o) => o.id);
    const who = ev.find((o) => o.who && o.source !== "sudo")?.who ?? ev.find((o) => o.who)?.who;
    if (who) it.who = who;
    if (ev.length) it.at = ev[0].at;
  }
  // What people already said about each item.
  const day = now.toISOString().slice(0, 10);
  for (const p of input.proposals ?? []) {
    const d = input.decisions?.[p.id];
    for (const pi of p.items) {
      const it = items.find((x) => x.key === pi.key);
      if (!it) continue;
      if (d?.decision === "rejected") {
        it.rejected = true;
        continue;
      }
      if (d?.decision === "accepted" && d.skipped?.includes(pi.key)) continue;
      it.proposal = p.id;
      const local = d?.local?.find((l) => l.key === pi.key)?.until ??
        (pi.action === "local" ? pi.until : undefined);
      if (local && local >= day) it.localUntil = local;
    }
  }
  for (const h of input.holds ?? []) {
    const it = items.find((x) => x.key === h.key);
    if (it && h.until > now.toISOString()) it.heldUntil = h.until;
  }
  return items.sort((a, b) => a.key.localeCompare(b.key));
}

/** Items no one has proposed, accepted as local, or seen rejected: what `archon drift` lists by default. */
export function unproposed(items: DriftItem[]): DriftItem[] {
  return items.filter((i) => !i.proposal && !i.localUntil && !i.rejected);
}

/** `archon drift` as text: each item with who, when, and the edit that would adopt it; alerts first. */
export function driftText(
  host: string,
  items: DriftItem[],
  alerts: Alert[],
  opts: { all?: boolean; birthLate?: boolean; collected?: string } = {},
): string {
  const shown = opts.all ? items : unproposed(items);
  const out: string[] = [];
  if (alerts.length) {
    out.push(
      `SECURITY ALERT: ${alerts.length} package file(s) modified on ${host} (never a proposal):`,
    );
    for (const a of alerts) out.push(`  ${a.path}${a.package ? ` (${a.package})` : ""}`);
    out.push("  Investigate now: dpkg --verify; reinstall the package from Ubuntu's archive.", "");
  }
  out.push(
    shown.length
      ? `${shown.length} change(s) on ${host} made outside Stolos${
        opts.all ? "" : ", not proposed yet"
      }:`
      : `no drift on ${host}${opts.all ? "" : " that is not proposed yet"}.`,
  );
  for (const i of shown) {
    const tags = [
      i.managed ? `managed by ${i.spec ?? "the plan"}` : "",
      i.heldUntil ? `held until ${i.heldUntil.slice(0, 16).replace("T", " ")}` : "",
      i.proposal ? `in proposal ${i.proposal}` : "",
      i.localUntil ? `local until ${i.localUntil}` : "",
      i.rejected ? "rejected: stays flagged" : "",
      i.flag ?? "",
    ].filter(Boolean);
    out.push(
      `  ${i.key}  ${i.change}${i.who ? ` by ${i.who}` : ""} ${
        i.at.slice(0, 16).replace("T", " ")
      }${tags.length ? `  [${tags.join("; ")}]` : ""}`,
    );
    if (i.edits.length) out.push(`      adopt: ${i.edits.map(editText).join(", ")}`);
    else if (i.kind === "file" && !i.manual) {
      out.push("      adopt: files.override (content read at propose)");
    }
    if (i.manual) out.push(`      by hand: ${i.manual}`);
  }
  if (opts.birthLate) {
    out.push(
      "",
      "note: the birth snapshot was taken after install (a host installed before spec 095); changes made before it count as Ubuntu's.",
    );
  }
  if (opts.collected) {
    out.push("", `collected ${opts.collected.slice(0, 16).replace("T", " ")} UTC`);
  }
  if (shown.length) {
    out.push(
      "",
      'Propose them: sudo archon propose --all --reason "..." (or --item <key>, --intent <id>)',
    );
  }
  return out.join("\n");
}
