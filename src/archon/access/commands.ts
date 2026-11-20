/**
 * Spec 100: the `stolos devices` commands and the console's names.
 *
 * - `stolos devices`: the approved devices (access.ts) with this PC's last sign-in of each.
 * - `stolos devices approve <code> [--controller <url>] [--yes]`: fetch a pending registration's
 *   public fields from the controller, show them, ask, write the device into access.ts with your
 *   own signer name as `approvedBy`, and send it (`stolos apply`, signed by your key).
 * - `stolos devices revoke <id> [--yes]`: remove it from access.ts and send that (signed).
 * - `consoleNamesSetup`: what `stolos console --lan` and `fleet init` do first: propose the
 *   names, ask, and write them into fleet.ts.
 *
 * @module
 */
// Spec: 100-remote-access FR-005, FR-008
// Spec: 103-three-ports FR-009

import type { AccessFacts } from "./doctor.ts";
import { fs, proc, stdio } from "@intellectual-frontiers/system";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { SECRETS } from "../core/secrets.ts";
import { ui } from "../core/ui.ts";
import type { ConsoleDevice, FleetDef, SignerDef } from "../model/types.ts";
import {
  accessFile,
  accessSource,
  accessStatePath,
  deviceOf,
  parseAccess,
  type Pending,
  readAccessState,
} from "./devices.ts";
import { consoleNames, proposedSettings, withStolosSettings } from "./names.ts";

/** The signers whose key is on this PC: the daily key Git signs with, and a recovery key in the store. */
export async function signersHere(
  signers: readonly SignerDef[],
  repo: string = P.repo,
): Promise<Set<string>> {
  const { keyPaths, pubOf } = await import("../identity/keys.ts");
  const key = (await run(["git", "-C", repo, "config", "--get", "user.signingkey"])).stdout.trim();
  const paths = keyPaths(key, repo);
  const pubs = new Set<string>();
  for (const f of [paths.daily + ".pub", paths.recovery + ".pub"]) {
    const p = pubOf(await fs.readTextOr(f));
    if (p) pubs.add(p);
  }
  return new Set(signers.filter((s) => pubs.has(pubOf(s.key) ?? s.key.trim())).map((s) => s.name));
}

/** The devices in this fleet's access.ts ([] when there is none). */
export async function loadDevices(fleetDir: string = P.fleetDir): Promise<ConsoleDevice[]> {
  return parseAccess((await fs.readTextOr(accessFile(fleetDir))) ?? "");
}

/** A pending registration's fields, checked (from the controller's JSON). */
export function pendingFrom(v: unknown): Pending | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const p = v as Record<string, unknown>;
  const c = p["credential"] as Record<string, unknown> | undefined;
  const s = (k: string): string | undefined => {
    const x = p[k];
    return typeof x === "string" ? x : undefined;
  };
  const code = s("code"),
    signer = s("signer"),
    deviceName = s("deviceName");
  if (
    !code ||
    !signer ||
    !deviceName ||
    !c ||
    typeof c["id"] !== "string" ||
    typeof c["publicKey"] !== "string" ||
    typeof c["alg"] !== "number"
  ) {
    return undefined;
  }
  const transports = Array.isArray(c["transports"])
    ? (c["transports"] as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;
  return {
    code,
    signer,
    deviceName: deviceName.slice(0, 60),
    credential: {
      id: c["id"],
      publicKey: c["publicKey"],
      alg: c["alg"],
      ...(transports?.length ? { transports } : {}),
    },
    backedUp: p["backedUp"] === true,
    from: s("from") ?? "",
    userAgent: (s("userAgent") ?? "").slice(0, 300),
    created: s("created") ?? new Date().toISOString(),
    expires: s("expires") ?? "",
  };
}

/** The controller to ask: the one given, else `https://stolos.<domain>`; plain HTTP only on 127.0.0.1. */
export function controllerUrl(
  given: string | undefined,
  fleet: Pick<FleetDef, "web" | "stolos">,
): string | { why: string } {
  if (given) {
    let u: URL;
    try {
      u = new URL(given);
    } catch {
      return { why: `--controller ${given} is not an address (https://stolos.<domain>)` };
    }
    const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(loop && u.protocol === "http:")) {
      return { why: "the controller is reached over HTTPS (plain HTTP only on 127.0.0.1)" };
    }
    return u.origin;
  }
  const n = consoleNames(fleet, "x");
  return n ? `https://${n.base}` : { why: "the fleet has no web domain: give --controller" };
}

/** Whether a console runs this command (its Run button was the person's yes). */
function fromConsole(): boolean {
  return proc.env.get("ARCHON_VIA") === "console";
}

/** Uncommitted files other than access.ts (an approval commit holds the approval only). */
async function otherChanges(repo: string, fleetId: string): Promise<string[]> {
  const { porcelainPath } = await import("../fleet/records.ts");
  const mine = `fleets/${fleetId}/access.ts`;
  return (await run(["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"])).stdout
    .split("\n")
    .filter(Boolean)
    .map(porcelainPath)
    .filter((f) => f !== mine);
}

