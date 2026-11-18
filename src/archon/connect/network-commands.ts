/**
 * Spec 110-network-assets: `stolos network discover | adopt | status`, and what `stolos estate observe` and `stolos host release` do for
 * network assets. A device a router's controller manages is **discovered** (read from the last observation, no SSH, no probe),
 * **adopted** (a record in the fleet, one signed commit through `stolos apply` as `stolos tag add` sends its change), refreshed at every
 * observation, and **released** only when a person says so; a device that disappears from the controller is a warning, never a deletion.
 *
 * ```mermaid
 * flowchart LR
 *   observe["stolos estate observe unifi"] --> disc["network discover: not adopted yet"]
 *   disc --> adopt["network adopt: names, MACs, --all [--class c]"]
 *   adopt --> write["adopted/&lt;name&gt;/network.ts"] --> apply["stolos apply: one signed commit"]
 *   observe --> rules["network.ts autoAdopt"] --> write
 *   observe --> gone["gone from the integration: a warning"]
 *   release["stolos host release"] --> rm["the record goes; the controller is untouched"]
 * ```
 *
 * @module
 */
// Spec: 110-network-assets FR-003, FR-004, FR-005, FR-006, FR-009

import { fs, path, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import type { Observation } from "./connector.ts";
import {
  assetDir,
  assetFile,
  autoAdoptChoices,
  chooseDevices,
  goneFix,
  loadNetworkAssets,
  loadNetworkConfig,
  loadReleased,
  type NetworkAssetDef,
  networkAssetSource,
  notAdopted,
  type ObservedDevice,
  observedDevices,
  planAdoption,
  releasedFile,
  releasedSource,
} from "./network-asset.ts";
import { CLASS_LABEL, CLASS_PLURAL, parseClass } from "./network-class.ts";
import { buildNetworkView, type MachineKey, type NetworkView } from "./network-view.ts";

const fail = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** The observations of the connectors that are routers (spec 109: `integrationKinds` has `router`), as last written. */
export async function routerObservations(): Promise<{
  observations: Observation[];
  routers: string[];
  connected: string[];
}> {
  const { allConnectors, loadObservations } = await import("./commands.ts");
  const { connectorCredPath } = await import("./connector.ts");
  const routers = (await allConnectors()).filter((c) => c.integrationKinds?.includes("router"));
  const connected: string[] = [];
  for (const c of routers) if (await fs.exists(connectorCredPath(c.id))) connected.push(c.id);
  const ids = new Set(routers.map((c) => c.id));
  const observations = (await loadObservations().catch(() => [])).filter((o) =>
    ids.has(o.provider),
  );
  return { observations, routers: [...ids], connected };
}

/** The machines a client may be matched to: managed hosts (their MAC and address), adopted machines (the MACs they checked in with, their SSH address). */
export async function machineKeys(): Promise<MachineKey[]> {
  const out: MachineKey[] = [];
  try {
    const { loadHosts } = await import("../model/load.ts");
    for (const h of await loadHosts().catch(() => [])) {
      out.push({
        name: h.name,
        ...(h.mac ? { macs: [h.mac] } : {}),
        ...(h.ip ? { address: h.ip } : {}),
      });
    }
    const { loadAdopted } = await import("../adopt/adopt.ts");
    for (const a of await loadAdopted().catch(() => [])) {
      out.push({
        name: a.machine.name,
        ...(a.machine.macs?.length ? { macs: a.machine.macs } : {}),
        address: a.machine.ssh.address,
      });
    }
  } catch {
    // Matching is a courtesy: a fleet that cannot list its machines still shows its network.
  }
  return out;
}

/** What the network is now, for a command, the console or the tags: the view, and which router connectors are connected. */
export async function loadNetwork(): Promise<{
  view: NetworkView;
  assets: NetworkAssetDef[];
  connected: string[];
}> {
  const { observations, connected } = await routerObservations();
  const assets = await loadNetworkAssets().catch(() => []);
  const view = buildNetworkView({ observations, assets, machines: await machineKeys() });
  return { view, assets, connected };
}

/** The names a new asset may not take: every host, adopted machine, discovered machine and asset of the fleet. */
async function takenNames(): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const { loadHosts } = await import("../model/load.ts");
    for (const h of await loadHosts().catch(() => [])) names.add(h.name);
    const { loadAdopted } = await import("../adopt/adopt.ts");
    for (const a of await loadAdopted().catch(() => [])) names.add(a.machine.name);
    const { loadDiscovered } = await import("../adopt/integrate.ts");
    for (const d of await loadDiscovered().catch(() => [])) names.add(d.name);
  } catch {
    // A fleet whose hosts do not load is told so by every other command.
  }
  for (const a of await loadNetworkAssets().catch(() => [])) names.add(a.name);
  return names;
}

