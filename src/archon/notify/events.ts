/**
 * Which events send a message (spec 025): major actions only, never every
 * routine run. Each helper queues (never throws, never waits for the relay) and
 * starts the sender.
 *
 * @module
 */
// Spec: 025-notify

import { fs, path as paths, proc } from "@intellectual-frontiers/system";
import { asRoot, onHost, P } from "../core/paths.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { networkOf } from "../model/resolve.ts";
import { bootSite, enqueue, type Event, hostSite, kick, type Site } from "./notify.ts";

/** This machine as a notify site: a host in the model, else the boot machine. */
export async function localSite(hostName?: string): Promise<Site | undefined> {
  try {
    const fleet = await loadFleet();
    const name =
      hostName ?? ((await fs.readTextOr(onHost("/etc/archon/host")))?.trim() || undefined);
    const host = name ? (await loadHosts()).find((h) => h.name === name) : undefined;
    if (host && proc.build.os === "linux" && (await fs.readTextOr(onHost("/etc/archon/host")))) {
      return hostSite(
        fleet,
        host.name,
        host.kind === "workstation" ? "workstation" : "server",
        networkOf(fleet, host).ipv6,
      );
    }
    return bootSite(fleet);
  } catch {
    return undefined;
  }
}

/** Queue a message about this machine and start sending it. Never throws. */
export async function notify(ev: Event, hostName?: string): Promise<string> {
  try {
    const site = await localSite(hostName);
    if (!site) return "not configured";
    // Hosts: only root may write the spool; others go through `archon notify send`.
    if (site.role !== "boot" && !asRoot()) return "skipped (not root)";
    const r = await enqueue(site, ev);
    if (r === "queued") await kick(site);
    return r;
  } catch {
    return "failed";
  }
}

// ------------------------------------------------------- state changes

/** The host's last known health (root only), so a message goes out on a change, not on every run. */
const HEALTH = "/var/lib/archon/status/health.json";

/** What HEALTH holds: the last known state of each thing that sends on a change. */
export interface Health {
  /**
   * The last full apply: ok or failing, since when (ISO 8601), and when a
   * "failing" message was last sent (for the daily reminder).
   */
  apply?: { state: "ok" | "failing"; since: string; notified?: string };
  /** The verify checks (resources) failing at the last run; unset before the first. */
  verifyFailing?: string[];
  /** The boot id the "needs a reboot" message was sent for (one per boot). */
  rebootNotified?: string;
  /** When the last weekly backup summary was sent (ISO 8601). */
  backupSummaryAt?: string;
}

/** Read HEALTH (or another path, in tests); empty when missing or not JSON. */
async function readHealth(path = onHost(HEALTH)): Promise<Health> {
  try {
    return JSON.parse((await fs.readTextOr(path)) ?? "{}") as Health;
  } catch {
    return {};
  }
}

async function writeHealth(h: Health, path = onHost(HEALTH)) {
  await fs.writeTextFile(path, JSON.stringify(h, null, 2) + "\n").catch(() => {});
}

