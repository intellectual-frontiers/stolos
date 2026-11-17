/**
 * Spec 097: the controller PC as a fleet machine. The PC that runs `stolos` holds every secret, the
 * signing keys and the backups, so an auditor asks about it first. It is recorded as an adopted
 * machine with the role `controller` (`fleets/<fleet>/adopted/<name>/machine.ts`, the name from its
 * hostname), and observed **locally**: the same probe scripts adopted machines run
 * (`bin/stolos-probe.sh`, `bin/stolos-probe.ps1`), started by Stolos itself. No SSH server, no
 * probe key, no listening port: adopting the controller adds no way in.
 *
 * On top of the probe's facts, the controller's own (`observed.controller`): whether the daily
 * signing key is locked by a passphrase and kept out of an ssh-agent, whether the latest
 * `vault backup` holds every secret as it is now, and whether the recovery key is in the vault and
 * was checked recently. The policy pack (policy.ts) reads them, with the usual ones (the disk is
 * encrypted, the firewall is on, ...), and adds one: no SSH server listening on the controller.
 *
 * A fleet may have several controllers (each signer's PC); each observes only itself.
 *
 * @module
 */
// Spec: 097-controller FR-001, FR-002, FR-003, FR-006
// Spec: 107-pairing-and-query FR-010
// Spec: 100-remote-access FR-012

import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import type { AdoptedDef, Observed } from "./adopt.ts";
import { PROBE_SCRIPT, PROBE_SCRIPT_WINDOWS } from "./probe.ts";

/** What only a controller's observation holds. */
export interface ControllerFacts {
  /** The daily signing key: locked by a passphrase, unlocked (none), or missing. */
  signingKey: "locked" | "unlocked" | "missing";
  /** The daily key is held by an ssh-agent (unlocked for anyone on this PC's session). */
  inAgent?: boolean;
  /** The secrets against the latest recorded backup: current, behind (something unbacked), or never. */
  backup: "current" | "behind" | "never";
  /** When the latest backup was recorded (ISO). */
  backupAt?: string;
  /** How many secrets the latest backup does not hold as they are now. */
  unbacked: number;
  /** A listed recovery key's private file is in the vault, so every backup holds it. */
  recoveryInVault: boolean;
  /** When the recovery key was last proven to work on this PC (ISO). */
  recoveryCheckedAt?: string;
  /**
   * Spec 100: remote access to the Stolos Console, when the fleet sets it up: the certificate's
   * expiry and the devices with no sign-in for 90 days.
   */
  remoteAccess?: { certificate?: string; devices: number; unused: number };
}

/** This PC's name in the fleet: its hostname as a DNS label. */
export async function controllerName(): Promise<string> {
  const { nameFor } = await import("./checkin.ts");
  return nameFor(proc.hostname());
}

/** Whether `m` is this PC (the one controller this PC can observe). */
export async function isThisController(m: AdoptedDef): Promise<boolean> {
  return m.role === "controller" && m.name === (await controllerName());
}

/** Run the probe on this PC, as the probe key would on an adopted machine. */
export async function localProbe(
  request: string,
  o: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; out: string; err: string }> {
  const windows = proc.build.os === "windows";
  const dir = await fs.makeTempDir({ prefix: "stolos-controller-probe-" });
  try {
    const file = path.join(dir, windows ? "stolos-probe.ps1" : "stolos-probe.sh");
    await fs.writeTextFile(file, windows ? PROBE_SCRIPT_WINDOWS : PROBE_SCRIPT);
    const argv = windows
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          file,
        ]
      : ["sh", file];
    // In its own folder: PowerShell may write a module cache to the current folder (spec 097 FR-002).
    const r = await run(argv, {
      cwd: dir,
      env: { SSH_ORIGINAL_COMMAND: request },
      ...(o.signal ? { signal: o.signal } : {}),
    });
    return { ok: r.ok, out: r.stdout, err: r.stderr.trim() };
  } finally {
    await fs.remove(dir, { recursive: true });
  }
}

