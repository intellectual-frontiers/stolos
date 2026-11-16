/**
 * `stolos validate` and `stolos build` (spec 002): validate the fleet and
 * every host plan (TypeScript, Article 10), then render each host's files into
 * out/hosts/<host>/rootfs/. Deterministic: building twice changes nothing.
 *
 * @module
 */

import { lf } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { listFleets, P } from "./core/paths.ts";
import { engineSpecs } from "./core/assets.ts";
import { ui } from "./core/ui.ts";
import { loadFleet, loadHosts, NoFleetError } from "./model/load.ts";
import { resolvePlan } from "./model/resolve.ts";
import { type Problem, validateFleet, validatePlan } from "./model/validate.ts";
import type { FleetDef, HostDef, HostPlan } from "./model/types.ts";

/** The fleet as loaded, resolved, and validated. */
export interface Model {
  /** The fleet (fleets/<id>/fleet.ts). */
  fleet: FleetDef;
  /** Every host. */
  hosts: HostDef[];
  /** Each host's resolved plan (what it should have). */
  plans: HostPlan[];
  /** Every problem found; empty when the model is valid. */
  problems: Problem[];
}

/** Every spec ID the model may name: the engine's and the fleet repository's own. */
export async function knownSpecs(): Promise<Set<string>> {
  return new Set([...engineSpecs(), ...(await fs.listDirs(path.join(P.fleetDir, "specs")))]);
}

/** Load, resolve, and validate everything. Never throws for model problems. */
export async function loadModel(): Promise<Model> {
  const fleet = await loadFleet();
  const hosts = await loadHosts();
  const problems = validateFleet(fleet, hosts);
  problems.push(...(await signersFileProblems(fleet)));
  // Spec 047: registration.ts is written by stolos host add, in one form.
  const { registrationProblems } = await import("./fleet/registration.ts");
  for (const p of await registrationProblems(hosts.map((h) => h.name))) {
    problems.push({ ...p, fix: "write it again with stolos host add <host> (it keeps the keys)" });
  }
  // Spec 047: decisions.ts are written by stolos decide, in one form.
  const { decisionProblems } = await import("./fleet/decisions.ts");
  for (const f of await decisionProblems(hosts.map((h) => h.name))) {
    problems.push({
      where: f,
      message: "not in the form stolos decide writes",
      fix: "change it only with stolos decide (or copy that form exactly)",
    });
  }
  const specs = await knownSpecs();
  const plans: HostPlan[] = [];
  for (const h of hosts) {
    try {
      const plan = resolvePlan(h, fleet);
      problems.push(...validatePlan(plan, specs));
      plans.push(plan);
    } catch (e) {
      problems.push({
        where: `hosts/${h.name}`,
        message: (e as Error).message,
        fix: "fix the capability definitions",
      });
    }
  }
  problems.push(...(await dotfileProblems(fleet, hosts)));
  return { fleet, hosts, plans, problems };
}

/**
 * Spec 031: every dotfile layer names a host and a user in the model, and
 * every user's composition on every host is clean (no forbidden files, no two
 * sources for one target within a layer).
 */
export async function dotfileProblems(
  fleet: FleetDef,
  hosts: HostDef[],
  repo = P.repo,
): Promise<Problem[]> {
  const { strayLayers } = await import("./dotfiles/layers.ts");
  const { composeFrom } = await import("./dotfiles/sync.ts");
  const { usersFor } = await import("./model/load.ts");
  // Spec 046: the layers live in the fleet's folder (fleets/<id>/...).
  const root = path.join(repo, "fleets", P.fleetId);
  const hostDirs = [];
  for (const h of await fs.listDirs(path.join(root, "hosts"))) {
    if (await fs.exists(path.join(root, "hosts", h, "home"))) hostDirs.push(h);
  }
  const dirs = {
    hosts: hostDirs,
    users: await fs.listDirs(path.join(root, "users")),
    hostUsers: (
      await Promise.all(
        (await fs.listDirs(path.join(root, "hosts"))).map(async (h) =>
          (await fs.listDirs(path.join(root, "hosts", h, "users"))).map(
            (u) => [h, u] as [string, string],
          ),
        ),
      )
    ).flat(),
  };
  const hostUsers = new Map(hosts.map((h) => [h.name, usersFor(fleet, h).map((u) => u.name)]));
  const problems: Problem[] = strayLayers(dirs, hostUsers, P.fleetId).map((m) => ({
    where: m.split(":")[0] ?? m,
    message: m.slice(m.indexOf(":") + 2),
    fix: "rename or remove the layer, or add the host or user to the model",
  }));
  const seen = new Set<string>();
  for (const [h, users] of hostUsers) {
    for (const u of users) {
      for (const m of (await composeFrom(repo, h, u)).problems) {
        if (seen.has(m)) continue;
        seen.add(m);
        problems.push({
          where: m.split(":")[0] ?? m,
          message: m.slice(m.indexOf(":") + 2),
          fix: "see man archon-dotfiles",
        });
      }
    }
  }
  return problems;
}

