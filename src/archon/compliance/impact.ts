/**
 * Spec 074: compliance impact at the point of change. Given the fleet at a
 * base commit and at a head commit (or the working tree), which SCF controls
 * the change weakens or strengthens, with the framework requirements the SCF
 * Council maps each to. `stolos apply` shows it before it commits;
 * `stolos compliance impact` prints it (`--json`, `--markdown`); a fleet
 * repository's pull requests get it as one comment (`workflow.ts`).
 *
 * Two kinds of change are found:
 *
 * 1. **Model changes**: {@link IMPLEMENTATIONS} is Stolos's own statement of
 *    which SCF control each model setting implements and which direction
 *    weakens it (unattended upgrades off: VPM-08; SSH passwords accepted from
 *    more networks: IAC-14; a port opened: NET-02; a host out of backups:
 *    BCD-24). Each side's model is loaded and each host's plan resolved, then
 *    reduced to {@link FleetFacts}, which the declarations compare.
 * 2. **Evidence changes**: the observations Git records (adopted machines,
 *    devices, connected accounts) and the fleet's control packs, each side
 *    read as `compliance drift` reads them (`drift.ts`), compared per control.
 *
 * ```mermaid
 * flowchart LR
 *   base["base commit"] --> fb["model: facts"] & eb["observations and packs: evidence"]
 *   head["head commit, or the working tree"] --> fh["model: facts"] & eh["observations and packs: evidence"]
 *   fb & fh -- "IMPLEMENTATIONS (Stolos's declarations)" --> mc["weakens / strengthens, per control"]
 *   eb & eh -- "compareViews (drift.ts)" --> ec["status changes, per control"]
 *   mc & ec --> ctl["affected SCF controls"]
 *   ctl -- "SCF STRM (catalog, when cached)" --> fw["framework requirements"]
 *   mc --> gate{"compliance.gate (base's fleet.ts)"}
 *   gate -- "allow, accepted risk, approval" --> ok["allowed"]
 *   gate -- "none" --> block["blocked"]
 * ```
 *
 * The gate (`compliance.gate` in `fleet.ts`, {@link ComplianceGate}) is read
 * from the base side, so a change cannot turn off the gate that judges it.
 * With `block: "weakens"`, a weakening is allowed only when the gate's
 * `allow` names it, when `fleets/<fleet>/controls/accepted.ts` accepts it
 * (`policy: "impact/<key>"`, until a date), or when it is approved: a commit
 * in the change carries the trailer `Compliance-Approved: <keys>` and a good
 * signature by one of the base's signers (`signers.ts`). `stolos apply
 * --approve <keys>` writes that trailer into the commit it signs.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { run } from "../core/exec.ts";
import type { Acceptance } from "../adopt/adopt.ts";
import type { FleetDef, HostDef, HostPlan, McpTier, SignerDef } from "../model/types.ts";
import type { ScfCatalog } from "./catalog.ts";
import type { ControlChange } from "./drift.ts";
import { type FrameworkId, FRAMEWORKS, scf, type ScfId } from "./scf.ts";
import { IMPACT_AFFECTED_MARKER } from "./workflow.ts";

// ------------------------------------------------------------------ facts

/** What one host's resolved plan says about the settings that implement controls. */
export interface HostFacts {
  /** Server or workstation. */
  kind: "server" | "workstation";
  /** Unattended upgrades: the package, and apt-daily-upgrade.timer enabled (spec 009). */
  updates: boolean;
  /**
   * Where sshd accepts passwords (spec 007): the networks of its Match block,
   * "anywhere" when it accepts them outside one, [] for keys only;
   * undefined when Stolos does not configure sshd on the host.
   */
  sshPasswords?: string[];
  /** ufw installed and enabled (spec 008). */
  firewall: boolean;
  /** The ports open in the host's firewall, as "22/tcp". */
  ports: string[];
  /** The daily backup timer (spec 016). */
  backup: boolean;
  /** What the backup holds: paths, and "guest <name>" for each durable guest (spec 044). */
  backupScope: string[];
  /** How many archives are kept. */
  backupKeep?: number;
  /** osquery, for fleet-wide questions (spec 042). */
  osquery: boolean;
  /** /etc kept in Git by etckeeper (spec 033). */
  etckeeper: boolean;
  /** The accounts with administrator rights. */
  admins: string[];
}

/** A cadence, as the facts keep it. */
export interface CadenceFact {
  /** How often ("15m", "1d"). */
  every: string;
  /** Its service level. */
  staleAfter: string;
  /** `every` in milliseconds. */
  everyMs: number;
  /** `staleAfter` in milliseconds. */
  staleAfterMs: number;
}

/** What a fleet's model says about the settings that implement controls. */
export interface FleetFacts {
  /** The fleet's id. */
  fleet: string;
  /** Each host's facts, by name. */
  hosts: Record<string, HostFacts>;
  /** The tier agents get over MCP (spec 030). */
  agentTier: McpTier;
  /** The evidence cadences (spec 073): each source, and each connector the fleet sets. */
  cadence: Record<string, CadenceFact>;
  /** The gate this side sets (spec 074). */
  gate?: ComplianceGate;
  /** Hosts whose plan could not be resolved, with why. */
  problems: string[];
}

const SSHD_DROP_IN = "/etc/ssh/sshd_config.d/50-archon.conf";

/** Where sshd accepts passwords, from the drop-in Stolos renders (see {@link HostFacts.sshPasswords}). */
export function sshPasswordNetworks(conf: string): string[] {
  const out = new Set<string>();
  let match: string[] | undefined;
  for (const raw of conf.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^Match\s+Address\s+(\S+)/i);
    if (m) {
      match = m[1].split(",").filter(Boolean);
      continue;
    }
    if (/^Match\s/i.test(line)) {
      match = [];
      continue;
    }
    if (/^PasswordAuthentication\s+yes\b/i.test(line)) {
      for (const n of match ?? ["anywhere"]) out.add(n);
    }
  }
  return [...out].sort();
}

