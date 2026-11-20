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
// Spec: 066-stolos-console
// Spec: 101-ladder FR-006
// Spec: 107-pairing-and-query FR-007, FR-008
// Spec: 108-tags FR-014
// Spec: 112-machine-reported-tags FR-011, FR-013, FR-014, FR-015
// Spec: 115-compatibility FR-009, FR-010
// Spec: 110-network-assets FR-002, FR-006, FR-008, FR-009
// Spec: 111-network-posture FR-014, FR-015
// Spec: 117-adopted-in-status FR-006

import type { Attention, RecordedVerify } from "../state/verify.ts";
import { fs, path } from "@intellectual-frontiers/system";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { P } from "../core/paths.ts";
import { isNeverObserved, type PolicyResult } from "../adopt/policy.ts";
import type { AdoptedDef, Observed } from "../adopt/adopt.ts";
import type { Observation } from "../connect/connector.ts";
import type { PackRun } from "../controls/run.ts";
import type { DeviceDef, DeviceObserved } from "../device/device.ts";
import type {
  CompatStatus,
  DeviceClass,
  DeviceFacet,
  MachineKind,
  WayOfJoining,
} from "../ontology.auto.ts";
import type { NetworkView } from "../connect/network-view.ts";
import type { PostureRun } from "../connect/network-posture.ts";
import { wayOfJoining } from "../adopt/joining.ts";
import type { ClaimView, ResolvedTag, TaggingView } from "../fleet/tags.ts";

/**
 * Spec 115-compatibility FR-009: a machine against this PC's contract, for the pages and the evidence: its status, the statement in
 * plain words with its fix, the engine it reported, and each seam it was judged on.
 */
export interface PcCompat {
  /** `compatible`, `too-old`, `newer` or `unknown` (`stolos:CompatStatus`). */
  status: CompatStatus;
  /** `compatible`, `too old for this PC: run archon update on alpha`, `newer than this PC: ...`, `unknown (not reported yet)`. */
  headline: string;
  /** The sentence for a list: `alpha runs engine 0.148.0, compatible with this PC's 0.152.0`. */
  detail: string;
  /** The command that fixes it. */
  fix?: string;
  /** The code `stolos explain` knows. */
  code?: string;
  /** The engine it reported. */
  engine?: string;
  /** When it last reported (ISO). */
  reportedAt?: string;
  /** Each seam: what the machine has, what this PC has, what it needs, and the result. */
  seams: Array<{ seam: string; status: CompatStatus; machine?: string; pc: string; needs: string }>;
  /** Its hold at an engine tag, in plain words (spec 115-compatibility FR-014). */
  held?: string;
}