/** Who approves: your own signer (the one whose key is on this PC; the daily one first). */
async function approver(signers: readonly SignerDef[]): Promise<string | undefined> {
  const here = await signersHere(signers);
  return (
    signers.find((s) => here.has(s.name) && s.role === "daily")?.name ??
    signers.find((s) => here.has(s.name))?.name
  );
}

/** Write access.ts and send it (stolos apply, signed); the exit code. */
async function writeAndApply(list: ConsoleDevice[], message: string): Promise<number> {
  await fs.writeTextFile(accessFile(P.fleetDir), accessSource(list));
  const { fleetApply } = await import("../fleet/apply.ts");
  return await fleetApply({ message });
}

/** `stolos devices approve <code>` (FR-005). `fetchImpl` is the network (tests pass their own). */
export async function devicesApprove(o: {
  code: string;
  controller?: string;
  yes?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const c = ui.phase("Approve");
  const { loadFleet } = await import("../model/load.ts");
  const { loadSigners } = await import("../identity/signers.ts");
  const fleet = await loadFleet();
  const signers = await loadSigners();
  const at = controllerUrl(o.controller, fleet);
  if (typeof at !== "string") {
    c.fail(at.why, "bun run stolos devices approve <code> --controller https://stolos.<domain>");
    return 1;
  }
  const me = await approver(signers);
  if (!me) {
    c.fail(
      "no key of a fleet signer is on this PC: an approval is signed by a signer",
      "bun run stolos keys (or approve it on a signer's PC)",
    );
    return 1;
  }
  const others = await otherChanges(P.repo, P.fleetId);
  if (others.length) {
    c.fail(
      `uncommitted changes (${others.slice(0, 3).join(", ")}${others.length > 3 ? ", ..." : ""}): an approval commit holds the approval only`,
      "bun run stolos apply (or set them aside), then run this again",
    );
    return 1;
  }
  c.status(`asking ${at}`);
  let pending: Pending | undefined;
  try {
    const r = await (o.fetchImpl ?? fetch)(
      `${at}/access/pending/${encodeURIComponent(o.code.trim())}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    pending = r.ok ? pendingFrom(await r.json()) : undefined;
    if (!r.ok) {
      c.fail(
        `${at} has no code ${o.code} (it expired after 15 minutes, or was denied)`,
        "the device registers again and shows a new code",
      );
      return 1;
    }
  } catch (e) {
    c.fail(
      `cannot reach ${at}: ${(e as Error).message}`,
      "is stolos console --lan running there, and is this PC on the site's network?",
    );
    return 1;
  }
  if (!pending) {
    c.fail(`${at} answered something that is not a registration`, "check --controller");
    return 1;
  }
  if (!signers.some((s) => s.name === pending.signer)) {
    c.fail(`${pending.signer} is not a signer of this fleet`, "deny it on the Remote Access page");
    return 1;
  }
  const list = await loadDevices();
  if (list.some((d) => d.credential.id === pending.credential.id)) {
    c.done(`${pending.deviceName} is already approved for ${pending.signer}`);
    return 0;
  }
  stdio.stdout.writeSync(
    [
      "",
      `  Device:      ${pending.deviceName}`,
      `  Signs in as: ${pending.signer}`,
      `  Passkey:     ${pending.backedUp ? "synced (it may be on their other devices)" : "bound to this device"}`,
      `  From:        ${pending.from}`,
      `  Browser:     ${pending.userAgent}`,
      `  Registered:  ${pending.created}`,
      `  Approved by: ${me} (your key signs the commit)`,
      "",
    ].join("\n") + "\n",
  );
  // From the console, running the form is the person's yes (its terminal is not theirs to answer).
  if (!o.yes && !fromConsole()) {
    const yes = await ui.confirm(
      `  Approve ${pending.deviceName} to sign in as ${pending.signer}?`,
    );
    if (!yes) {
      c.done("not approved: nothing written");
      return 0;
    }
  }
  const device = deviceOf(pending, me);
  c.done(`${device.name} for ${device.signer}: written to fleets/${P.fleetId}/access.ts`);
  return await writeAndApply(
    [...list, device],
    `100-remote-access: approve ${device.name} for ${device.signer}`,
  );
}

/** `stolos devices revoke <id>` (FR-008). */
export async function devicesRevoke(o: { id: string; yes?: boolean }): Promise<number> {
  const c = ui.phase("Revoke");
  const list = await loadDevices();
  const d = list.find((x) => x.id === o.id || x.credential.id === o.id);
  if (!d) {
    c.fail(`no device ${o.id} in access.ts`, "bun run stolos devices (the ids)");
    return 1;
  }
  const others = await otherChanges(P.repo, P.fleetId);
  if (others.length) {
    c.fail(
      `uncommitted changes (${others.slice(0, 3).join(", ")}): a revoke commit holds the revoke only`,
      "bun run stolos apply (or set them aside), then run this again",
    );
    return 1;
  }
  if (!o.yes && !fromConsole() && !(await ui.confirm(`  Revoke ${d.name} of ${d.signer}?`))) {
    c.done("not revoked");
    return 0;
  }
  c.done(`${d.name} of ${d.signer}: removed from fleets/${P.fleetId}/access.ts`);
  return await writeAndApply(
    list.filter((x) => x !== d),
    `100-remote-access: revoke ${d.name} of ${d.signer}`,
  );
}

/** `stolos devices` (FR-008): every approved device and its last sign-in on this PC. */
export async function devicesList(json: boolean): Promise<number> {
  const list = await loadDevices();
  const use = (await readAccessState(accessStatePath(P.state))).use ?? {};
  if (json) {
    stdio.stdout.writeSync(
      JSON.stringify(
        list.map((d) => ({ ...d, use: use[d.id] })),
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  if (!list.length) {
    stdio.stdout.writeSync(
      "No device may sign in to the Stolos Console yet (bun run stolos console --lan, then register one).\n",
    );
    return 0;
  }
  for (const d of list) {
    const u = use[d.id];
    stdio.stdout.writeSync(
      `${d.id}  ${d.signer}  ${d.name}  (${d.backedUp ? "synced" : "device-bound"} passkey; registered ${d.registered.slice(0, 10)} from ${d.registeredFrom}; approved by ${d.approvedBy}; last sign-in here: ${u?.lastUsed ? `${u.lastUsed.slice(0, 16)} from ${u.lastFrom ?? "?"}` : "never"})\n`,
    );
  }
  return 0;
}

/**
 * FR-001: the console's names in fleet.ts. Proposes them (the default label, this PC as the
 * primary), asks (non-interactive: the defaults, said so), and writes them into fleet.ts when it
 * has none; says to send it. Returns the fleet as it is now, or why not.
 */
export async function consoleNamesSetup(
  pc: string,
  o: { interactive?: boolean } = {},
): Promise<{ fleet: FleetDef; written: boolean } | { why: string }> {
  const { loadFleet } = await import("../model/load.ts");
  const fleet = await loadFleet();
  if (!fleet.web) return { why: "the fleet has no web domain (fleet.ts: web: { domain })" };
  if (fleet.stolos?.console) return { fleet, written: false };
  const s = proposedSettings(fleet, pc);
  const n = consoleNames({ web: fleet.web, stolos: { console: s } }, pc);
  if (!n) return { why: "no names" };
  stdio.stdout.writeSync(
    [
      "",
      "  The Stolos Console on the site's network (spec 100):",
      `    https://${n.base}   this PC, the primary controller`,
      `    https://${n.own}`,
      "",
    ].join("\n") + "\n",
  );
  const interactive = o.interactive ?? true;
  const answer = interactive ? await ui.ask("  Use these names? [Y/n]") : undefined;
  if (answer === undefined) {
    ui.say("  (no terminal to ask: the defaults above are used)");
  } else if (/^n/i.test(answer.trim())) {
    return { why: "not set: add stolos: { console: { name, primary, lan } } to fleet.ts yourself" };
  }
  const text = (await fs.readTextOr(P.fleet)) ?? "";
  const next = withStolosSettings(text, s);
  if (!next) {
    return { why: "fleet.ts is not in the usual shape: add stolos: { console: { ... } } yourself" };
  }
  await fs.writeTextFile(P.fleet, next);
  ui.next.push("the console's names are in fleet.ts: send them with bun run stolos apply");
  return { fleet: { ...fleet, stolos: { console: s } }, written: true };
}

/** The doctor's view of remote access, read from this PC (no network). */
export async function accessFacts(): Promise<AccessFacts> {
  const { loadFleet } = await import("../model/load.ts");
  const { readSecret } = await import("../core/secrets.ts");
  const { parseTls } = await import("./tls.ts");
  const { unusedDevices } = await import("./devices.ts");
  const fleet = await loadFleet().catch(() => undefined);
  const st = await readAccessState(accessStatePath(P.state));
  const tls = parseTls(await readSecret(tlsSecretPath()));
  const devices = await loadDevices().catch(() => []);
  return {
    configured: !!fleet?.web && !!fleet.stolos?.console,
    ...(st.listening ? { listening: st.listening } : {}),
    ...(tls ? { notAfter: tls.notAfter } : {}),
    unused: unusedDevices(devices, st.use ?? {}, Date.now()).length,
    devices: devices.length,
  };
}

/** Where the console's certificate lives in the vault (`<secrets>/console/tls.json`). */
export function tlsSecretPath(): string {
  return SECRETS.consoleTls;
}
