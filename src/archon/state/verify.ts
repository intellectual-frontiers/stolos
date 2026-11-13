// `archon verify` (Article 15, spec 014): run every verification command in
// the host's plan and report each result. As root, the result is also kept
// in state/hosts/<host>/verify.json when it changes (archon fleet status).

import { currentUser, isRoot, run, splitArgs } from "../core/exec.ts";
import { homeOf } from "../model/load.ts";
import { expandPersonas } from "../personas/mod.ts";
import { ui } from "../core/ui.ts";
import { recordChecks } from "../core/telemetry.ts";
import { planFor } from "../build.ts";
import type { HostDef } from "../model/types.ts";
import { join } from "../core/path.ts";
import { ensureDir, readTextOr } from "../core/fsx.ts";
import { P } from "../core/paths.ts";

export interface Check {
  resource: string;
  command: string;
  ok: boolean;
  output: string;
  /** "warn": a failure is reported as a warning and does not count as failed. */
  level?: "fail" | "warn";
}

/**
 * state/hosts/<host>/verify.json: the latest verify as root, for the boot
 * machine's fleet status. `since` is when this result first appeared; the
 * file is rewritten only when the result changes, so the reconcile timer's
 * runs do not each make a commit.
 */
export interface RecordedVerify {
  passed: number;
  total: number;
  failed: string[];
  warned: string[];
  since: string;
}

export function verifyRecord(checks: Check[], now = new Date()): RecordedVerify {
  const failed = failedChecks(checks).map((c) => c.resource);
  const warned = checks.filter((c) => !c.ok && c.level === "warn").map((c) => c.resource);
  return {
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
  const path = join(root, "hosts", host, "verify.json");
  try {
    const { since: _s, ...prev } = JSON.parse((await readTextOr(path)) ?? "") as RecordedVerify;
    const { since: _n, ...cur } = next;
    if (JSON.stringify(prev) === JSON.stringify(cur)) return false;
  } catch { /* none yet */ }
  await ensureDir(join(root, "hosts", host));
  await Deno.writeTextFile(path, JSON.stringify(next, null, 2) + "\n");
  return true;
}

/** Checks that count as failed (warning-level checks never do). */
export const failedChecks = (checks: Check[]) => checks.filter((c) => !c.ok && c.level !== "warn");

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
          asUser: undefined,
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
    const r = await run(splitArgs(t.command), { asUser: (t as { asUser?: string }).asUser });
    const output = (r.stdout + r.stderr).trim().split("\n")[0] ?? "";
    const ok = r.ok && (!t.expect || t.expect.test(r.stdout));
    const extra = t as { level?: "fail" | "warn"; fix?: string };
    checks.push({ resource: t.resource, command: t.command, ok, output, level: extra.level });
    if (ok) p.ok(`${t.resource}: ${t.command}`);
    else p.warn(`${t.resource}: ${output || `${t.command} failed`}`, extra.fix ?? t.command);
  }
  const passed = checks.filter((c) => c.ok).length;
  const failed = failedChecks(checks).length;
  const warned = checks.length - passed - failed;
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
    // The same result in the repository, for the boot machine (archon push carries it).
    await recordVerify(plan.host.name, checks).catch(() => {});
  }
  // Spec 025: a check that passed before and fails now sends a message (as root).
  const { verifyOutcome } = await import("../notify/events.ts");
  await verifyOutcome(plan.host.name, checks).catch(() => {});
  p.done(
    `${passed} passed${failed ? ` · ${failed} failed` : ""}${
      warned ? ` · ${warned} warning(s)` : ""
    }`,
  );
  return checks;
}
