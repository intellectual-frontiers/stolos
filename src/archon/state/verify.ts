// `archon verify` (Article 15, spec 014): run every verification command in
// the host's plan and report each result. As root, the result is also kept
// in the host's own archon.sql (opt-in verify) when it changes (archon fleet status).

import { getRecord, putRecord } from "./store.ts";
import { currentUser, isRoot, run, splitArgs } from "../core/exec.ts";
import { homeOf } from "../model/load.ts";
import { expandPersonas } from "../personas/mod.ts";
import { ui } from "../core/ui.ts";
import { recordChecks } from "../core/telemetry.ts";
import { planFor } from "../build.ts";
import type { HostDef } from "../model/types.ts";

import { P } from "../core/paths.ts";

export interface Check {
  resource: string;
  command: string;
  ok: boolean;
  output: string;
  /**
   * "warn": a failure is reported as a warning and does not count as failed.
   * "pending" (spec 052): the check exited 3, "not set up yet": shown with its
   * next step, never a failure or a warning.
   */
  level?: "fail" | "warn" | "pending";
}

/** Spec 052: a check that exits 3 says "not set up yet" (a token not delivered, ...). */
export const PENDING_EXIT = 3;

/**
 * The latest verify, in this machine's archon.sql (spec 048): read over SSH by
 * fleet status (archon query). \`since\` is when this result first appeared; the
 * record is rewritten only when the result changes.
 */
export interface RecordedVerify {
  passed: number;
  total: number;
  failed: string[];
  warned: string[];
  /** Spec 052: not set up yet (a check that exited 3). */
  pending?: string[];
  since: string;
}

export function verifyRecord(checks: Check[], now = new Date()): RecordedVerify {
  const failed = failedChecks(checks).map((c) => c.resource);
  const warned = checks.filter((c) => !c.ok && c.level === "warn").map((c) => c.resource);
  const pending = checks.filter((c) => !c.ok && c.level === "pending").map((c) => c.resource);
  return {
    ...(pending.length ? { pending } : {}),
    passed: checks.filter((c) => c.ok).length,
    total: checks.length,
    failed,
    warned,
    since: now.toISOString(),
  };
}

/** Write the record unless the same result is already there; true when written. */
export async function recordVerify(
  host: string,
  checks: Check[],
  root = P.state,
  now = new Date(),
): Promise<boolean> {
  const next = verifyRecord(checks, now);
  const prev = (await getRecord<RecordedVerify>(host, "verify", "latest", root))?.body;
  if (prev) {
    const { since: _s, ...p } = prev;
    const { since: _n, ...cur } = next;
    if (JSON.stringify(p) === JSON.stringify(cur)) return false;
  }
  await putRecord(host, "verify", "latest", next, root, next.since);
  return true;
}

/** Checks that count as failed (warning-level checks never do). */
export const failedChecks = (checks: Check[]) =>
  checks.filter((c) => !c.ok && c.level !== "warn" && c.level !== "pending");

