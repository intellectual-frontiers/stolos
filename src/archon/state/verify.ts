/**
 * `archon verify` (Article 15, spec 014): run every verification command in
 * the host's plan and report each result. As root, the result is also kept
 * in the host's own archon.sql (opt-in verify) when it changes (stolos fleet status).
 *
 * @module
 */

import { splitArgs } from "@intellectual-frontiers/commons/ts/kernel";
import { getRecord, putRecord } from "./store.ts";
import { currentUser, run } from "../core/exec.ts";
import { homeOf } from "../model/load.ts";
import { expandPersonas } from "../personas/mod.ts";
import { ui } from "../core/ui.ts";
import { recordChecks } from "../core/telemetry.ts";
import { planFor } from "../build.ts";
import type { HostDef } from "../model/types.ts";

import { asRoot, P } from "../core/paths.ts";

/** One check's result. */
export interface Check {
  /** What it checks (a package, a unit, a check's name). */
  resource: string;
  /** The command run. */
  command: string;
  /** It passed. */
  ok: boolean;
  /** The first line it printed. */
  output: string;
  /**
   * "warn": a failure is reported as a warning and does not count as failed.
   * "pending" (spec 052): the check exited 3, "not set up yet": shown with its
   * next step, never a failure or a warning.
   */
  level?: "fail" | "warn" | "pending";
  /** How to make it pass, when the check says (the model's fix, or the command to run). */
  fix?: string;
  /** Its explain code, when it has one (archon explain <code>). */
  code?: string;
}

/**
 * One check that needs attention, with what to do about it: the consoles show these (the Archon
 * Console's Overview, the Stolos Console's machine page), so a warning is never a bare number.
 */
export interface Attention {
  /** What it checks. */
  resource: string;
  /** How serious: fail, warn, or pending (not set up yet). */
  level: "fail" | "warn" | "pending";
  /** What it found (the check's first line of output). */
  output: string;
  /** How to make it pass. */
  fix: string;
  /** Its explain code (archon explain <code>), when it has one. */
  code?: string;
}

/** The checks that did not pass, each with its level and fix. */
export function attentionOf(checks: Check[]): Attention[] {
  return checks
    .filter((c) => !c.ok)
    .map((c) => ({
      resource: c.resource,
      level: c.level ?? "fail",
      output: c.output,
      fix: c.fix ?? c.command,
      ...(c.code ? { code: c.code } : {}),
    }));
}

/** Spec 052: a check that exits 3 says "not set up yet" (a token not delivered, ...). */
export const PENDING_EXIT = 3;

/**
 * The latest verify, in this machine's archon.sql (spec 048): read over SSH by
 * fleet status (archon query). \`since\` is when this result first appeared; the
 * record is rewritten only when the result changes.
 */
export interface RecordedVerify {
  /** How many passed. */
  passed: number;
  /** How many ran (pending ones included). */
  total: number;
  /** Failures, by resource. */
  failed: string[];
  /** Warnings, by resource. */
  warned: string[];
  /** Spec 052: not set up yet (a check that exited 3). */
  pending?: string[];
  /** Every check that did not pass, with its fix (newer engines). */
  attention?: Attention[];
  /** When this result first appeared. */
  since: string;
}