/** One machine, whatever its kind. */
export interface PcMachine {
  /** Its name in the fleet (or the cloud's). */
  name: string;
  /**
   * server or workstation (managed), adopted, device (SNMP), discovered (recorded, not yet adopted),
   * or cloud: the ontology's machine kinds (spec 101-ladder FR-006), but the controller, which the
   * console lists as an adopted machine.
   */
  kind: Exclude<MachineKind, "controller">;
  /** How it joined the fleet (spec 107-pairing-and-query FR-007); undefined for a machine only discovered. */
  joined?: WayOfJoining;
  /** The fleet's controller PC (an adopted machine with the role `controller`, spec 097). */
  controller?: boolean;
  /** The controller that is this PC (the console runs on it): pinned first in the This PC group. */
  thisPc?: boolean;
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
  /**
   * A managed machine's checks that did not pass at its last verify (failed, warned, or not set up
   * yet), each with its fix, as it reported them (stolos fleet status).
   */
  attention?: Attention[];
  /** A managed machine's results were never asked for from this PC (stolos fleet status). */
  notAsked?: boolean;
  /** Its Archon Console, for a managed server with a web domain. */
  console?: string;
  /** A managed server's applied commit, as it last said (short hash, subject, when). */
  applied?: { commit: string; subject: string; at: string };
  /** A managed server's last pull: when, and why it stopped, if it did. */
  sync?: { at: string; blocked?: string };
  /** Whether its applied commit is the repository's newest (undefined: not known). */
  upToDate?: boolean;
  /** Its tags (spec 108-tags FR-014), each with its origin; free-form ones are marked custom. Absent where it has none. */
  tags?: ResolvedTag[];
  /** Spec 112-machine-reported-tags FR-014: what it says about itself, and what the fleet did with it. Absent where it never reported. */
  says?: ClaimView[];
  /** Spec 112-machine-reported-tags FR-013: where it says another value than the fleet (the fleet wins), in words. */
  disagreements?: string[];
  /** Spec 112-machine-reported-tags FR-013: when it last reported (the evidence of its inventory's accuracy). */
  reportedAt?: string;
  /** Spec 112-machine-reported-tags FR-004: how many things it said were dropped (not tags, too long, over the cap). */
  claimsDropped?: number;
  /** Spec 115-compatibility FR-009: it against this PC's contract (a server, an adopted machine, the controller). */
  compat?: PcCompat;
  /** Spec 110-network-assets FR-002, FR-009: a network asset (adopted through an integration): its class, where it came through, what the controller says. */
  network?: {
    class: DeviceClass;
    facets: readonly DeviceFacet[];
    via: string;
    viaTitle: string;
    account: string;
    auto: boolean;
    model: string;
    mac: string;
    presence: "present" | "gone" | "unread";
    firmware?: string;
    state?: string;
    uplink?: string;
    deviceId: string;
  };
  /** Spec 110-network-assets FR-006: the client of the router this machine matches (by MAC, or by address), as the API gives it. */
  client?: {
    by: "mac" | "address";
    ip?: string;
    uplink?: string;
    guest?: boolean;
    connectedAt?: string;
    kind: string;
  };
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
  /** The fleet's tags (spec 108-tags FR-014): the dimensions with how many machines hold each tag, and the free-form tags apart. */
  tagging?: TaggingView;
  /** Adopted machines with their observations and policies. */
  adopted: Array<{ machine: AdoptedDef; observed?: Observed; results: PolicyResult[] }>;
  /** Every cloud provider. */
  clouds: PcConnector[];
  /** Spec 085: the cross-system policies over the estate graph. */
  estate?: PolicyResult[];
  /** Spec 078: the fleet's own control packs (fleets/<fleet>/controls/), with their results. */
  controls?: PackRun[];
  /** Devices read over SNMPv3, with their policies. */
  devices: Array<{
    device: DeviceDef;
    observed?: DeviceObserved;
    results: PolicyResult[];
  }>;
  /**
   * Spec 110-network-assets FR-008: the network, present only where a router-kind integration is connected (the Network page and its
   * menu entry exist only then).
   */
  network?: {
    view: NetworkView;
    connectors: Array<{ id: string; title: string; account: string }>;
  };
  /**
   * Spec 111-network-posture FR-014, FR-015: the posture of the network (the pack's results), present where a router is connected: the
   * Network posture card, `fleet status`'s group and the evidence of `stolos compliance`.
   */
  networkPosture?: PostureRun;
  /** The signers. */
  signers: Array<{ name: string; role: string; added: string; key: string }>;
  /** The repository: uncommitted files, commits servers would refuse, recent history. */
  git: { dirty: string[]; unapproved: string[]; log: PcCommit[]; diff?: string };
}