/** Report problems through the calm UI; true when the model is valid. */
export function report(phase: ReturnType<typeof ui.phase>, m: Model): boolean {
  for (const p of m.problems) phase.fail(`${p.where}: ${p.message}`, p.fix);
  return m.problems.length === 0;
}

/** One host's resolved plan. */
export async function planFor(host: HostDef): Promise<HostPlan> {
  return resolvePlan(host, await loadFleet());
}

/** Render every host's files under out/hosts/<host>/rootfs/. Returns files written. */
export async function renderHosts(m: Model): Promise<number> {
  let written = 0;
  for (const plan of m.plans) {
    const root = path.join(P.out, "hosts", plan.host.name, "rootfs");
    const keep = new Set<string>();
    for (const f of plan.files) {
      if (f.content === undefined) continue;
      const rel = f.path.replace(/^\//, "");
      keep.add(rel);
      const target = path.join(root, rel);
      await fs.ensureDir(path.join(target, ".."));
      if (await fs.writeIfChanged(target, f.content)) written++;
    }
    // Files no longer in the plan are removed from out/ (rendered output only).
    if (await fs.exists(root)) {
      for (const rel of await fs.walkFiles(root)) {
        if (!keep.has(rel)) {
          await fs.remove(path.join(root, rel));
          written++;
        }
      }
    }
  }
  return written;
}

/**
 * Files generated from the registry and the model (spec 012): man pages under
 * out/<fleet>/man, and .mcp.json (spec 030), one MCP server per server host.
 */
export async function renderRepoFiles(m?: Model): Promise<number> {
  const { renderManPages } = await import("./render/man.ts");
  const { mcpServers, renderMcpJson } = await import("./render/agent.ts");
  const servers = m ? mcpServers(m.hosts, P.fleetId) : [];
  let written = 0;
  for (const [rel, content] of renderManPages()) {
    const target = path.join(P.man, rel);
    await fs.ensureDir(path.join(target, ".."));
    if (await fs.writeIfChanged(target, content)) written++;
  }
  const mcp = renderMcpJson(servers, {
    existing: await fs.readTextOr(P.mcpJson),
    fleet: P.fleetId,
    fleets: listFleets(P.repo),
  });
  if (await fs.writeIfChanged(P.mcpJson, mcp)) written++;
  return written;
}

/** Spec 028: the network reference, from the site model, under out/site/. */
export async function renderSite(m: Model): Promise<number> {
  if (!m.fleet.site) return 0;
  const { renderNetworkDoc } = await import("./render/network-doc.ts");
  const html = renderNetworkDoc(m.fleet.site, m.hosts, {});
  return (await fs.writeIfChanged(path.join(P.out, "site", "network-reference.html"), html))
    ? 1
    : 0;
}

/** `stolos build`: validate the model, then render every target into out/; true when it is valid. */
export async function build(): Promise<boolean> {
  const p = ui.phase("Model");
  let m: Model;
  try {
    m = await loadModel();
  } catch (e) {
    if (!(e instanceof NoFleetError)) throw e;
    // A fresh repository: the registry's files still render.
    const n = await renderRepoFiles();
    p.done(`no fleet yet (stolos fleet init) · ${n} repository file(s) rendered`);
    return true;
  }
  if (!report(p, m)) {
    p.done(`${m.problems.length} problem(s); nothing rendered`);
    return false;
  }
  const n = (await renderHosts(m)) + (await renderRepoFiles(m)) + (await renderSite(m));
  const names = m.hosts.map((h) => h.name).join(", ");
  p.done(`${names ? `${names} valid` : "valid, no hosts yet"} · ${n} rendered`);
  return true;
}

/** Spec 047: the signers are usable, and signers.ts is in the form archon writes. */
async function signersFileProblems(fleet: FleetDef): Promise<Problem[]> {
  const { signerProblems, signersFile, signersSource } = await import("./identity/signers.ts");
  const list = fleet.signers ?? [];
  const out: Problem[] = signerProblems(list).map((p) => ({ where: "signers", ...p }));
  const text = await fs.readTextOr(signersFile());
  // Line endings are Git's business (CRLF on a Windows checkout): the form is the text.
  if (text !== undefined && lf(text) !== signersSource(list)) {
    out.push({
      where: "signers",
      message: "signers.ts is not in the form archon writes",
      fix: "change it only with stolos signers add/remove (or copy that form exactly)",
    });
  }
  return out;
}