/** The facts of one host's plan. */
export async function hostFacts(plan: HostPlan): Promise<HostFacts> {
  const { backupPolicy } = await import("../capabilities/backup.ts");
  const { durableGuests } = await import("../model/durable.ts");
  const unit = (name: string) => plan.units.find((u) => u.unitName === name);
  const pkg = (name: string) => plan.packages.some((p) => p.name === name);
  const sshd = plan.files.find((f) => f.path === SSHD_DROP_IN);
  const backup = !!unit("archon-backup.timer") && unit("archon-backup.timer")!.state !== "masked";
  const policy = backup ? backupPolicy(plan.host) : undefined;
  return {
    kind: plan.host.kind ?? "server",
    updates: pkg("unattended-upgrades") && unit("apt-daily-upgrade.timer")?.state === "enabled",
    ...(sshd && typeof sshd.content === "string"
      ? { sshPasswords: sshPasswordNetworks(sshd.content) }
      : {}),
    firewall: pkg("ufw") && unit("ufw.service")?.state === "enabled",
    ports: [...new Set(plan.ports.map((p) => `${p.port}/${p.protocol}`))].sort((a, b) =>
      parseInt(a) - parseInt(b) || a.localeCompare(b)
    ),
    backup,
    backupScope: policy
      ? [...policy.paths, ...durableGuests(plan.host).map((g) => `guest ${g}`)]
      : [],
    ...(policy ? { backupKeep: policy.keep } : {}),
    osquery: plan.specsUsed.includes("042-sql"),
    etckeeper: plan.specsUsed.includes("033-etckeeper"),
    admins: plan.users.filter((u) => u.admin).map((u) => u.name).sort(),
  };
}