const warn =
  (what: string) =>
  (e: unknown): undefined => {
    ui.say(`warning: ${what}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  };

/** A verify record's checks that did not pass; an older record has only names (and no fixes). */
export function attentionFrom(v: RecordedVerify): Attention[] {
  if (v.attention?.length) return v.attention;
  const word =
    (level: Attention["level"]) =>
    (resource: string): Attention => ({
      resource,
      level,
      output: "",
      fix: "",
    });
  return [
    ...v.failed.map(word("fail")),
    ...(v.warned ?? []).map(word("warn")),
    ...(v.pending ?? []).map(word("pending")),
  ];
}

/** Gather the facts (each part on its own: a broken part leaves the rest). */
export async function pcFacts(repo = P.repo): Promise<PcFacts> {
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const { getRecord } = await import("../state/store.ts");
  const { loadAdopted } = await import("../adopt/adopt.ts");
  const { policies } = await import("../adopt/policy.ts");
  const { allConnectors, loadObservations } = await import("../connect/commands.ts");
  const { connectorCredPath } = await import("../connect/connector.ts");
  const { PIN_FILE, readPin } = await import("../fleet/upgrade.ts");
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
    const v = await getRecord<RecordedVerify>(h.name, "verify", "latest", P.state).catch(
      warn(`${h.name} verify record`),
    );
    const latest = v?.body && (!inst?.at || v.body.since >= inst.at) ? v.body : undefined;
    const checks =
      latest ??
      (inst?.body.checks
        ? {
            passed: inst.body.checks.passed,
            total: inst.body.checks.total,
            failed: [] as string[],
            warned: [] as string[],
          }
        : undefined);
    const server = h.kind !== "workstation";
    const applied = await getRecord<{ commit: string; subject: string; at: string }>(
      h.name,
      "applied",
      "latest",
      P.state,
    ).catch(warn(`${h.name} applied record`));
    const sync = await getRecord<{ at: string; blocked?: string }>(
      h.name,
      "sync",
      "latest",
      P.state,
    ).catch(warn(`${h.name} sync record`));
    machines.push({
      name: h.name,
      kind: server ? "server" : "workstation",
      joined: "managed",
      os: "Ubuntu",
      ...(h.ip ? { where: h.ip } : {}),
      ...(inst?.at ? { seen: inst.at } : {}),
      ...(checks ? { score: { pass: checks.passed, total: checks.total } } : {}),
      failing: latest?.failed ?? [],
      ...(latest ? { attention: attentionFrom(latest) } : {}),
      ...(!v && !inst ? { notAsked: true } : {}),
      ...(applied?.body ? { applied: applied.body } : {}),
      ...(sync?.body
        ? {
            sync: {
              at: sync.body.at,
              ...(sync.body.blocked ? { blocked: sync.body.blocked } : {}),
            },
          }
        : {}),
      ...(server && domain ? { console: `https://${h.name}.${domain}/` } : {}),
    });
  }
  const now = Date.now();
  const adopted = ((await loadAdopted().catch(warn("adopted machines"))) ?? []).map((a) => ({
    ...a,
    results: policies(a.machine, a.observed, now),
  }));
  const { controllerName } = await import("../adopt/controller.ts");
  const me = await controllerName().catch(() => "");
  for (const a of adopted) {
    const pass = a.results.filter((r) => r.status === "pass").length;
    const way = wayOfJoining({
      kind: "adopted",
      ...(a.machine.role ? { role: a.machine.role } : {}),
      ...(a.machine.joined ? { joined: a.machine.joined } : {}),
    });
    machines.push({
      name: a.machine.name,
      kind: "adopted",
      ...(way ? { joined: way } : {}),
      ...(a.machine.role === "controller"
        ? { controller: true, ...(a.machine.name === me ? { thisPc: true } : {}) }
        : {}),
      ...(a.observed ? { os: `${a.observed.os.name} ${a.observed.os.version}`.trim() } : {}),
      where: a.machine.ssh.address,
      ...(a.machine.owner ? { owner: a.machine.owner } : {}),
      ...(a.machine.title ? { title: a.machine.title } : {}),
      ...(a.observed?.os.serial ? { serial: a.observed.os.serial } : {}),
      ...(a.observed ? { seen: a.observed.at } : {}),
      score: { pass, total: a.results.length },
      failing: a.results
        .filter((r) => r.status === "fail" && !isNeverObserved(r))
        .map((r) => r.title),
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
      joined: "integrated",
      os: d.observed?.model ?? d.device.kind,
      where: d.device.address,
      ...(d.device.owner ? { owner: d.device.owner } : {}),
      ...(d.device.title ? { title: d.device.title } : {}),
      ...(d.observed?.serial ? { serial: d.observed.serial } : {}),
      ...(d.observed ? { seen: d.observed.at } : {}),
      score: { pass: d.results.filter((r) => r.status === "pass").length, total: d.results.length },
      failing: d.results
        .filter((r) => r.status === "fail" && !isNeverObserved(r))
        .map((r) => r.title),
    });
  }
  // Spec 110-network-assets: the devices a router's controller manages that the fleet adopted, and what the router says of the clients.
  let network: PcFacts["network"];
  try {
    const { loadNetwork } = await import("../connect/network-commands.ts");
    const { allConnectors } = await import("../connect/commands.ts");
    const n = await loadNetwork();
    const all = await allConnectors();
    if (n.connected.length) {
      network = {
        view: n.view,
        connectors: n.connected.map((id) => ({
          id,
          title: all.find((c) => c.id === id)?.title ?? id,
          account: n.view.connectors.find((c) => c.id === id)?.account ?? "",
        })),
      };
    }
    for (const st of n.view.assets) {
      const a = st.asset;
      const title = all.find((c) => c.id === a.via)?.title ?? a.via;
      const d = st.device;
      const results = (await import("../connect/network-asset.ts")).assetPolicies(st);
      machines.push({
        name: a.name,
        kind: "device",
        joined: "integration",
        os: d?.model ?? a.model,
        where: d?.ip ?? "",
        ...(a.owner ? { owner: a.owner } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.serial ? { serial: a.serial } : {}),
        seen: n.view.connectors.find((c) => c.id === a.via)?.at ?? a.adopted,
        score: { pass: results.filter((r) => r.status === "pass").length, total: results.length },
        failing: results
          .filter((r) => r.status === "fail" || r.status === "warn")
          .map((r) => r.detail),
        network: {
          class: a.class,
          facets: d?.facets ?? [],
          via: a.via,
          viaTitle: title,
          account: a.account,
          auto: a.auto === true,
          model: d?.model ?? a.model,
          mac: a.mac,
          presence: st.presence,
          ...(d ? { firmware: d.firmware, state: d.state } : {}),
          ...(d?.uplink
            ? { uplink: n.view.devices.find((r) => r.device.id === d.uplink)?.device.name ?? "" }
            : {}),
          deviceId: a.deviceId,
        },
      });
    }
  } catch (e) {
    warn("the network")(e);
  }
  // Spec 111-network-posture FR-014: the posture of the network, from the same observations and records.
  let networkPosture: PostureRun | undefined;
  if (network) {
    try {
      const { loadPosture } = await import("../connect/network-check.ts");
      networkPosture = (await loadPosture()).run;
    } catch (e) {
      warn("the network posture")(e);
    }
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
  for (const c of await allConnectors()) {
    const o = observed.find((x) => x.provider === c.id);
    clouds.push({
      id: c.id,
      title: c.title,
      logo: c.logo,
      connected: await fs.exists(connectorCredPath(c.id)),
      ...(o ? { observed: o } : {}),
      results: o ? c.policies(o, now) : [],
    });
    for (const a of o?.assets ?? []) {
      if (!o) continue;
      if (!["server", "ec2-instance"].includes(a.kind) || a.fleetMachine) continue;
      machines.push({
        name: a.name,
        kind: "cloud",
        joined: "cloud",
        where: `${c.title}${a.where ? `, ${a.where}` : ""}`,
        seen: o.at,
        failing: [],
        ...((image) => (typeof image === "string" ? { os: image } : {}))(a.facts?.["image"]),
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
  const git = (args: string[]): ReturnType<typeof run> => run(["git", "-C", repo, ...args]);
  const dirty = (await git(["status", "--porcelain"])).stdout.split("\n").filter(Boolean);
  // What Apply would commit (tracked files; new files are listed above), at most 400 lines.
  const diffText = dirty.length
    ? (await git(["diff", "HEAD", "--no-color"])).stdout.split("\n").slice(0, 400).join("\n")
    : "";
  const { unapproved } = await import("../fleet/apply.ts");
  const pending = (await unapproved(git, repo).catch(warn("unapproved commits"))) ?? [];
  const waiting = new Set(pending.map((l) => l.split(" ")[0]));
  const log = (await git(["log", "-20", "--format=%H%x09%s%x09%an%x09%cI"])).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha = "", subject = "", author = "", at = ""] = l.split("\t");
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
  // Spec 108-tags FR-014: every machine's tags, and the fleet's tags with their counts.
  const { loadFleetTags, taggingView } = await import("../fleet/tags.ts");
  const ft = await loadFleetTags({
    ...(fleet ? { fleet } : {}),
    hosts,
    adopted: adopted.map((a) => ({
      machine: a.machine,
      ...(a.observed ? { observed: a.observed } : {}),
    })),
  }).catch(warn("tags"));
  if (ft) {
    for (const m of machines) {
      const t = ft.machines.find((x) => x.name === m.name);
      if (t?.resolved.tags.length) m.tags = t.resolved.tags;
      if (t?.resolved.claims.length) m.says = t.resolved.claims;
      if (t?.resolved.disagreements.length)
        m.disagreements = t.resolved.disagreements.map((d) => d.text);
      if (t?.report) m.reportedAt = t.report.at;
      if (t?.claimsDropped) m.claimsDropped = t.claimsDropped;
    }
  }
  // Spec 115-compatibility FR-009: each machine against this PC's contract, from what it last reported (nobody is asked here).
  try {
    const { fleetCompat } = await import("../observe/compat.ts");
    const list = await fleetCompat({
      ...(fleet ? { fleet } : {}),
      hosts,
      adopted: adopted.map((a) => ({
        machine: a.machine,
        ...(a.observed ? { observed: a.observed } : {}),
      })),
    });
    for (const c of list) {
      const m = machines.find((x) => x.name === c.name);
      if (!m) continue;
      m.compat = {
        status: c.judgement.status,
        headline: c.words.headline,
        detail: c.words.detail,
        ...(c.words.fix ? { fix: c.words.fix } : {}),
        ...(c.words.code ? { code: c.words.code } : {}),
        ...(c.judgement.engine ? { engine: c.judgement.engine } : {}),
        ...(c.reportedAt ? { reportedAt: c.reportedAt } : {}),
        seams: c.judgement.seams.map((x) => ({
          seam: x.seam,
          status: x.status,
          ...(x.machine ? { machine: x.machine } : {}),
          pc: x.pc,
          needs: x.needs,
        })),
        ...(c.holdWords ? { held: c.holdWords } : {}),
      };
    }
  } catch (e) {
    warn("compatibility")(e);
  }
  // Spec 110-network-assets FR-006: the client of the router that each machine matches, as the API gives it.
  for (const [name, mt] of network?.view.matches ?? []) {
    const m = machines.find((x) => x.name === name);
    if (!m) continue;
    const c = mt.client;
    m.client = {
      by: mt.by,
      kind: c.kind,
      ...(c.ip ? { ip: c.ip } : {}),
      ...(mt.uplinkName ? { uplink: mt.uplinkName } : {}),
      ...(c.guest !== undefined ? { guest: c.guest } : {}),
      ...(c.connectedAt ? { connectedAt: c.connectedAt } : {}),
    };
  }
  const tagging = ft
    ? {
        ...taggingView(ft.set, ft.error, machines),
        problems: ft.machines.flatMap((x) => x.resolved.problems),
      }
    : undefined;
  const { loadEstate } = await import("../estate/commands.ts");
  const { estatePolicies } = await import("../estate/graph.ts");
  const estate = await loadEstate().catch(warn("the estate graph"));
  const pin = readPin((await fs.readTextOr(path.join(repo, PIN_FILE))) ?? "");
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
    ...(network ? { network } : {}),
    ...(networkPosture ? { networkPosture } : {}),
    ...(tagging ? { tagging } : {}),
    adopted,
    clouds,
    devices,
    estate: (() => {
      try {
        return estate ? estatePolicies(estate) : [];
      } catch (e) {
        warn("the estate graph")(e);
        return [];
      }
    })(),
    controls: await (async () => {
      try {
        const { runFleetPacks } = await import("../controls/run.ts");
        const r = await runFleetPacks({
          ...(estate ? { estate } : {}),
          adopted,
          devices,
          connectors: observed.map((o) => ({ connector: o.provider, observed: o })),
        });
        for (const x of r.problems) warn("control packs")(new Error(x));
        // Spec 077: the people controls, when the fleet keeps people files.
        const people = estate
          ? await (async () => {
              const { peoplePackRun } = await import("../people/commands.ts");
              const { loadAccepted } = await import("../controls/run.ts");
              return await peoplePackRun(estate, {
                accepted: await loadAccepted().catch(() => []),
              });
            })().catch(warn("people controls"))
          : undefined;
        // Spec 080: the risk register and vendor inventory, as a pack of their own.
        const risk = estate
          ? await (async () => {
              const { fleetRisk } = await import("../risk/fleet.ts");
              return (await fleetRisk(estate, { adopted })).run;
            })().catch(warn("the risk register"))
          : undefined;
        return [...r.runs, ...(people ? [people] : []), ...(risk ? [risk] : [])];
      } catch (e) {
        warn("control packs")(e);
        return [];
      }
    })(),
    signers,
    git: { dirty, unapproved: pending, log, ...(diffText ? { diff: diffText } : {}) },
  };
}