/** The controller's own facts (keys, backup, recovery), read on this PC. */
export async function controllerFacts(): Promise<ControllerFacts> {
  const { collectKeyFacts } = await import("../identity/keys.ts");
  const { assess } = await import("../vault/state.ts");
  const k = await collectKeyFacts();
  const a = await assess();
  const { accessFacts } = await import("../access/commands.ts");
  const r = await accessFacts().catch(() => undefined);
  return {
    ...(r?.configured
      ? {
          remoteAccess: {
            ...(r.notAfter ? { certificate: r.notAfter } : {}),
            devices: r.devices,
            unused: r.unused,
          },
        }
      : {}),
    signingKey: !k.daily.exists ? "missing" : k.daily.passphrase === false ? "unlocked" : "locked",
    ...(k.daily.inAgent !== undefined ? { inAgent: k.daily.inAgent } : {}),
    backup: !a.lastBackup ? "never" : a.unbacked.length || a.removed.length ? "behind" : "current",
    ...(a.lastBackup?.at ? { backupAt: a.lastBackup.at } : {}),
    unbacked: a.unbacked.length,
    recoveryInVault: k.recoveryInStore,
    ...(k.state.recoveryCheckedAt ? { recoveryCheckedAt: k.state.recoveryCheckedAt } : {}),
  };
}

/** This PC's declaration as the fleet's controller. */
export async function controllerDef(existing?: AdoptedDef): Promise<AdoptedDef> {
  const name = await controllerName();
  const user = proc.env.get("USERNAME") ?? proc.env.get("USER") ?? "";
  return {
    name,
    title: existing?.title ?? `The fleet's controller PC (${proc.hostname()})`,
    ...(existing?.owner ? { owner: existing.owner } : {}),
    role: "controller",
    ssh: { user, address: proc.hostname() },
    hostKeys: [],
    adopted: existing?.adopted ?? new Date().toISOString(),
    ...(existing?.accepted ? { accepted: existing.accepted } : {}),
    // Spec 108-tags: the tags a person gave it are kept.
    ...(existing?.tags?.length ? { tags: existing.tags } : {}),
    ...(existing?.customTags?.length ? { customTags: existing.customTags } : {}),
  };
}

/**
 * Record this PC as the fleet's controller, once (spec 097): writes its machine.ts when it is not
 * there. Returns its name, or why it was not recorded (a managed server or another adopted machine
 * already has the name).
 */
export async function ensureController(): Promise<
  { name: string; added: boolean } | { why: string }
> {
  if (!P.fleetId || !(await fs.exists(P.fleetDir))) return { why: "no fleet here" };
  const { adoptedDir, loadAdopted, machineSource, MACHINE_NAME } = await import("./adopt.ts");
  const name = await controllerName();
  if (!MACHINE_NAME.test(name)) return { why: `this PC's hostname makes no name (${name})` };
  const { loadHosts } = await import("../model/load.ts");
  if ((await loadHosts()).some((h) => h.name === name)) {
    return { why: `${name} is a managed server in this fleet` };
  }
  const existing = (await loadAdopted()).find((a) => a.machine.name === name)?.machine;
  if (existing && existing.role !== "controller") {
    return { why: `${name} is already adopted as another machine` };
  }
  if (existing) return { name, added: false };
  await fs.mkdir(adoptedDir(name), { recursive: true });
  await fs.writeTextFile(
    path.join(adoptedDir(name), "machine.ts"),
    machineSource(await controllerDef()),
  );
  return { name, added: true };
}

/** Whether an observation is a controller's (it carries the controller's facts). */
export function hasController(o: Observed): o is Observed & { controller: ControllerFacts } {
  return o.controller !== undefined;
}

/**
 * Record this PC as the controller (when it is not yet) and observe it now, quietly: run by
 * `fleet init`, `keys setup` and `pair` (spec 097). It never fails the command that runs it; it
 * says what it did, and what to keep, in the next steps.
 */
export async function recordController(): Promise<void> {
  try {
    const c = await ensureController();
    if (!("name" in c)) return;
    const { adoptedDir, loadAdopted, observe, observedSource } = await import("./adopt.ts");
    const m = (await loadAdopted()).find((a) => a.machine.name === c.name)?.machine;
    if (!m) return;
    const r = await observe(m);
    if (r.observed) {
      await fs.writeTextFile(
        path.join(adoptedDir(c.name), "observed.ts"),
        observedSource(r.observed),
      );
    }
    const { ui } = await import("../core/ui.ts");
    if (c.added) {
      ui.next.push(
        `this PC is now in the fleet as ${c.name} (the controller, observed locally): bun run stolos host check ${c.name}`,
      );
    }
  } catch {
    // Recording the controller is a convenience here; host observe reports any problem plainly.
  }
}