/** The facts of a fleet and its hosts (each host's plan resolved; one that fails is a problem). */
export async function fleetFacts(fleet: FleetDef, hosts: HostDef[]): Promise<FleetFacts> {
  const { resolvePlan } = await import("../model/resolve.ts");
  const { mcpTier } = await import("../model/load.ts");
  const { resolveCadences } = await import("./freshness.ts");
  const out: FleetFacts = {
    fleet: fleet.id,
    hosts: {},
    agentTier: mcpTier(fleet),
    cadence: {},
    ...(fleet.compliance?.gate ? { gate: fleet.compliance.gate } : {}),
    problems: [],
  };
  for (const h of hosts) {
    try {
      out.hosts[h.name] = await hostFacts(resolvePlan(h, fleet));
    } catch (e) {
      out.problems.push(`${h.name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  try {
    const c = resolveCadences({ fleet: fleet.compliance?.cadence });
    const keep = (x: CadenceFact): CadenceFact => ({
      every: x.every,
      staleAfter: x.staleAfter,
      everyMs: x.everyMs,
      staleAfterMs: x.staleAfterMs,
    });
    for (const [k, v] of Object.entries(c.sources)) out.cadence[k] = keep(v);
    for (const [k, v] of Object.entries(c.connectors)) out.cadence[`connector ${k}`] = keep(v);
  } catch (e) {
    out.problems.push(`compliance.cadence: ${(e as Error).message}`);
  }
  return out;
}

// ----------------------------------------------------------- declarations

/** Which way a change moves a control. */
export type Direction = "weakens" | "strengthens";

/** What a declaration finds when it compares two sides. */
export interface Finding {
  /** Which way. */
  direction: Direction;
  /** The change, in words: "turns off unattended upgrades". */
  what: string;
}

/** How a model setting implements an SCF control: Stolos's own, explicit statement. */
export interface Implementation<T> {
  /** Its id, used in accepted risks (`impact/<id>`), approvals, and `gate.allow`. */
  id: string;
  /** The SCF control the setting implements. */
  scf: ScfId;
  /** Per host, or for the fleet as a whole. */
  scope: "host" | "fleet";
  /** The setting in the model, in words: where to look. */
  setting: string;
  /** Which direction weakens the control, in words. */
  weakens: string;
  /** Compare the two sides; undefined when the setting did not change. */
  compare(before: T, after: T): Finding | undefined;
}

const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
const list = (xs: string[]) => xs.join(", ");
const flag = (
  before: boolean,
  after: boolean,
  off: string,
  on: string,
): Finding | undefined =>
  before === after
    ? undefined
    : after
    ? { direction: "strengthens", what: on }
    : { direction: "weakens", what: off };

/**
 * Set-valued settings where more is weaker (ports, networks, administrators):
 * anything added weakens (and wins over anything removed); only removals strengthen.
 */
const more = (
  before: string[],
  after: string[],
  grow: (xs: string[]) => string,
  shrink: (xs: string[]) => string,
): Finding | undefined => {
  const plus = added(before, after);
  const minus = added(after, before);
  if (plus.length) {
    return {
      direction: "weakens",
      what: grow(plus) + (minus.length ? ` (and ${shrink(minus)})` : ""),
    };
  }
  return minus.length ? { direction: "strengthens", what: shrink(minus) } : undefined;
};

const TIERS: McpTier[] = ["read", "repo", "mutate"];

/** The settings of each host that implement a control. */
export const HOST_IMPLEMENTATIONS: Implementation<HostFacts>[] = [
  {
    id: "updates",
    scf: "VPM-08",
    scope: "host",
    setting:
      "capabilities: updates() (spec 009): unattended-upgrades, with apt-daily-upgrade.timer enabled",
    weakens: "unattended upgrades off",
    compare: (a, b) =>
      flag(a.updates, b.updates, "turns off unattended upgrades", "turns on unattended upgrades"),
  },
  {
    id: "ssh-passwords",
    scf: "IAC-14",
    scope: "host",
    setting:
      "fleet.ssh.passwordFrom, rendered into sshd_config.d/50-archon.conf by ssh() (spec 007)",
    weakens: "SSH accepts passwords from more networks, or Stolos stops configuring sshd",
    compare: (a, b) => {
      if (a.sshPasswords && !b.sshPasswords) {
        return {
          direction: "weakens",
          what:
            "stops configuring sshd (keys only, passwords from local networks): Ubuntu's defaults apply",
        };
      }
      if (!a.sshPasswords && b.sshPasswords) {
        return {
          direction: "strengthens",
          what: "configures sshd: keys, and passwords only where set",
        };
      }
      if (!a.sshPasswords || !b.sshPasswords) return undefined;
      return more(
        a.sshPasswords,
        b.sshPasswords,
        (xs) =>
          a.sshPasswords!.length
            ? `accepts SSH passwords from ${list(xs)} too`
            : `turns on SSH password authentication (from ${list(xs)})`,
        (xs) =>
          b.sshPasswords!.length
            ? `no longer accepts SSH passwords from ${list(xs)}`
            : "turns off SSH password authentication (keys only)",
      );
    },
  },
  {
    id: "firewall",
    scf: "NET-02",
    scope: "host",
    setting: "capabilities: firewall() (spec 008): ufw installed and enabled, incoming denied",
    weakens: "the host firewall off",
    compare: (a, b) =>
      flag(
        a.firewall,
        b.firewall,
        "turns off the host firewall (ufw)",
        "turns on the host firewall (ufw)",
      ),
  },
  {
    id: "firewall-ports",
    scf: "NET-02",
    scope: "host",
    setting: "ports: every capability's ports, opened in ufw (spec 008)",
    weakens: "a port opened",
    compare: (a, b) =>
      more(a.ports, b.ports, (xs) => `opens ${list(xs)}`, (xs) => `closes ${list(xs)}`),
  },
  {
    id: "backup",
    scf: "BCD-24",
    scope: "host",
    setting: "capabilities: backup() (spec 016): the daily archon-backup.timer",
    weakens: "the host removed from backups",
    compare: (a, b) =>
      flag(a.backup, b.backup, "removes the host from backups", "adds the host to backups"),
  },
  {
    id: "backup-scope",
    scf: "BCD-24",
    scope: "host",
    setting:
      "host.backup (paths, keep) and durable guests (data: durable, spec 044): what the backup holds",
    weakens: "less backed up, or fewer archives kept",
    compare: (a, b) => {
      if (!a.backup || !b.backup) return undefined;
      const lost = added(b.backupScope, a.backupScope);
      const gained = added(a.backupScope, b.backupScope);
      const fewer = (b.backupKeep ?? 0) < (a.backupKeep ?? 0);
      if (lost.length || fewer) {
        return {
          direction: "weakens",
          what: [
            ...(lost.length ? [`no longer backs up ${list(lost)}`] : []),
            ...(fewer ? [`keeps ${b.backupKeep} archives instead of ${a.backupKeep}`] : []),
          ].join("; "),
        };
      }
      const keeps = (b.backupKeep ?? 0) > (a.backupKeep ?? 0);
      if (gained.length || keeps) {
        return {
          direction: "strengthens",
          what: [
            ...(gained.length ? [`also backs up ${list(gained)}`] : []),
            ...(keeps ? [`keeps ${b.backupKeep} archives instead of ${a.backupKeep}`] : []),
          ].join("; "),
        };
      }
      return undefined;
    },
  },
  {
    id: "osquery",
    scf: "MON-02",
    scope: "host",
    setting: "capabilities: osquery() (spec 042): fleet-wide questions answered by the host",
    weakens: "osquery removed",
    compare: (a, b) => flag(a.osquery, b.osquery, "removes osquery", "adds osquery"),
  },
  {
    id: "etckeeper",
    scf: "CHG-03",
    scope: "host",
    setting: "capabilities: etckeeper() (spec 033): every change to /etc recorded in Git",
    weakens: "/etc changes no longer recorded",
    compare: (a, b) =>
      flag(
        a.etckeeper,
        b.etckeeper,
        "stops recording /etc changes (etckeeper)",
        "records /etc changes (etckeeper)",
      ),
  },
  {
    id: "admins",
    scf: "IAC-30",
    scope: "host",
    setting: "host.users[].admin: the accounts with administrator rights (spec 006)",
    weakens: "more administrators",
    compare: (a, b) =>
      more(
        a.admins,
        b.admins,
        (xs) => `makes ${list(xs)} administrator${xs.length > 1 ? "s" : ""}`,
        (xs) => `takes administrator rights from ${list(xs)}`,
      ),
  },
];

/** The settings of the fleet as a whole that implement a control. */
export const FLEET_IMPLEMENTATIONS: Implementation<FleetFacts>[] = [
  {
    id: "agent-tier",
    scf: "IAC-30",
    scope: "fleet",
    setting: "fleet.mcp.maxTier (spec 030): what agents may do on each server",
    weakens: "a higher tier",
    compare: (a, b) => {
      const x = TIERS.indexOf(a.agentTier);
      const y = TIERS.indexOf(b.agentTier);
      if (x === y) return undefined;
      return {
        direction: y > x ? "weakens" : "strengthens",
        what: `${
          y > x ? "raises" : "lowers"
        } the agents' tier from ${a.agentTier} to ${b.agentTier}`,
      };
    },
  },
  {
    id: "cadence",
    scf: "MON-02",
    scope: "fleet",
    setting: "fleet.compliance.cadence (spec 073): how often evidence is observed, and when stale",
    weakens: "evidence observed less often, or stale later",
    compare: (a, b) => {
      const slower: string[] = [];
      const faster: string[] = [];
      for (const k of new Set([...Object.keys(a.cadence), ...Object.keys(b.cadence)])) {
        const x = a.cadence[k] ?? a.cadence.cloud;
        const y = b.cadence[k] ?? b.cadence.cloud;
        if (!x || !y) continue;
        const say =
          `${k} every ${y.every} (stale after ${y.staleAfter}) instead of ${x.every} (${x.staleAfter})`;
        if (y.everyMs > x.everyMs || y.staleAfterMs > x.staleAfterMs) slower.push(say);
        else if (y.everyMs < x.everyMs || y.staleAfterMs < x.staleAfterMs) faster.push(say);
      }
      if (slower.length) return { direction: "weakens", what: `observes ${slower.join("; ")}` };
      return faster.length
        ? { direction: "strengthens", what: `observes ${faster.join("; ")}` }
        : undefined;
    },
  },
];