const hhmm = (iso: string, tz: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * What to send about an apply, given the last known state: ok -> failing,
 * failing -> ok, and a reminder once a day while it keeps failing. Nothing
 * for an apply that stays ok.
 */
export function applyTransition(
  prev: Health["apply"],
  ok: boolean,
  now = new Date(),
): { next: NonNullable<Health["apply"]>; send?: "failing" | "recovered" | "still failing" } {
  const iso = now.toISOString();
  if (ok) {
    if (prev?.state === "failing") return { next: { state: "ok", since: iso }, send: "recovered" };
    return { next: prev?.state === "ok" ? prev : { state: "ok", since: iso } };
  }
  if (prev?.state !== "failing") {
    return { next: { state: "failing", since: iso, notified: iso }, send: "failing" };
  }
  const last = Date.parse(prev.notified ?? prev.since);
  if (now.getTime() - last > 24 * 3600_000) {
    return { next: { ...prev, notified: iso }, send: "still failing" };
  }
  return { next: prev };
}

/** After every full apply (reconcile, update, apply): message on state changes only. */
export async function applyOutcome(
  hostName: string,
  ok: boolean,
  failing: string[],
  log: string | null,
  timezone: string,
): Promise<void> {
  if (!asRoot()) return;
  const h = await readHealth();
  const { next, send } = applyTransition(h.apply, ok);
  const prevSince = h.apply?.since;
  h.apply = next;
  await writeHealth(h);
  if (!send) return;
  const since = send === "recovered" ? (prevSince ?? next.since) : next.since;
  await notify(
    {
      event:
        send === "recovered"
          ? `✓ apply recovered (failing since ${hhmm(since, timezone)})`
          : `✗ apply ${send === "failing" ? "failing" : "still failing"} since ${hhmm(
              since,
              timezone,
            )}`,
      level: send === "recovered" ? "info" : "fail",
      what:
        send === "recovered"
          ? `archon apply succeeds again on ${hostName}.`
          : `archon apply failed on ${hostName}:\n${
              failing
                .slice(0, 20)
                .map((l) => `- ${l}`)
                .join("\n") || "- (see the log)"
            }`,
      todo:
        send === "recovered"
          ? undefined
          : `Look at the failing lines and the log; archon verify shows each fix. The reconcile timer retries every 15 minutes.`,
      log: log ?? undefined,
      attach: send === "recovered" || !log ? [] : [log],
      key: `apply:${send}:${since}`,
    },
    hostName,
  );
  await rebootCheck(hostName);
}

/** Updates that need a reboot: one message per boot. */
export async function rebootCheck(hostName: string): Promise<void> {
  if (!asRoot()) return;
  const flag = await fs.readTextOr("/run/reboot-required");
  if (flag === undefined) return;
  const bootId = (await fs.readTextOr("/proc/sys/kernel/random/boot_id"))?.trim() ?? "";
  const h = await readHealth();
  if (h.rebootNotified === bootId) return;
  h.rebootNotified = bootId;
  await writeHealth(h);
  const pkgs = ((await fs.readTextOr("/run/reboot-required.pkgs")) ?? "")
    .split("\n")
    .filter(Boolean);
  await notify(
    {
      event: "⚠ updates need a reboot",
      level: "warn",
      what: `Installed updates need a reboot to take effect${
        pkgs.length ? `: ${[...new Set(pkgs)].join(", ")}` : ""
      }.`,
      todo: `Reboot ${hostName} when convenient: archon reboot (from your local network: ssh ${hostName} archon reboot).`,
      key: `reboot-required:${bootId}`,
    },
    hostName,
  );
}

/** archon verify as root: a check that passed before and fails now. */
export async function verifyOutcome(
  hostName: string,
  checks: Array<{ resource: string; ok: boolean; output: string; level?: string }>,
): Promise<void> {
  if (!asRoot()) return;
  const h = await readHealth();
  const failingNow = checks.filter((c) => !c.ok && c.level !== "warn").map((c) => c.resource);
  const before = new Set(h.verifyFailing ?? []);
  const known = h.verifyFailing !== undefined;
  h.verifyFailing = failingNow;
  await writeHealth(h);
  const regressed = known ? failingNow.filter((c) => !before.has(c)) : [];
  if (!regressed.length) return;
  const lines = checks
    .filter((c) => regressed.includes(c.resource))
    .map((c) => `- ${c.resource}: ${c.output}`);
  await notify(
    {
      event: `✗ verify: ${regressed.length} check(s) now failing`,
      level: "fail",
      what: `Checks that passed before now fail:\n${lines.join("\n")}`,
      todo: `archon verify on ${hostName} shows each fix.`,
      key: `verify:${regressed.sort().join(",")}`,
    },
    hostName,
  );
}

/** Backups: every failure, and a summary once a week. */
export async function backupOutcome(
  hostName: string,
  ok: boolean,
  detail: string,
  log: string | null,
): Promise<void> {
  if (!asRoot()) return;
  if (!ok) {
    await notify(
      {
        event: "✗ backup failed",
        level: "fail",
        what: detail,
        todo: `archon backup run on ${hostName} to retry; archon backup verify to restore-test the newest archive.`,
        log: log ?? undefined,
        attach: log ? [log] : [],
        key: `backup:fail:${new Date().toISOString().slice(0, 10)}`,
      },
      hostName,
    );
    return;
  }
  const h = await readHealth();
  if (h.backupSummaryAt && Date.now() - Date.parse(h.backupSummaryAt) < 7 * 86_400_000) return;
  h.backupSummaryAt = new Date().toISOString();
  await writeHealth(h);
  await notify(
    {
      event: "✓ backups this week",
      what: detail,
      key: `backup:week:${h.backupSummaryAt.slice(0, 10)}`,
    },
    hostName,
  );
}

export { HEALTH, readHealth };
/** Internals kept reachable for tests (the path helpers this module uses). */
export const _test = { join: paths.join, P };