/** The record of a verify, as archon.sql keeps it. */
export function verifyRecord(checks: Check[], now = new Date()): RecordedVerify {
  const failed = failedChecks(checks).map((c) => c.resource);
  const warned = checks.filter((c) => !c.ok && c.level === "warn").map((c) => c.resource);
  const pending = checks.filter((c) => !c.ok && c.level === "pending").map((c) => c.resource);
  const attention = attentionOf(checks);
  return {
    ...(pending.length ? { pending } : {}),
    ...(attention.length ? { attention } : {}),
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
export const failedChecks = (checks: Check[]): Check[] =>
  checks.filter((c) => !c.ok && c.level !== "warn" && c.level !== "pending");

/** One check to run: what it checks, the command, and how to read it. */
type Target = {
  readonly resource: string;
  readonly command: string;
  readonly expect?: RegExp | undefined;
  readonly asUser?: string | undefined;
  readonly level?: "fail" | "warn" | undefined;
  readonly fix?: string | undefined;
  readonly code?: string | undefined;
};

/** archon verify: every check of the host's plan, each shown at its level. */
export async function verify(host: HostDef): Promise<Check[]> {
  const plan = await planFor(host);
  const targets: Target[] = [
    ...plan.packages.map((p) => ({
      resource: `package:${p.name}`,
      command:
        p.source === "snap"
          ? `snap list ${p.name}`
          : `dpkg-query -W -f=\${db:Status-Abbrev} ${p.name}`,
      expect: p.source === "snap" ? undefined : /^ii/,
    })),
    ...plan.units.map((u) => ({ resource: u.unitName, command: u.verify, expect: undefined })),
    ...plan.tools.flatMap((t) => {
      if (t.source !== "self-updating") {
        return [
          {
            resource: `tool:${t.id}`,
            command: t.verify,
            expect: undefined,
            asUser: t.unprivileged && asRoot() ? "nobody" : undefined,
          },
        ];
      }
      // Self-updating tools (on workstations) live in each holder's ~/.local/bin,
      // not on root's PATH: check each copy as its user, by full path.
      // Ubuntu's home directories are private (0750): without root, only your
      // own copy can be checked.
      const me = currentUser();
      return plan.users
        .filter((u) => t.forPersona && expandPersonas(u.personas).includes(t.forPersona))
        .filter((u) => asRoot() || u.name === me)
        .map((u) => ({
          resource: `tool:${t.id}:${u.name}`,
          command: `${homeOf(u)}/.local/bin/${t.bins[0]} --version`,
          expect: undefined,
          asUser: asRoot() ? u.name : undefined,
        }));
    }),
    // Checks the model declares (specs 001, 009, 025), each with its level and fix.
    // Every modeled port is in the running firewall, not only in ufw's saved
    // rules (as root; iptables needs it). Spec 008.
    ...plan.ports.map((p) => ({
      resource: `firewall:${p.port}/${p.protocol}`,
      command: `sh -c '[ "$(id -u)" = 0 ] || exit 0; iptables -S ufw-user-input 2>/dev/null | grep -- "-p ${p.protocol}" | grep -Eq -- "--dports? ([0-9:,]*,)?${p.port}(,|[[:space:]]|$)"'`,
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
    const asUser = t.asUser;
    const argv = splitArgs(t.command);
    // nobody's home does not exist: start where every account can.
    const r =
      argv.kind === "ok"
        ? await run(argv.value, {
            ...(asUser === undefined ? {} : { asUser }),
            ...(asUser === "nobody" ? { cwd: "/" } : {}),
          })
        : { ok: false, code: 2, stdout: "", stderr: `${t.command}: ${argv.error}` };
    const output = (r.stdout + r.stderr).trim().split("\n")[0] ?? "";
    const ok = r.ok && (!t.expect || t.expect.test(r.stdout));
    const extra = t;
    const pending = !ok && r.code === PENDING_EXIT && !!extra.level;
    const level = pending ? "pending" : extra.level;
    checks.push({
      resource: t.resource,
      command: t.command,
      ok,
      output,
      ...(level === undefined ? {} : { level }),
      ...(extra.fix ? { fix: extra.fix } : {}),
      ...(extra.code ? { code: extra.code } : {}),
    });
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
    } else {
      p.fail(
        `${t.resource}: ${output || `${t.command} failed`}`,
        extra.fix ?? t.command,
        extra.code,
      );
    }
  }
  const passed = checks.filter((c) => c.ok).length;
  const failed = failedChecks(checks).length;
  const pendingCount = checks.filter((c) => !c.ok && c.level === "pending").length;
  const warned = checks.length - passed - failed - pendingCount;
  recordChecks(passed, failed);
  // Spec 035: the welcome page shows the checks as they are now, not at install.
  if (asRoot()) {
    const { writeVerify } = await import("../core/status.ts");
    await writeVerify({
      at: new Date().toISOString(),
      passed,
      total: checks.length,
      failed: failedChecks(checks).map((c) => c.resource),
      attention: attentionOf(checks),
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