/** Every declaration, host and fleet: what the comment and the docs list. */
export const IMPLEMENTATIONS: ReadonlyArray<
  Implementation<HostFacts> | Implementation<FleetFacts>
> = [
  ...HOST_IMPLEMENTATIONS,
  ...FLEET_IMPLEMENTATIONS,
];

/** One model change that moves a control. */
export interface ModelChange {
  /** The declaration that found it. */
  implementation: string;
  /** The SCF control. */
  scf: ScfId;
  /** A host's name, or "fleet". */
  subject: string;
  /** Which way. */
  direction: Direction;
  /** The change, in words. */
  what: string;
}

/** Compare two sides' facts: every declaration over every host on both sides, and the fleet. */
export function compareFacts(
  before: FleetFacts,
  after: FleetFacts,
): { changes: ModelChange[]; added: string[]; removed: string[] } {
  const changes: ModelChange[] = [];
  const names = Object.keys(after.hosts).sort();
  for (const h of names) {
    const a = before.hosts[h];
    const b = after.hosts[h];
    if (!a) continue;
    for (const d of HOST_IMPLEMENTATIONS) {
      const f = d.compare(a, b);
      if (f) changes.push({ implementation: d.id, scf: d.scf, subject: h, ...f });
    }
  }
  for (const d of FLEET_IMPLEMENTATIONS) {
    const f = d.compare(before, after);
    if (f) changes.push({ implementation: d.id, scf: d.scf, subject: "fleet", ...f });
  }
  return {
    changes,
    added: names.filter((h) => !before.hosts[h]),
    removed: Object.keys(before.hosts).filter((h) => !after.hosts[h]).sort(),
  };
}

// ------------------------------------------------------------------ gate

/**
 * The gate (`compliance.gate` in `fleets/<fleet>/fleet.ts`): whether a change
 * that weakens a control may be committed (`stolos apply`) or merged (the
 * pull request's check). Default: never block, only show.
 *
 * @example Block weakenings; opening ports is the router's business here
 * ```ts
 * import type { ComplianceGate } from "@stolos/archon/compliance/impact.ts";
 *
 * export const gate: ComplianceGate = { block: "weakens", allow: ["firewall-ports"] };
 * ```
 */
export interface ComplianceGate {
  /** "weakens": refuse a change that weakens a control unless allowed; "never" (default): show only. */
  block?: "weakens" | "never";
  /**
   * Weakenings that never block: a declaration's id ("firewall-ports"), a
   * declaration on one subject ("updates/beta"), or an SCF control ("NET-02").
   */
  allow?: string[];
  /** Also block when observed evidence turns a control to fail (default false: shown only). */
  evidence?: boolean;
}

/** A recorded approval: a signed commit's `Compliance-Approved:` trailer. */
export interface Approval {
  /** The commit ("(this commit)" for the one `stolos apply --approve` is about to sign). */
  commit: string;
  /** Who signed it (the signer's name in signers.ts). */
  signer: string;
  /** What it approves: keys (see {@link changeKeys}), or "all". */
  covers: string[];
}

/** The trailer that records an approval in a commit message. */
export const APPROVAL_TRAILER = "Compliance-Approved";

/** One weakening the gate judged. */
export interface GateItem {
  /** Its keys: the declaration, the declaration on its subject, the SCF control. */
  keys: string[];
  /** The change, in words, with its subject. */
  what: string;
  /** What allowed it, when something did. */
  allowedBy?: string;
}

/** The gate's verdict. */
export interface GateResult {
  /** The mode in force. */
  block: "weakens" | "never";
  /** Whether the change is refused. */
  blocked: boolean;
  /** Each weakening, and what allowed it. */
  items: GateItem[];
}

/** The keys a model change is known by: "updates", "updates/alpha", "VPM-08". */
export function changeKeys(c: { implementation: string; subject: string; scf: string }): string[] {
  return [c.implementation, `${c.implementation}/${c.subject}`, c.scf];
}