export async function verify(host: HostDef): Promise<Check[]> {
  const plan = await planFor(host);
  const targets = [
    ...plan.packages.map((p) => ({
      resource: `package:${p.name}`,
      command: p.source === "snap"
        ? `snap list ${p.name}`
        : `dpkg-query -W -f=\${db:Status-Abbrev} ${p.name}`,
      expect: p.source === "snap" ? undefined : /^ii/,
    })),
    ...plan.units.map((u) => ({ resource: u.unitName, command: u.verify, expect: undefined })),
    ...plan.tools.flatMap((t) => {
      if (t.source !== "self-updating") {
        return [{
          resource: `tool:${t.id}`,
          command: t.verify,
          expect: undefined,
          asUser: t.unprivileged && isRoot() ? "nobody" : undefined,
        }];
      }
      // Self-updating tools (on workstations) live in each holder's ~/.local/bin,
      // not on root's PATH: check each copy as its user, by full path.
      // Ubuntu's home directories are private (0750): without root, only your
      // own copy can be checked.
      const me = currentUser();
      return plan.users
        .filter((u) => t.forPersona && expandPersonas(u.personas).includes(t.forPersona))
        .filter((u) => isRoot() || u.name === me)
        .map((u) => ({
          resource: `tool:${t.id}:${u.name}`,
          command: `${homeOf(u)}/.local/bin/${t.bins[0]} --version`,
          expect: undefined,
          asUser: isRoot() ? u.name : undefined,
        }));
    }),
    // Checks the model declares (specs 001, 009, 025), each with its level and fix.
    // Every modeled port is in the running firewall, not only in ufw's saved
    // rules (as root; iptables needs it). Spec 008.
    ...plan.ports.map((p) => ({
      resource: `firewall:${p.port}/${p.protocol}`,
      command:
        `sh -c '[ "$(id -u)" = 0 ] || exit 0; iptables -S ufw-user-input 2>/dev/null | grep -- "-p ${p.protocol}" | grep -Eq -- "--dports? ([0-9:,]*,)?${p.port}(,|[[:space:]]|$)"'`,
      expect: undefined,
      asUser: undefined,
      level: "fail" as const,
      fix: "sudo ufw reload (then sudo ufw status)",
    })),
    ...plan.checks.map((c) => ({
      resource: c.name,
      command: c.command,
      expect: undefined,
      asUser: undefined,
      level: c.level,
      fix: c.fix,
      code: c.code,
    })),
    // Spec 017: every modeled guest exists (lxc info fails for a missing one).
    ...(plan.host.guests ?? []).map((g) => ({
      resource: `guest:${g.name}`,
      command: `lxc info ${g.name}`,
      expect: undefined,
      asUser: undefined,
    })),
  ];
  const p = ui.phase("Verify");
  const checks: Check[] = [];
  for (const [i, t] of targets.entries()) {
    p.step(i + 1, targets.length, t.resource);
    const asUser = (t as { asUser?: string }).asUser;
    // nobody's home does not exist: start where every account can.
    const r = await run(splitArgs(t.command), {
      asUser,
      cwd: asUser === "nobody" ? "/" : undefined,
    });
    const output = (r.stdout + r.stderr).trim().split("\n")[0] ?? "";
    const ok = r.ok && (!t.expect || t.expect.test(r.stdout));
    const extra = t as { level?: "fail" | "warn"; fix?: string; code?: string };
    const pending = !ok && r.code === PENDING_EXIT && !!extra.level;
    const level = pending ? "pending" : extra.level;
    checks.push({ resource: t.resource, command: t.command, ok, output, level });
    if (ok) p.ok(`${t.resource}: ${t.command}`);
    // Spec 052: shown as what it is, and counted the same way.
    else if (pending) {
      p.pending(`${t.resource}: not set up yet`, extra.fix ?? t.command, extra.code);
    } else if (level === "warn") {
      p.warn(
        `${t.resource}: ${output || `${t.command} failed`}`,
        extra.fix ?? t.command,
        extra.code,
      );
    } else {p.fail(
        `${t.resource}: ${output || `${t.command} failed`}`,
        extra.fix ?? t.command,
        extra.code,
      );}
  }
  const passed = checks.filter((c) => c.ok).length;
  const failed = failedChecks(checks).length;
  const pendingCount = checks.filter((c) => !c.ok && c.level === "pending").length;
  const warned = checks.length - passed - failed - pendingCount;
  recordChecks(passed, failed);
  // Spec 035: the welcome page shows the checks as they are now, not at install.
  if (isRoot()) {
    const { writeVerify } = await import("../core/status.ts");
    await writeVerify({
      at: new Date().toISOString(),
      passed,
      total: checks.length,
      failed: failedChecks(checks).map((c) => c.resource),
    });
    // The same result in this machine's archon.sql, for fleet status (spec 048).
    await recordVerify(plan.host.name, checks).catch(() => {});
    // Spec 051: what the machine is, as it reports itself, when that changed.
    const { recordInventory } = await import("./inventory.ts");
    await recordInventory(plan.host.name).catch(() => {});
  }
  // Spec 025: a check that passed before and fails now sends a message (as root).
  const { verifyOutcome } = await import("../notify/events.ts");
  await verifyOutcome(plan.host.name, checks).catch(() => {});
  p.done(
    `${passed} passed${failed ? ` · ${failed} failed` : ""}${
      warned ? ` · ${warned} warning(s)` : ""
    }${pendingCount ? ` · ${pendingCount} not set up yet` : ""}`,
  );
  return checks;
}
