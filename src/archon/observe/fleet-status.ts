/**
 * `stolos fleet status` (specs 021, 022): every server and workstation in the
 * model, its last install and verify as it says them now (spec 048: asked over
 * MCP, cached in this machine's archon.sql when it cannot be reached),
 * whether it is durable or ephemeral (spec 044), and how to reach and observe it. Works on the boot machine (which also knows
 * the addresses hosts installed from) and on any host.
 *
 * @module
 */
// Spec: 107-pairing-and-query FR-009
// Spec: 108-tags FR-015
// Spec: 112-machine-reported-tags FR-010, FR-013
// Spec: 115-compatibility FR-006, FR-008, FR-009, FR-012
// Spec: 110-network-assets FR-006, FR-009
// Spec: 117-adopted-in-status FR-001, FR-005

import { getRecord, putRecord } from "../state/store.ts";
import { callRemoteTool } from "./remote.ts";
import { mcpServers } from "../render/agent.ts";
import type { HostState } from "../state/state-command.ts";
import { P } from "../core/paths.ts";

import { ui } from "../core/ui.ts";
import { joinedMark, wayOfJoining } from "../adopt/joining.ts";
import { liveToken, loadTokens } from "../core/secrets.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { nextSteps } from "./next.ts";
import { showOtherMachines } from "./fleet-machines.ts";
import { describeData, hostData } from "../model/durable.ts";
import type { RecordedVerify } from "../state/verify.ts";
import { describeInventory, type Inventory } from "../state/inventory.ts";

interface Installed {
  installed?: string;
  ok?: boolean;
  checks?: { passed: number; total: number };
  problems?: Array<{ message: string }>;
}

/**
 * Spec 107-pairing-and-query FR-009: the controller PC first, marked as auto-adopted: it needs no pairing and is observed by the
 * local probe (nothing is asked of it over the network).
 */
async function showController(tagsOf: (name: string) => string): Promise<void> {
  try {
    const { loadAdopted } = await import("../adopt/adopt.ts");
    const { controllerName } = await import("../adopt/controller.ts");
    const me = await controllerName();
    for (const a of (await loadAdopted()).filter((x) => x.machine.role === "controller")) {
      ui.phase(a.machine.name).done(
        `${a.machine.name === me ? "this PC" : "controller PC"} · ${joinedMark(wayOfJoining({ kind: "adopted", role: "controller" }))}${
          a.observed ? ` · observed ${a.observed.at.slice(0, 16).replace("T", " ")}` : ""
        }${tagsOf(a.machine.name) ? ` · ${tagsOf(a.machine.name)}` : ""}`,
      );
    }
  } catch {
    // The controller's line is a courtesy: a fleet that cannot list its adopted machines still shows its hosts.
  }
}

/**
 * `stolos fleet status`: print each host's last install and verify (asked
 * live, or from the cache), its data class, and its next steps. Returns 0.
 */