/** Parse a trailer's value: keys separated by commas or spaces. */
export function parseApproval(value: string): string[] {
  return value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

/** Judge the weakenings of a change. */
export function judge(o: {
  gate?: ComplianceGate;
  changes: ModelChange[];
  evidence?: ControlChange[];
  accepted?: readonly Acceptance[];
  approvals?: readonly Approval[];
  now?: number;
}): GateResult {
  const block = o.gate?.block ?? "never";
  const today = new Date(o.now ?? Date.now()).toISOString().slice(0, 10);
  const items: GateItem[] = [
    ...o.changes.filter((c) => c.direction === "weakens").map((c) => ({
      keys: changeKeys(c),
      what: `${c.subject}: ${c.what} (${c.scf})`,
    })),
    ...(o.gate?.evidence ? o.evidence ?? [] : []).filter((c) => c.worse && c.to === "fail").map((
      c,
    ) => ({ keys: [c.id], what: `${c.id} ${c.name}: ${c.from} -> ${c.to} (observed)` })),
  ];
  for (const it of items) {
    const allow = (o.gate?.allow ?? []).find((k) => it.keys.includes(k));
    if (allow) {
      it.allowedBy = `allowed by compliance.gate.allow (${allow})`;
      continue;
    }
    const acc = (o.accepted ?? []).find((a) =>
      a.until >= today && it.keys.some((k) => a.policy === `impact/${k}`)
    );
    if (acc) {
      it.allowedBy = `accepted risk (${acc.policy}): ${acc.by} until ${acc.until}: ${acc.reason}`;
      continue;
    }
    const ap = (o.approvals ?? []).find((a) =>
      a.covers.includes("all") || a.covers.some((k) => it.keys.includes(k))
    );
    if (ap) {
      it.allowedBy = `approved by ${ap.signer} (${
        ap.commit.length === 40 ? ap.commit.slice(0, 10) : ap.commit
      })`;
    }
  }
  return {
    block,
    blocked: block === "weakens" && items.some((i) => !i.allowedBy),
    items,
  };
}

// ---------------------------------------------------------------- impact

/** One affected SCF control, with what moved it. */
export interface AffectedControl {
  /** The SCF id. */
  id: string;
  /** Its SCF name. */
  name: string;
  /** Weakened (anything weakens it), else strengthened. */
  direction: Direction;
  /** The model changes. */
  changes: ModelChange[];
  /** The evidence change, when its observed status changed. */
  evidence?: ControlChange;
  /** Framework requirements SCF maps it to (when the catalog is cached). */
  requirements?: Partial<Record<FrameworkId, string[]>>;
}

/** The compliance impact of a change. */
export interface Impact {
  /** The fleet. */
  fleet: string;
  /** The base commit. */
  base: string;
  /** The head commit, or "working tree". */
  head: string;
  /** The model changes. */
  changes: ModelChange[];
  /** Hosts added and removed (a new host is not compared with anything). */
  hosts: { added: string[]; removed: string[] };
  /** The observed changes, per control. */
  evidence: ControlChange[];
  /** Every affected control, weakened first. */
  controls: AffectedControl[];
  /** The SCF catalog the requirements come from, or why there are none. */
  catalog: { version: string } | { missing: string };
  /** The gate's verdict. */
  gate: GateResult;
  /** What could not be read (a side's model, a host's plan). */
  problems: string[];
}

/** Group the changes per control, with names and requirements. */
export function affectedControls(
  changes: ModelChange[],
  evidence: ControlChange[],
  catalog?: ScfCatalog,
): AffectedControl[] {
  const ids = new Set([...changes.map((c) => c.scf as string), ...evidence.map((e) => e.id)]);
  const out: AffectedControl[] = [];
  for (const id of ids) {
    const mine = changes.filter((c) => c.scf === id);
    const ev = evidence.find((e) => e.id === id);
    const weak = mine.some((c) => c.direction === "weakens") || !!ev?.worse;
    const entry = catalog?.controls[id];
    out.push({
      id,
      name: entry?.name ?? scf(id)?.name ?? ev?.name ?? id,
      direction: weak ? "weakens" : "strengthens",
      changes: mine,
      ...(ev ? { evidence: ev } : {}),
      ...(entry
        ? {
          requirements: Object.fromEntries(
            FRAMEWORKS.map((f) => [f.id, entry.maps[f.id] ?? []]).filter(([, v]) =>
              (v as string[]).length
            ),
          ),
        }
        : {}),
    });
  }
  return out.sort((a, b) =>
    Number(b.direction === "weakens") - Number(a.direction === "weakens") ||
    a.id.localeCompare(b.id)
  );
}

/** A framework's requirements, short: SOC 2 by criterion, at most `max` shown. */
export function requirementText(fw: FrameworkId, ids: string[], max = 6): string {
  const short = FRAMEWORKS.find((f) => f.id === fw)!.short;
  const list = fw === "soc2" ? [...new Set(ids.map((i) => i.replace(/-POF\d+$/, "")))] : ids;
  const shown = list.slice(0, max).join(", ");
  return `${short} ${shown}${list.length > max ? ` and ${list.length - max} more` : ""}`;
}

/** One line per affected control: "VPM-08 Software & Firmware Patching: HIPAA 164.308(a)(5)(ii)(B); ...". */
export function controlLine(c: AffectedControl): string {
  const reqs = Object.entries(c.requirements ?? {}).map(([fw, ids]) =>
    requirementText(fw as FrameworkId, ids as string[])
  );
  return `${c.id} ${c.name}${reqs.length ? `: ${reqs.join("; ")}` : ""}`;
}

const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, "\\$1");

/** The pull request comment (and `--markdown`): what the change affects, by control. */
export function impactMarkdown(i: Impact): string {
  const weak = i.controls.filter((c) => c.direction === "weakens");
  const strong = i.controls.filter((c) => c.direction === "strengthens");
  const lines: string[] = [];
  if (i.controls.length) lines.push(IMPACT_AFFECTED_MARKER);
  lines.push(`### Compliance impact: fleet \`${i.fleet}\``, "");
  lines.push(
    `From \`${i.base.slice(0, 10)}\` to ${
      i.head === "working tree" ? "the working tree" : `\`${i.head.slice(0, 10)}\``
    }: ${
      i.controls.length
        ? `${weak.length} control(s) weakened, ${strong.length} strengthened.`
        : "no control is affected."
    }`,
    "",
  );
  if (i.gate.blocked) {
    lines.push(
      '**The fleet\'s gate blocks this change** (`compliance.gate.block: "weakens"`): record an accepted risk (`impact/<key>` in `controls/accepted.ts`) or an approval (a commit signed by a fleet signer with the trailer `Compliance-Approved: <key>`, as `stolos apply --approve <key>` writes it).',
      "",
    );
  }
  const section = (title: string, cs: AffectedControl[]) => {
    if (!cs.length) return;
    lines.push(`#### ${title}`, "");
    for (const c of cs) {
      lines.push(`- **${md(c.id)}** ${md(c.name)}`);
      for (const ch of c.changes) {
        lines.push(
          `  - ${ch.direction}: ${ch.subject === "fleet" ? "the fleet" : `\`${md(ch.subject)}\``} ${
            md(ch.what)
          } (\`${ch.implementation}\`)`,
        );
      }
      if (c.evidence) {
        lines.push(`  - observed: ${c.evidence.from} -> ${c.evidence.to}`);
        for (const e of c.evidence.evidence.slice(0, 5)) {
          lines.push(
            `    - ${md(e.subject)} (${e.source}): ${md(e.check)}: ${e.from ?? "none"} -> ${
              e.to ?? "none"
            }${e.stale ? " (stale)" : ""}`,
          );
        }
        if (c.evidence.evidence.length > 5) {
          lines.push(`    - and ${c.evidence.evidence.length - 5} more`);
        }
      }
      const reqs = Object.entries(c.requirements ?? {});
      if (reqs.length) {
        lines.push(
          `  - requirements: ${
            reqs.map(([fw, ids]) => md(requirementText(fw as FrameworkId, ids as string[]))).join(
              "; ",
            )
          }`,
        );
      }
    }
    lines.push("");
  };
  section("Weakened", weak);
  section("Strengthened", strong);
  if (
    i.gate.items.length && (i.gate.block === "weakens" || i.gate.items.some((x) => x.allowedBy))
  ) {
    lines.push(`#### Gate (\`${i.gate.block}\`)`, "");
    for (const it of i.gate.items) {
      lines.push(
        `- ${it.allowedBy ? "allowed" : i.gate.block === "weakens" ? "**blocked**" : "shown"}: ${
          md(it.what)
        }${it.allowedBy ? `: ${md(it.allowedBy)}` : ""} (keys: ${
          it.keys.map((k) => `\`${k}\``).join(", ")
        })`,
      );
    }
    lines.push("");
  }
  if (i.hosts.added.length || i.hosts.removed.length) {
    lines.push(
      [
        i.hosts.added.length
          ? `Hosts added (not compared): ${i.hosts.added.map((h) => `\`${md(h)}\``).join(", ")}.`
          : "",
        i.hosts.removed.length
          ? `Hosts removed: ${i.hosts.removed.map((h) => `\`${md(h)}\``).join(", ")}.`
          : "",
      ].filter(Boolean).join(" "),
      "",
    );
  }
  for (const p of i.problems) lines.push(`> Not compared: ${md(p)}`, "");
  lines.push(
    "catalog" in i && "version" in i.catalog
      ? `<sub>Framework requirements: the SCF Council's mappings (STRM), SCF ${i.catalog.version}. Which settings implement which controls: Stolos's declarations (spec 074).</sub>`
      : `<sub>Framework requirements are not shown: ${
        md((i.catalog as { missing: string }).missing)
      }. Which settings implement which controls: Stolos's declarations (spec 074).</sub>`,
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------- reading sides