/** A device as one row of a table. */
const rowOf = (d: ObservedDevice): Record<string, string> => ({
  name: d.name,
  class: CLASS_LABEL[d.class],
  model: d.model,
  firmware: d.firmware,
  address: d.ip,
  state: d.state,
});

/** `stolos network discover [--class c] [--json]`: what the connected router's controller manages that no asset records yet. */
export async function networkDiscover(o: { class?: string; json?: boolean } = {}): Promise<number> {
  const p = ui.phase("Discover");
  const cls = o.class === undefined ? undefined : parseClass(o.class);
  if (o.class !== undefined && cls === undefined) {
    p.fail(
      `${o.class} is not a device class`,
      "one of: gateway, switch, access-point, camera, recorder, door-controller, phone, other",
    );
    return fail();
  }
  const { view, connected } = await loadNetwork();
  if (!connected.length) {
    p.fail("no router is connected", "bun run stolos connect unifi");
    return fail();
  }
  if (!view.connectors.length) {
    p.fail("the connected router has not been observed yet", "bun run stolos estate observe unifi");
    return fail();
  }
  const found = view.discovered.filter((d) => cls === undefined || d.class === cls);
  if (o.json) {
    stdio.stdout.writeSync(
      `${JSON.stringify(
        found.map((d) => ({
          via: d.via,
          account: d.account,
          id: d.id,
          name: d.name,
          mac: d.mac,
          class: d.class,
          facets: d.facets,
          model: d.model,
          firmware: d.firmware,
          address: d.ip,
          state: d.state,
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  p.done(
    found.length
      ? `${found.length} device${found.length === 1 ? "" : "s"} discovered via ${view.connectors.map((c) => c.id).join(", ")}, not adopted yet`
      : "nothing new: every device the controller manages is adopted",
  );
  if (found.length) {
    const { table } = await import("../state/query.ts");
    stdio.stdout.writeSync(`${table(found.map(rowOf))}\n`);
    ui.next.push(
      "adopt some: bun run stolos network adopt <device>...   (or --all, or --all --class switch)",
    );
  }
  return 0;
}

/** What adopting is given besides the devices: where the change is sent. */
export interface NetworkAdoptOptions {
  /** Devices by name, MAC or id at the controller. */
  devices?: readonly string[];
  /** Every discovered device. */
  all?: boolean;
  /** Only this class (with `all`). */
  class?: string;
  /** Write, and leave the sending to `stolos apply`. */
  noApply?: boolean;
  /** Replaces the commit's message. */
  message?: string;
}

/** What adopting needs from outside (a test passes its own apply). */
export interface NetworkAdoptDeps {
  /** Sends the change: `stolos apply` with the message. */
  apply?: (message: string) => Promise<number>;
}

/** The uncommitted files that a network commit may not carry: anything besides the observations and the network records. */
async function otherChanges(): Promise<string[]> {
  const { porcelainPath } = await import("../fleet/records.ts");
  const out = (
    await run(["git", "-C", P.repo, "status", "--porcelain", "--untracked-files=all"])
  ).stdout
    .split("\n")
    .filter(Boolean)
    .map(porcelainPath);
  const fleet = `fleets/${P.fleetId}/`;
  return out.filter(
    (f) =>
      !(
        f.startsWith(`${fleet}estate/`) ||
        f.startsWith(`${fleet}adopted/`) ||
        f === `${fleet}network-released.ts`
      ),
  );
}

/**
 * `stolos network adopt <device...> | --all [--class c]`: adopt devices the controller manages as assets of the fleet: one record each,
 * written to `adopted/<name>/network.ts`, and one signed commit through `stolos apply` (`--no-apply` leaves it written). No SSH, no probe.
 */
export async function networkAdopt(
  o: NetworkAdoptOptions,
  deps: NetworkAdoptDeps = {},
): Promise<number> {
  const p = ui.phase("Adopt");
  const cls = o.class === undefined ? undefined : parseClass(o.class);
  if (o.class !== undefined && cls === undefined) {
    p.fail(
      `${o.class} is not a device class`,
      "one of: gateway, switch, access-point, camera, recorder, door-controller, phone, other",
    );
    return fail();
  }
  const names = (o.devices ?? []).map((x) => x.trim()).filter(Boolean);
  if (!names.length && !o.all) {
    p.fail(
      "no device given",
      "stolos network adopt <device>... or --all [--class switch] (stolos network discover lists them)",
    );
    return fail();
  }
  if (names.length && o.all) {
    p.fail("name devices, or --all, not both", "stolos network adopt --all --class switch");
    return fail();
  }
  if (cls !== undefined && !o.all) {
    p.fail("--class goes with --all", "stolos network adopt --all --class switch");
    return fail();
  }
  const { view, connected, assets } = await loadNetwork();
  if (!connected.length) {
    p.fail("no router is connected", "bun run stolos connect unifi");
    return fail();
  }
  if (!view.connectors.length) {
    p.fail("the connected router has not been observed yet", "bun run stolos estate observe unifi");
    return fail();
  }
  const all = view.devices.map((r) => r.device);
  let chosen: ObservedDevice[];
  if (o.all) {
    chosen = notAdopted(all, assets).filter((d) => cls === undefined || d.class === cls);
    if (!chosen.length) {
      p.done("nothing to adopt: every device the controller manages is adopted");
      return 0;
    }
  } else {
    const found = chooseDevices(all, names);
    for (const m of found.missing) {
      p.fail(
        `${m}: the controller does not report a device by that name, MAC or id`,
        "stolos network discover lists them (stolos estate observe unifi reads them again)",
      );
    }
    const already = found.chosen.filter((d) => !notAdopted([d], assets).length);
    for (const d of already) {
      p.fail(
        `${d.name} is already adopted (as ${assets.find((a) => a.deviceId === d.id)?.name ?? "an asset"})`,
        "stolos tag add <name> ... changes its tags",
      );
    }
    if (found.missing.length || already.length) return fail();
    chosen = found.chosen;
  }
  const plan = planAdoption(chosen, await takenNames());
  for (const r of plan.refused) p.fail(r.why, "nothing was written for it");
  if (!plan.records.length) return fail();
  if (!o.noApply) {
    const others = await otherChanges();
    if (others.length) {
      p.fail(
        `uncommitted changes (${others.slice(0, 3).join(", ")}${others.length > 3 ? ", ..." : ""}): an adoption commit holds the adoption only`,
        "bun run stolos apply (or set them aside), then run this again; or --no-apply to write it now and send it later",
      );
      return fail();
    }
  }
  for (const r of plan.records) {
    await fs.mkdir(assetDir(r.name), { recursive: true });
    await fs.writeTextFile(assetFile(r.name), networkAssetSource(r));
  }
  p.done(
    `${plan.records.length} adopted via ${[...new Set(plan.records.map((r) => r.via))].join(", ")}: ${plan.records
      .map((r) => `${r.name} (${CLASS_LABEL[r.class].toLowerCase()})`)
      .join(", ")}`,
  );
  const text =
    o.message ?? `110-network-assets: adopt ${plan.records.map((r) => r.name).join(" ")}`;
  if (o.noApply) {
    ui.next.push(`send it: bun run stolos apply -m ${JSON.stringify(text)}`);
    return fail();
  }
  const apply =
    deps.apply ??
    (async (m: string) => (await import("../fleet/apply.ts")).fleetApply({ message: m }));
  return (await apply(text)) || fail();
}

/**
 * What `stolos estate observe` does for assets after it read the router connectors (spec 110-network-assets FR-004, FR-005): writes the
 * records the fleet's `autoAdopt` rules choose (a signed commit through `stolos apply` sends them: nothing is hidden), and warns of each
 * asset that is gone from the integration, with its fix. Returns the names it adopted.
 */
export async function afterObserve(): Promise<string[]> {
  const { observations, connected } = await routerObservations();
  if (!connected.length || !observations.length) return [];
  const p = ui.phase("Network assets");
  const { config, error } = await loadNetworkConfig();
  if (error) p.warn(error, "fix fleets/<fleet>/network.ts, then run stolos estate observe again");
  const assets = await loadNetworkAssets().catch(() => []);
  const devices = observations.flatMap(observedDevices);
  const choices = autoAdoptChoices(config, devices, assets, await loadReleased().catch(() => []));
  const plan = planAdoption(choices, await takenNames(), { auto: true });
  for (const r of plan.refused) p.warn(r.why, "the rule did not adopt it");
  for (const r of plan.records) {
    await fs.mkdir(assetDir(r.name), { recursive: true });
    await fs.writeTextFile(assetFile(r.name), networkAssetSource(r));
  }
  if (plan.records.length) {
    p.note(
      `adopted by your rules (network.ts): ${plan.records.map((r) => `${r.name} (${r.class})`).join(", ")}`,
    );
    ui.next.push(
      `keep the adoption: bun run stolos apply -m "110-network-assets: auto-adopt ${plan.records.map((r) => r.name).join(" ")}"`,
    );
  }
  const view = buildNetworkView({
    observations,
    assets: [...assets, ...plan.records],
    machines: [],
  });
  for (const g of view.gone) {
    p.warn(
      `${g.asset.name} is gone from the integration: ${g.asset.via} no longer reports it. Fix: ${goneFix(g.asset)}`,
      goneFix(g.asset),
    );
  }
  p.done(
    `${assets.length + plan.records.length} asset${assets.length + plan.records.length === 1 ? "" : "s"}, ${view.discovered.length} discovered, ${view.gone.length} gone`,
  );
  return plan.records.map((r) => r.name);
}

/**
 * Release a network asset (`stolos host release <name>` where the name is one): its record goes, remembered in
 * `network-released.ts` so that a rule does not take it again; nothing at the controller changes. Undefined where `name` is not an asset.
 */
export async function releaseNetworkAsset(name: string): Promise<number | undefined> {
  const a = (await loadNetworkAssets().catch(() => [])).find((x) => x.name === name);
  if (a === undefined) return undefined;
  const p = ui.phase("Release");
  await fs.remove(assetDir(name), { recursive: true });
  const released = await loadReleased().catch(() => []);
  await fs.mkdir(path.dirname(releasedFile()), { recursive: true });
  await fs.writeTextFile(
    releasedFile(),
    releasedSource([
      ...released.filter((r) => !(r.via === a.via && r.deviceId === a.deviceId)),
      { via: a.via, deviceId: a.deviceId, name: a.name, at: new Date().toISOString() },
    ]),
  );
  p.done(`${name} released: its record is gone; nothing at the controller changed`);
  ui.outcome(`${name} released: its record is gone; nothing at the controller changed`);
  ui.next.push(`keep it: bun run stolos apply -m "110-network-assets: release ${name}"`);
  return fail();
}

/** The Network group of `stolos fleet status` and `stolos network status`: assets by class, discovered, gone (warnings with their fix). */
export async function showNetworkGroup(): Promise<void> {
  const { view, connected, assets } = await loadNetwork();
  if (!connected.length) return;
  const p = ui.phase("Network");
  for (const g of view.gone) {
    p.warn(
      `${g.asset.name} is gone from the integration: ${g.asset.via} no longer reports it. Fix: ${goneFix(g.asset)}`,
      goneFix(g.asset),
    );
  }
  for (const s of view.assets.filter((x) => x.presence === "present" && x.device)) {
    const d = s.device;
    if (d && d.state !== "ONLINE") {
      p.warn(
        `${s.asset.name} is ${d.state.toLowerCase()} at the controller`,
        "power or reconnect it",
      );
    }
  }
  const byClass = view.counts
    .filter((c) => c.adopted)
    .map((c) => `${c.adopted} ${CLASS_PLURAL[c.class]}`)
    .join(", ");
  p.done(
    [
      assets.length ? `${assets.length} adopted (${byClass})` : "no network assets adopted yet",
      view.discovered.length
        ? `${view.discovered.length} discovered via ${view.connectors.map((c) => c.id).join(", ")}, not adopted (stolos network discover)`
        : "",
      view.gone.length ? `${view.gone.length} gone from the integration` : "",
      view.unmanaged.length
        ? `${view.unmanaged.length} unmanaged device${view.unmanaged.length === 1 ? "" : "s"} on the network (stolos pair adopts a machine)`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
}

/** `stolos network status [--json]`: the Network group, and the unmanaged clients with the guidance of `stolos pair`. */
export async function networkStatus(json = false): Promise<number> {
  const { view, connected } = await loadNetwork();
  if (json) {
    stdio.stdout.writeSync(
      `${JSON.stringify(
        {
          connected,
          assets: view.assets.map((s) => ({
            name: s.asset.name,
            class: s.asset.class,
            via: s.asset.via,
            presence: s.presence,
            auto: s.asset.auto === true,
            ...(s.device
              ? { state: s.device.state, firmware: s.device.firmware, address: s.device.ip }
              : {}),
          })),
          discovered: view.discovered.map((d) => ({
            name: d.name,
            class: d.class,
            model: d.model,
          })),
          unmanaged: view.unmanaged.map((c) => ({ name: c.name, mac: c.mac, address: c.ip })),
          gaps: view.gaps,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (!connected.length) {
    ui.phase("Network").done("no router is connected (bun run stolos connect unifi)");
    return 0;
  }
  await showNetworkGroup();
  if (view.unmanaged.length) {
    const { table } = await import("../state/query.ts");
    stdio.stdout.writeSync(
      `\n  Unmanaged devices on the network (observed, never adopted from here; to bring a machine into the fleet run bun run stolos pair):\n${table(
        view.unmanaged.map((c) => ({
          name: c.name,
          kind: c.kind,
          address: c.ip ?? "",
          mac: c.mac ?? "",
        })),
      )}\n`,
    );
  }
  for (const g of view.gaps) ui.say(`not readable: ${g}`);
  return 0;
}
