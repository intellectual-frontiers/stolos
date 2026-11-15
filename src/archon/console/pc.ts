/**
 * Spec 066: what the Stolos Console shows, gathered on the PC from the fleet
 * repository and this PC's state: every machine (managed servers and
 * workstations, adopted machines, cloud servers), the clouds, the signers,
 * and the repository's changes. Nothing here reaches a server: the last
 * answers are those `stolos fleet status` and `host observe` recorded; the
 * pages offer the commands that refresh them.
 *
 * @module
 */

import { run } from "../core/exec.ts";
import { readTextOr } from "../core/fsx.ts";
import { join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import type { AdoptedDef, Observed } from "../adopt/adopt.ts";
import type { Observation } from "../connect/connector.ts";

/** One machine, whatever its kind. */
export interface PcMachine {
  /** Its name in the fleet (or the cloud's). */
  name: string;
  /** server or workstation (managed), adopted, device (SNMP), discovered (recorded, not yet adopted), or cloud. */
  kind: "server" | "workstation" | "adopted" | "device" | "discovered" | "cloud";
  /** Its operating system, when known. */
  os?: string;
  /** Where it is: an address, a cloud and region. */
  where?: string;
  /** Who it belongs to (adopted machines). */
  owner?: string;
  /** What it is, for people (an adopted machine's title). */
  title?: string;
  /** Its serial number, when the probe could read it. */
  serial?: string;
  /** When it was last installed (managed) or observed (adopted, cloud). */
  seen?: string;
  /** Its checks or policies: how many pass, of how many. */
  score?: { pass: number; total: number };
  /** What fails, in words. */
  failing: string[];
  /** Its Archon Console, for a managed server with a web domain. */
  console?: string;
  /** A managed server's applied commit, as it last said (short hash, subject, when). */
  applied?: { commit: string; subject: string; at: string };
  /** A managed server's last pull: when, and why it stopped, if it did. */
  sync?: { at: string; blocked?: string };
  /** Whether its applied commit is the repository's newest (undefined: not known). */
  upToDate?: boolean;
}

/** One cloud account, observed. */
export interface PcConnector {
  /** The provider's id. */
  id: string;
  /** Its name for people. */
  title: string;
  /** Its logo (Simple Icons slug), or "". */
  logo: string;
  /** Connected on this PC (its credential is in the vault). */
  connected: boolean;
  /** The last observation, when there is one. */
  observed?: Observation;
  /** Its posture policies. */
  results: PolicyResult[];
}

/** One commit of the fleet repository. */
export interface PcCommit {
  /** Short hash. */
  sha: string;
  /** Subject. */
  subject: string;
  /** Author. */
  author: string;
  /** When (ISO). */
  at: string;
  /** Signed by one of the fleet's signers (servers apply it), or not. */
  approved: boolean;
}

/** Everything the Stolos Console shows. */
export interface PcFacts {
  /** The fleet: id, title, its repository, web domain, and engine pin. */
  fleet: { id: string; title: string; repo: string; domain?: string; engine?: string };
  /** Every machine. */
  machines: PcMachine[];
  /** Adopted machines with their observations and policies. */
  adopted: Array<{ machine: AdoptedDef; observed?: Observed; results: PolicyResult[] }>;
  /** Every cloud provider. */
  clouds: PcConnector[];
  /** Spec 085: the cross-system policies over the estate graph. */
  estate?: PolicyResult[];
  /** Devices read over SNMPv3, with their policies. */
  devices: Array<
    {
      device: import("../device/device.ts").DeviceDef;
      observed?: import("../device/device.ts").DeviceObserved;
      results: PolicyResult[];
    }
  >;
  /** The signers. */
  signers: Array<{ name: string; role: string; added: string; key: string }>;
  /** The repository: uncommitted files, commits servers would refuse, recent history. */
  git: { dirty: string[]; unapproved: string[]; log: PcCommit[]; diff?: string };
}

const warn = (what: string) => (e: unknown) => {
  console.error(`warning: ${what}: ${(e as Error).message}`);
  return undefined;
};

/** Gather the facts (each part on its own: a broken part leaves the rest). */
export async function pcFacts(repo = P.repo): Promise<PcFacts> {
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const { getRecord } = await import("../state/store.ts");
  const { loadAdopted } = await import("../adopt/adopt.ts");
  const { policies } = await import("../adopt/policy.ts");
  const { CONNECTORS, loadObservations } = await import("../connect/commands.ts");
  const { connectorCredPath } = await import("../connect/connector.ts");
  const { exists } = await import("../core/fsx.ts");
  const { readPin } = await import("../fleet/upgrade.ts");
  const fleet = await loadFleet().catch(warn("fleet.ts"));
  const hosts = (await loadHosts().catch(warn("hosts"))) ?? [];
  const domain = fleet?.web?.domain;
  const machines: PcMachine[] = [];
  for (const h of hosts) {
    const inst = await getRecord<{ ok?: boolean; checks?: { passed: number; total: number } }>(
      h.name,
      "install",
      "install",
      P.state,
    ).catch(warn(`${h.name} install record`));
    const v = await getRecord<{ passed: number; total: number; failed: string[]; since: string }>(
      h.name,
      "verify",
      "latest",
      P.state,
    ).catch(warn(`${h.name} verify record`));
    const latest = v?.body && (!inst?.at || v.body.since >= inst.at) ? v.body : undefined;
    const checks = latest ??
      (inst?.body.checks
        ? { passed: inst.body.checks.passed, total: inst.body.checks.total, failed: [] }
        : undefined);
    const server = h.kind !== "workstation";
    const applied = await getRecord<{ commit: string; subject: string; at: string }>(
      h.name,
      "applied",
      "latest",
      P.state,
    )
      .catch(warn(`${h.name} applied record`));
    const sync = await getRecord<{ at: string; blocked?: string }>(
      h.name,
      "sync",
      "latest",
      P.state,
    )
      .catch(warn(`${h.name} sync record`));
    machines.push({
      name: h.name,
      kind: server ? "server" : "workstation",
      os: "Ubuntu",
      ...(h.ip ? { where: h.ip } : {}),
      ...(inst?.at ? { seen: inst.at } : {}),
      ...(checks ? { score: { pass: checks.passed, total: checks.total } } : {}),
      failing: latest?.failed ?? [],
      ...(applied?.body ? { applied: applied.body } : {}),
      ...(sync?.body
        ? {
          sync: { at: sync.body.at, ...(sync.body.blocked ? { blocked: sync.body.blocked } : {}) },
        }
        : {}),
      ...(server && domain ? { console: `https://${h.name}.${domain}/` } : {}),
    });
  }
  const now = Date.now();
  const adopted = (await loadAdopted().catch(warn("adopted machines")) ?? []).map((a) => ({
    ...a,
    results: policies(a.machine, a.observed, now),
  }));
  for (const a of adopted) {
    const pass = a.results.filter((r) => r.status === "pass").length;
    machines.push({
      name: a.machine.name,
      kind: "adopted",
      ...(a.observed ? { os: `${a.observed.os.name} ${a.observed.os.version}`.trim() } : {}),
      where: a.machine.ssh.address,
      ...(a.machine.owner ? { owner: a.machine.owner } : {}),
      ...(a.machine.title ? { title: a.machine.title } : {}),
      ...(a.observed?.os.serial ? { serial: a.observed.os.serial } : {}),
      ...(a.observed ? { seen: a.observed.at } : {}),
      score: { pass, total: a.results.length },
      failing: a.results.filter((r) => r.status === "fail").map((r) => r.title),
    });
  }
  const { loadDevices, devicePolicies } = await import("../device/device.ts");
  const devices = ((await loadDevices().catch(warn("devices"))) ?? []).map((d) => ({
    ...d,
    results: devicePolicies(d.device, d.observed, now),
  }));
  for (const d of devices) {
    machines.push({
      name: d.device.name,
      kind: "device",
      os: d.observed?.model ?? d.device.kind,
      where: d.device.address,
      ...(d.device.owner ? { owner: d.device.owner } : {}),
      ...(d.device.title ? { title: d.device.title } : {}),
      ...(d.observed?.serial ? { serial: d.observed.serial } : {}),
      ...(d.observed ? { seen: d.observed.at } : {}),
      score: { pass: d.results.filter((r) => r.status === "pass").length, total: d.results.length },
      failing: d.results.filter((r) => r.status === "fail").map((r) => r.title),
    });
  }
  const { loadDiscovered } = await import("../adopt/integrate.ts");
  for (const d of (await loadDiscovered().catch(warn("discovered.ts"))) ?? []) {
    machines.push({
      name: d.name,
      kind: "discovered",
      ...(d.os ? { os: d.os } : {}),
      where: d.addresses[0] ?? d.hostname,
      ...(d.owner ? { owner: d.owner } : {}),
      ...(d.serial ? { serial: d.serial } : {}),
      seen: d.at,
      failing: [],
    });
  }
  const observed = (await loadObservations().catch(warn("cloud observations"))) ?? [];
  const clouds: PcConnector[] = [];
  for (const c of CONNECTORS) {
    const o = observed.find((x) => x.provider === c.id);
    clouds.push({
      id: c.id,
      title: c.title,
      logo: c.logo,
      connected: await exists(connectorCredPath(c.id)),
      ...(o ? { observed: o } : {}),
      results: o ? c.policies(o, now) : [],
    });
    for (const a of o?.assets ?? []) {
      if (!["server", "ec2-instance"].includes(a.kind) || a.fleetMachine) continue;
      machines.push({
        name: a.name,
        kind: "cloud",
        where: `${c.title}${a.where ? `, ${a.where}` : ""}`,
        seen: o!.at,
        failing: [],
        ...(a.facts?.image ? { os: String(a.facts.image) } : {}),
      });
    }
  }
  let signers: PcFacts["signers"] = [];
  try {
    const { loadSigners } = await import("../identity/signers.ts");
    signers = (await loadSigners()).map((s) => ({
      name: s.name,
      role: s.role,
      added: s.added,
      key: s.key.split(/\s+/).slice(0, 2).join(" "),
    }));
  } catch (e) {
    warn("signers.ts")(e);
  }
  const git = (args: string[]) => run(["git", "-C", repo, ...args]);
  const dirty = (await git(["status", "--porcelain"])).stdout.split("\n").filter(Boolean);
  // What Apply would commit (tracked files; new files are listed above), at most 400 lines.
  const diffText = dirty.length
    ? (await git(["diff", "HEAD", "--no-color"])).stdout.split("\n").slice(0, 400).join("\n")
    : "";
  const { unapproved } = await import("../fleet/apply.ts");
  const pending = await unapproved(git, repo).catch(warn("unapproved commits")) ?? [];
  const waiting = new Set(pending.map((l) => l.split(" ")[0]));
  const log = (await git(["log", "-20", "--format=%H%x09%s%x09%an%x09%cI"])).stdout.trim().split(
    "\n",
  )
    .filter(Boolean).map((l) => {
      const [sha, subject, author, at] = l.split("\t");
      return {
        sha: sha.slice(0, 10),
        subject,
        author,
        at,
        approved: !waiting.has(sha.slice(0, 10)),
      };
    });
  const newest = log[0]?.sha;
  for (const m of machines) {
    if (m.applied && newest) {
      m.upToDate = newest.startsWith(m.applied.commit) || m.applied.commit.startsWith(newest);
    }
  }
  const pin = readPin((await readTextOr(join(repo, "deno.json"))) ?? "");
  const { repoSlug } = await import("../fleet/bootstrap.ts");
  return {
    fleet: {
      id: P.fleetId,
      title: fleet?.title ?? P.fleetId,
      repo: fleet?.repository.slug ?? (await repoSlug(repo)),
      ...(domain ? { domain } : {}),
      ...(pin ? { engine: pin.tag } : {}),
    },
    machines,
    adopted,
    clouds,
    devices,
    estate: await (async () => {
      try {
        const { loadEstate } = await import("../connect/commands.ts");
        const { estatePolicies } = await import("../connect/estate.ts");
        return estatePolicies(await loadEstate());
      } catch (e) {
        warn("the estate graph")(e);
        return [];
      }
    })(),
    signers,
    git: { dirty, unapproved: pending, log, ...(diffText ? { diff: diffText } : {}) },
  };
}