/**
 * Copy a commit's `fleets/` folder into a new temporary folder, without
 * touching the checkout, its index, or its worktrees. The caller removes it.
 */
export async function extractFleets(repo: string, rev: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "stolos-impact-" });
  const index = join(dir, ".index");
  const env = { GIT_INDEX_FILE: index };
  // Only fleets/: a commit's deno.json (another engine's pin) must not be beside its files.
  const read = await run(["git", "-C", repo, "read-tree", `${rev}:fleets`], { env });
  if (!read.ok) {
    await removeTemp(dir);
    throw new Error(`${rev.slice(0, 10)} has no fleets/: ${read.stderr.trim()}`);
  }
  const co = await run(
    ["git", "-C", repo, "checkout-index", "-a", "-f", `--prefix=${dir}/tree/fleets/`],
    { env },
  );
  if (!co.ok) {
    await removeTemp(dir);
    throw new Error(`git checkout-index: ${co.stderr.trim()}`);
  }
  return join(dir, "tree");
}

/** Remove a temporary folder; one already gone is fine, anything else is said. */
async function removeTemp(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`warning: could not remove ${dir}: ${(e as Error).message}`);
    }
  }
}

/** Run `f` with the instance root set to `root` (the same fleet id), then put it back. */
async function withRoot<T>(root: string, fleet: string, f: () => Promise<T>): Promise<T> {
  const { resetRoots } = await import("../core/paths.ts");
  const keep = { repo: Deno.env.get("ARCHON_REPO"), fleet: Deno.env.get("ARCHON_FLEET") };
  Deno.env.set("ARCHON_REPO", root);
  Deno.env.set("ARCHON_FLEET", fleet);
  resetRoots();
  try {
    return await f();
  } finally {
    if (keep.repo === undefined) Deno.env.delete("ARCHON_REPO");
    else Deno.env.set("ARCHON_REPO", keep.repo);
    if (keep.fleet === undefined) Deno.env.delete("ARCHON_FLEET");
    else Deno.env.set("ARCHON_FLEET", keep.fleet);
    resetRoots();
  }
}

/** One side's model, loaded from `root` (a checkout or an extracted commit): its facts. */
export function modelFactsAt(
  root: string,
  fleet: string,
): Promise<{ facts: FleetFacts } | { error: string }> {
  return withRoot(root, fleet, async () => {
    try {
      const { loadFleet, loadHosts } = await import("../model/load.ts");
      const def = await loadFleet();
      return { facts: await fleetFacts(def, await loadHosts()) };
    } catch (e) {
      return { error: (e as Error).message.split("\n")[0] };
    }
  });
}

/** The signers a commit's `signers.ts` lists (as `stolos signers` writes it), without running it. */
export async function signersAt(repo: string, rev: string, fleet: string): Promise<SignerDef[]> {
  const r = await run(["git", "-C", repo, "show", `${rev}:fleets/${fleet}/signers.ts`]);
  if (!r.ok) return [];
  const at = r.stdout.indexOf("export default");
  if (at < 0) return [];
  try {
    const { parseTsLiteral } = await import("../core/ts-literal.ts");
    const v = parseTsLiteral(r.stdout, at + "export default".length).value;
    return Array.isArray(v) ? v as SignerDef[] : [];
  } catch {
    return [];
  }
}

/**
 * The approvals in `base..head`: each commit with a `Compliance-Approved:`
 * trailer and a good signature by one of `signers` (the base's, so a change
 * cannot add the signer that approves it). Others are listed as unverified.
 */