export async function fleetStatus(): Promise<number> {
  const fleet = await loadFleet();
  const hosts = await loadHosts();
  const tokens = await loadTokens().catch(() => []);
  // Spec 108-tags FR-015: each machine's tags on its line, the free-form ones apart (`custom: pilot`).
  const { loadFleetTags, tagLine } = await import("../fleet/tags.ts");
  let ft = await loadFleetTags({ fleet, hosts }).catch(() => undefined);
  const tagsOf = (name: string): string => {
    const t = ft?.machines.find((m) => m.name === name)?.resolved.tags ?? [];
    return t.length ? `tags ${tagLine(t)}` : "";
  };
  await showController(tagsOf);
  // Spec 110-network-assets FR-009: the Network group (assets by class, discovered, gone from the integration).
  try {
    const { showNetworkGroup } = await import("../connect/network-commands.ts");
    await showNetworkGroup();
  } catch {
    // The network group is a courtesy: a fleet whose router cannot be read still shows its hosts.
  }
  if (!hosts.length) {
    // Spec 117-adopted-in-status FR-001: a fleet with no managed host still lists the machines it knows.
    await showOtherMachines(tagsOf);
    ui.next.push("no hosts yet: bun run stolos host add <name> (or workstation add, in WSL)");
    return 0;
  }
  // Spec 048: ask every server live (its MCP server, over SSH as ops), all at
  // once; keep each answer in this machine's state as the last one seen.
  const live = new Map<string, { ok: boolean; why?: string }>();
  const answered = new Set<string>();
  // Spec 047: each server's key is checked against Git (registration.ts).
  const netMatches = await import("../connect/network-commands.ts")
    .then(async (m) => (await m.loadNetwork()).view.matches)
    .catch(() => undefined);
  const { writeKnownHosts } = await import("../fleet/registration.ts");
  const knownHosts = await writeKnownHosts().catch((e) => {
    // Without it, ssh checks the servers against your own known_hosts only.
    ui.say(`warning: known_hosts.auto (from Git) not written: ${(e as Error).message}`);
    return undefined;
  });
  await Promise.all(
    hosts
      .filter((h) => h.kind !== "workstation")
      .map(async (h) => {
        const target = mcpServers([h], P.fleetId)[0]?.target;
        if (!target) return;
        const r = await callRemoteTool(
          target,
          "archon_state",
          { json: true },
          {
            timeoutMs: 15_000,
            ...(knownHosts === undefined ? {} : { knownHosts }),
          },
        );
        if (!r.ok) {
          live.set(h.name, { ok: false, why: r.text.split("\n").pop() ?? "" });
          return;
        }
        try {
          const st = JSON.parse(r.text) as HostState;
          if (st.install) {
            await putRecord(h.name, "install", "install", st.install.body, P.state, st.install.at);
          }
          if (st.verify) {
            await putRecord(h.name, "verify", "latest", st.verify, P.state, st.verify.since);
          }
          if (st.inventory) await putRecord(h.name, "inventory", "latest", st.inventory, P.state);
          // Spec 112-machine-reported-tags FR-010: what it says about itself, kept in this PC's cache (never committed).
          const { keepReport } = await import("../state/reported.ts");
          const inv = st.inventory;
          await keepReport(
            h.name,
            {
              at: st.at,
              ...(st.reported?.machineInfo ? { machineInfo: st.reported.machineInfo } : {}),
              ...(st.reported?.tags?.length ? { tags: st.reported.tags } : {}),
              // Spec 115-compatibility FR-006: its engine and seams, kept in the same record (bounded; no commit).
              ...(st.compat ? { compat: st.compat } : {}),
              ...(inv
                ? {
                    smbios: {
                      vendor: inv.vendor,
                      model: inv.model,
                      chassis: inv.chassis,
                      biosVendor: inv.biosVendor,
                    },
                  }
                : {}),
            },
            P.state,
          ).catch(() => false);
          // Spec 066: the commit it applies, and its last pull (the Stolos Console shows them).
          if (st.applied) await putRecord(h.name, "applied", "latest", st.applied, P.state);
          if (st.sync) await putRecord(h.name, "sync", "latest", st.sync, P.state, st.sync.at);
          live.set(h.name, { ok: true });
          answered.add(h.name);
        } catch {
          live.set(h.name, { ok: false, why: "unreadable answer" });
        }
      }),
  );
  // What the servers said just now is in the cache: the tags below are resolved with it.
  ft = await loadFleetTags({ fleet, hosts }).catch(() => ft);
  // Spec 115-compatibility FR-007: each server against this PC's contract, from what it reported (this cycle's, or its last).
  const { fleetCompat } = await import("./compat.ts");
  const compat = new Map(
    (await fleetCompat({ fleet, hosts, answered }).catch(() => [])).map((c) => [c.name, c]),
  );
  for (const h of hosts) {
    const p = ui.phase(h.name);
    const inst = await getRecord<Installed>(h.name, "install", "install", P.state);
    const rec: Installed = inst ? { ...inst.body, installed: inst.at } : {};
    let latest = (await getRecord<RecordedVerify>(h.name, "verify", "latest", P.state))?.body;
    const seen = live.get(h.name);
    if (seen && !seen.ok) {
      p.warn(`unreachable now (${seen.why}); showing what it said last`);
    }
    // The latest verify, when it is newer than the install, is what the host is now.
    if (latest && rec.installed && latest.since < rec.installed) latest = undefined;
    const t = tokens.find((x) => x.host === h.name);
    const kind = `${h.kind === "workstation" ? "workstation" : "server"} · ${joinedMark("managed")}`;
    // Spec 051: the machine, as it reports itself.
    const inv = (await getRecord<Inventory>(h.name, "inventory", "latest", P.state))?.body;
    if (inv) p.note(`machine: ${describeInventory(inv)}`);
    // Spec 112-machine-reported-tags FR-013: where the machine says another value than the fleet (the fleet wins; this is the finding).
    const me = ft?.machines.find((m) => m.name === h.name);
    // Spec 110-network-assets FR-006: what the router's API says of this server as a client (matched by MAC, else by address).
    const onNet = netMatches?.get(h.name);
    if (onNet) {
      p.note(
        `on the network: ${onNet.client.ip ?? "?"}${onNet.uplinkName ? ` through ${onNet.uplinkName}` : ""}${onNet.client.guest ? " (guest)" : ""}${onNet.client.connectedAt ? `, since ${onNet.client.connectedAt}` : ""}`,
      );
    }
    for (const d of me?.resolved.disagreements ?? []) {
      p.warn(
        d.text,
        `stolos tag list ${h.name} (if the machine is right: stolos tag accept ${h.name} ${d.reported})`,
      );
    }
    if (ui.verbose && me?.claimsDropped) {
      p.note(
        `gap: ${me.claimsDropped} thing(s) it said were not tags and were dropped (${me.gaps.join("; ")})`,
      );
    }
    if (ui.verbose && me?.resolved.ignored) {
      p.note(`${me.resolved.ignored} claim(s) ignored by the fleet's dimensions`);
    }
    // Spec 115-compatibility FR-008, FR-009, FR-012: the contract, in plain words; a problem says its fix and code, the rest only in a report.
    const cm = compat.get(h.name);
    if (cm?.judgement.status === "too-old" || cm?.judgement.status === "newer") {
      p.warn(cm.words.detail, cm.words.fix, cm.words.code);
    } else if (cm?.judgement.status === "unknown" && answered.has(h.name)) {
      p.action(cm.words.detail, cm.words.fix ?? "bun run stolos fleet status", cm.words.code);
    } else if (cm && ui.verbose) {
      p.note(`engine: ${cm.words.detail}`);
    }
    if (cm?.holdWords) p.note(cm.holdWords);
    if (latest) {
      for (const f of latest.failed) p.warn(`failing at its last verify: ${f}`);
      for (const w of latest.warned) p.note(`warning at its last verify: ${w}`);
    } else if (rec.ok === false) {
      for (const pr of rec.problems ?? []) p.warn(`at its last install: ${pr.message}`);
    }
    p.done(
      [
        kind,
        rec.installed
          ? `installed ${rec.installed.slice(0, 16).replace("T", " ")}${
              latest
                ? ` · ${latest.passed}/${latest.total} checks${
                    latest.warned.length ? `, ${latest.warned.length} warning(s)` : ""
                  } (verified ${latest.since.slice(0, 16).replace("T", " ")})`
                : rec.checks
                  ? ` · ${rec.checks.passed}/${rec.checks.total} checks at install`
                  : ""
            }${!latest && rec.ok === false ? " · with problems" : ""}`
          : "not installed yet",
        // Article 23: from the model here (the host itself says it live: archon data).
        h.kind === "workstation" ? "" : describeData(hostData(h)),
        tagsOf(h.name),
        liveToken(tokens, h.name) ? "armed for an install" : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
    ui.next.push(
      `${h.name}:`,
      ...nextSteps({
        host: h,
        fleet,
        ...((a) => (a === undefined ? {} : { address: a }))(t?.addresses?.at(-1)),
      }).map((l) => `  ${l}`),
    );
  }
  // Spec 117-adopted-in-status FR-001: then every other machine of the fleet, one line each.
  await showOtherMachines(tagsOf);
  ui.next.push("(live from each server over SSH; stolos fleet query asks them anything)");
  return 0;
}