export async function approvalsIn(
  repo: string,
  base: string,
  head: string,
  signers: SignerDef[],
): Promise<{ approvals: Approval[]; unverified: string[] }> {
  const log = await run([
    "git",
    "-C",
    repo,
    "log",
    `--format=%H%x1f%(trailers:key=${APPROVAL_TRAILER},valueonly,separator=%x2C)%x1e`,
    `${base}..${head}`,
  ]);
  const approvals: Approval[] = [];
  const unverified: string[] = [];
  const rows = log.stdout.split("\x1e").map((r) => r.trim()).filter(Boolean);
  const wanted = rows.map((r) => r.split("\x1f")).filter(([, v]) => v?.trim());
  if (!wanted.length) return { approvals, unverified };
  if (!signers.length) {
    for (const [sha] of wanted) {
      unverified.push(
        `${sha.slice(0, 10)}: the base lists no signer, so no approval can be checked`,
      );
    }
    return { approvals, unverified };
  }
  const { allowedSignersText, checkTip } = await import("../identity/signers.ts");
  const dir = await Deno.makeTempDir({ prefix: "stolos-approvals-" });
  try {
    const allowed = join(dir, "allowed_signers");
    await Deno.writeTextFile(allowed, allowedSignersText(signers));
    for (const [sha, value] of wanted) {
      const t = await checkTip(repo, sha, "", allowed);
      if (t.ok && t.signer) {
        approvals.push({ commit: sha, signer: t.signer, covers: parseApproval(value) });
      } else unverified.push(`${sha.slice(0, 10)}: ${t.reason ?? "not signed by a fleet signer"}`);
    }
  } finally {
    await removeTemp(dir);
  }
  return { approvals, unverified };
}

/** What {@link computeImpact} is given. */
export interface ImpactOptions {
  /** The fleet repository. */
  repo: string;
  /** The fleet's id. */
  fleet: string;
  /** The base: a commit, branch, or tag (the merge base with the head is used). */
  base: string;
  /** The head: a commit (default: the working tree). */
  head?: string;
  /** An approval about to be signed (`stolos apply --approve`). */
  pendingApproval?: string[];
  /** The SCF catalog (default: the cached one, if any). */
  catalog?: ScfCatalog | null;
  /** Now (accepted risks' dates, evidence ages). */
  now?: number;
  /** The connectors whose observations count (default: every one). */
  connectors?: import("../connect/connector.ts").Connector[];
  /** Skip the evidence comparison (model changes only). */
  modelOnly?: boolean;
}

/** Compute the compliance impact of the change from `base` to `head` (or the working tree). */
export async function computeImpact(o: ImpactOptions): Promise<Impact | { error: string }> {
  const git = (args: string[]) => run(["git", "-C", o.repo, ...args]);
  const verify = async (rev: string) =>
    (await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).stdout.trim();
  const head = o.head ? await verify(o.head) : "";
  if (o.head && !head) return { error: `no commit ${o.head}` };
  const baseRev = await verify(o.base);
  if (!baseRev) return { error: `no commit ${o.base}` };
  const tip = head || (await verify("HEAD"));
  const mb = tip ? (await git(["merge-base", baseRev, tip])).stdout.trim() : "";
  const base = mb || baseRev;
  const now = o.now ?? Date.now();
  const problems: string[] = [];
  const temps: string[] = [];
  try {
    // 1. The model, on both sides.
    const baseRoot = await extractFleets(o.repo, base);
    temps.push(join(baseRoot, ".."));
    const headRoot = head ? await extractFleets(o.repo, head) : o.repo;
    if (head) temps.push(join(headRoot, ".."));
    const before = await modelFactsAt(baseRoot, o.fleet);
    const after = await modelFactsAt(headRoot, o.fleet);
    let changes: ModelChange[] = [];
    let hosts = { added: [] as string[], removed: [] as string[] };
    if ("error" in after) return { error: `the model at the head: ${after.error}` };
    if ("error" in before) {
      problems.push(`the model at ${base.slice(0, 10)}: ${before.error}`);
    } else {
      const c = compareFacts(before.facts, after.facts);
      changes = c.changes;
      hosts = { added: c.added, removed: c.removed };
      for (const p of before.facts.problems) problems.push(`at the base, ${p}`);
    }
    for (const p of after.facts.problems) problems.push(`at the head, ${p}`);

    // 2. The catalog.
    const catalog = o.catalog === null
      ? undefined
      : o.catalog ?? await (await import("./catalog.ts")).loadScf().catch(() => undefined);

    // 3. Evidence: observations in Git, and the fleet's control packs, on both sides.
    let evidence: ControlChange[] = [];
    if (!o.modelOnly) {
      const { repoEvidence, compareViews } = await import("./drift.ts");
      const { gitReader } = await import("../estate/snapshot.ts");
      const connectors = o.connectors ??
        await (await import("../connect/commands.ts")).allConnectors();
      const side = async (rev: string | undefined, root: string) => {
        const reader = gitReader(o.repo, rev);
        return await repoEvidence(reader, o.fleet, {
          now,
          connectors,
          ...(catalog ? { catalog } : {}),
          packs: async (i) => {
            const { runFleetPacks } = await import("../controls/run.ts");
            let estate;
            try {
              const { readSnapshot } = await import("../estate/snapshot.ts");
              const { buildGraph } = await import("../estate/graph.ts");
              estate = buildGraph(await readSnapshot(reader, o.fleet, rev), { now: new Date(now) });
            } catch {
              estate = undefined;
            }
            const r = await runFleetPacks({
              dir: join(root, "fleets", o.fleet, "controls"),
              adopted: i.adopted,
              devices: i.devices,
              connectors: i.connectors,
              ...(estate ? { estate } : {}),
              now: new Date(now),
            });
            return r.runs;
          },
        });
      };
      try {
        evidence = compareViews(
          await side(base, baseRoot),
          await side(head || undefined, headRoot),
        );
      } catch (e) {
        problems.push(`the evidence: ${(e as Error).message.split("\n")[0]}`);
      }
    }

    // 4. The gate: the base's, with accepted risks (the head's) and approvals (signed, the base's signers).
    const { loadAccepted } = await import("../controls/run.ts");
    const accepted = await loadAccepted(join(headRoot, "fleets", o.fleet, "controls")).catch(
      () => [],
    );
    const signers = await signersAt(o.repo, base, o.fleet);
    const found = tip
      ? await approvalsIn(o.repo, base, tip, signers)
      : { approvals: [], unverified: [] };
    for (const u of found.unverified) problems.push(`approval not counted: ${u}`);
    const approvals = [
      ...found.approvals,
      ...(o.pendingApproval?.length
        ? [{ commit: "(this commit)", signer: "your signature", covers: o.pendingApproval }]
        : []),
    ];
    const gateConfig = "facts" in before ? before.facts.gate : after.facts.gate;
    const gate = judge({
      ...(gateConfig ? { gate: gateConfig } : {}),
      changes,
      evidence,
      accepted,
      approvals,
      now,
    });
    return {
      fleet: o.fleet,
      base,
      head: head || "working tree",
      changes,
      hosts,
      evidence,
      controls: affectedControls(changes, evidence, catalog),
      catalog: catalog
        ? { version: catalog.version }
        : { missing: "the SCF catalog is not cached here (deno task stolos compliance catalog)" },
      gate,
      problems,
    };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0] };
  } finally {
    for (const t of temps) await removeTemp(t);
  }
}

// ------------------------------------------------------------- commands

/** The default base: the fleet branch on GitHub (origin/<branch>), else HEAD. */
async function defaultBase(repo: string): Promise<string> {
  const { loadFleet } = await import("../model/load.ts");
  const branch = (await loadFleet().catch(() => undefined))?.repository?.branch ?? "main";
  const r = await run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `origin/${branch}`]);
  return r.ok ? `origin/${branch}` : "HEAD";
}

/**
 * `stolos compliance impact`: print the impact; exit 1 when the gate blocks,
 * 2 when it cannot be computed.
 */
export async function impactCommand(
  o: { base?: string; head?: string; json?: boolean; markdown?: boolean } = {},
): Promise<number> {
  const { P } = await import("../core/paths.ts");
  const quiet = o.json || o.markdown;
  const { ui } = await import("../core/ui.ts");
  if (!P.fleetId) {
    if (quiet) console.error("no fleet chosen: deno task stolos fleet use <id>, or ARCHON_FLEET");
    else ui.phase("Compliance impact").fail("no fleet chosen", "deno task stolos fleet use <id>");
    return 2;
  }
  const i = await computeImpact({
    repo: P.repo,
    fleet: P.fleetId,
    base: o.base ?? await defaultBase(P.repo),
    ...(o.head ? { head: o.head } : {}),
  });
  if ("error" in i) {
    if (quiet) console.error(`compliance impact: ${i.error}`);
    else ui.phase("Compliance impact").fail(i.error, "--base and --head take commits");
    return 2;
  }
  if (o.json) console.log(JSON.stringify(i, null, 2));
  else if (o.markdown) console.log(impactMarkdown(i));
  else printImpact(i, ui.phase("Compliance impact"));
  return i.gate.blocked ? 1 : 0;
}

/** What printImpact writes to: a terminal phase, or a test's recorder. */
export type PhaseLike = {
  ok(m: string): void;
  warn(m: string, fix?: string): void;
  fail(m: string, fix?: string): void;
  note(m: string): void;
  done(m?: string): void;
};

/** The impact as a terminal phase: weakenings as warnings, a blocked gate as a failure. */
export function printImpact(i: Impact, p: PhaseLike): void {
  const name = (id: string) => i.controls.find((c) => c.id === id)?.name ?? id;
  for (const c of i.changes) {
    const msg = `${c.subject === "fleet" ? "the fleet" : c.subject}: ${c.what}: ${c.scf} ${
      name(c.scf)
    }`;
    if (c.direction === "weakens") p.warn(msg);
    else p.ok(msg);
  }
  for (const e of i.evidence) {
    const msg = `${e.id} ${e.name} (observed): ${e.from} -> ${e.to}`;
    if (e.worse) p.warn(msg);
    else p.ok(msg);
  }
  for (const c of i.controls.filter((x) => x.requirements)) p.note(controlLine(c));
  if (!("version" in i.catalog)) p.note(`framework requirements not shown: ${i.catalog.missing}`);
  for (const x of i.problems) p.note(`not compared: ${x}`);
  for (const it of i.gate.items.filter((x) => x.allowedBy)) p.note(`${it.what}: ${it.allowedBy}`);
  const blocked = i.gate.items.filter((x) => !x.allowedBy);
  if (i.gate.blocked) {
    for (const it of blocked) {
      p.fail(
        `the gate blocks: ${it.what}`,
        `accept the risk (policy "impact/${
          it.keys[1]
        }" in controls/accepted.ts), or approve it: deno task stolos apply --approve ${it.keys[1]}`,
      );
    }
    return;
  }
  const w = i.controls.filter((c) => c.direction === "weakens").length;
  const s = i.controls.length - w;
  p.done(
    i.controls.length
      ? `${w} control(s) weakened, ${s} strengthened${
        i.gate.block === "never" && w ? " (the gate is off: compliance.gate in fleet.ts)" : ""
      }`
      : "no control affected",
  );
}

/**
 * `stolos apply`'s "Compliance impact" phase: compare the working tree with
 * `base` (what GitHub has); false when the gate blocks (nothing is committed).
 */
export async function applyImpact(
  o: { base?: string; approve?: string },
): Promise<boolean> {
  const { ui } = await import("../core/ui.ts");
  const { P } = await import("../core/paths.ts");
  const p = ui.phase("Compliance impact");
  if (!o.base) {
    p.done("the first push: nothing to compare with");
    return true;
  }
  p.status("comparing the model with GitHub's");
  const i = await computeImpact({
    repo: P.repo,
    fleet: P.fleetId,
    base: o.base,
    ...(o.approve ? { pendingApproval: parseApproval(o.approve) } : {}),
  });
  if ("error" in i) {
    const { loadFleet } = await import("../model/load.ts");
    const gate = (await loadFleet().catch(() => undefined))?.compliance?.gate;
    if (gate?.block === "weakens") {
      p.fail(`not computed: ${i.error}`, "the gate is on, so nothing is committed until it is");
      return false;
    }
    p.warn(`not computed: ${i.error}`);
    p.done("skipped");
    return true;
  }
  printImpact(i, p);
  return !i.gate.blocked;
}
