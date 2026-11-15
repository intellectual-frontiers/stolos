/**
 * `archon update` (spec 015): bring everything up to date from GitHub in one
 * command. Pull origin/main, then (in the freshly pulled code) validate,
 * converge, refresh tools, re-converge for dotfiles, and verify.
 *
 * Output follows Article XXII: one phase per step. After a pull that brought
 * new commits, the rest runs in a fresh process that continues the same
 * screen and run log (ARCHON_UI_CONTINUE, ARCHON_LOG, ARCHON_UI_START).
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { checkClock, describeSkew } from "../core/clock.ts";
import { syncCheckout } from "../reconcile/reconcile.ts";
import type { HostDef } from "../model/types.ts";

/** What `archon update` does. */
export interface UpdateOptions {
  /** Only report: fetch without pulling, apply and sync tools in check mode, skip verify. */
  check: boolean;
  /** Refresh tools (`archon tools sync`) after the apply. */
  tools: boolean;
  /** Pull origin/main first (false in the process that continues after a pull). */
  pull: boolean;
}

/** One step of an update and how it went. */
export interface UpdateStep {
  /** The step: `"pull"`, `"validate"`, `"apply"`, `"tools"`, `"apply (dotfiles)"` or `"verify"`. */
  step: string;
  /** Whether it succeeded. */
  ok: boolean;
  /** Its one-line result. */
  detail: string;
}

/**
 * `archon update`: pull, validate the model, apply, sync tools (and apply
 * dotfiles again if a tool changed), then verify. After a pull that brought
 * new commits, it runs the rest in the freshly pulled code and exits with
 * that process's code. Stops after an invalid model without applying.
 */
export async function update(host: HostDef, opts: UpdateOptions): Promise<UpdateStep[]> {
  const steps: UpdateStep[] = [];

  if (opts.pull) {
    const p = ui.phase("Pull");
    p.status(`fetching origin/main into ${P.repo}`);
    const s = await syncCheckout({ check: opts.check });
    const n = opts.check ? s.incoming.length : s.pulled.length;
    for (const c of opts.check ? s.incoming : s.pulled) p.note(c);
    if (s.blocked) {
      p.warn(
        `${s.blocked}; using the local checkout`,
        /cannot lock ref|unable to update local ref/.test(s.blocked)
          ? "another git process held the ref; run sudo archon update again"
          : /Authentication|could not read Username|403|401/.test(s.blocked)
            ? "as the checkout's owner (ops on a server, you on a workstation): gh auth status; gh auth setup-git"
            : s.blocked.startsWith("fetch failed")
              ? "check the network (curl -sI https://github.com), then sudo archon update"
              : "commit or stash local changes, then archon update",
      );
    }
    p.done(
      s.blocked
        ? "using the local checkout"
        : n
          ? `${n} ${opts.check ? "incoming" : "new"} commit(s)`
          : "already current",
    );
    steps.push({ step: "pull", ok: !s.blocked, detail: p.summary() });

    if (!opts.check && s.pulled.length) {
      // New code arrived: let it do the rest, on the same screen and log.
      p.note("handing off to the freshly pulled code");
      const args = ["update", "--no-pull", "--host", host.name];
      if (!opts.tools) args.push("--no-tools");
      if (ui.verbose) args.push("--verbose");
      const code = await proc.output(
        [proc.env.get("ARCHON_SELF") ?? "/usr/local/bin/archon", ...args],
        {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: {
            ARCHON_UI_CONTINUE: "1",
            ARCHON_UI_START: String(ui.started),
            ...(ui.logPath ? { ARCHON_LOG: ui.logPath } : {}),
          },
        },
      );
      ui.quiet = true; // the child printed the summary
      proc.exit(code.code);
    }
  }

  // Clock first: a clock behind makes apt reject the security pocket silently.
  const clock = await checkClock();
  if (clock && Math.abs(clock.skew) > 300) {
    ui.active("Preflight").warn(
      `system clock is ${describeSkew(clock.skew)}`,
      "sudo timedatectl set-ntp true",
    );
    ui.active("Preflight").done("clock skew");
  }

  const { loadModel, report } = await import("../build.ts");
  const v = ui.phase("Model");
  v.status("validating");
  const m = await loadModel();
  const valid = report(v, m);
  v.done(valid ? `${host.name} valid` : `${m.problems.length} problem(s): nothing applied`);
  steps.push({ step: "validate", ok: valid, detail: v.summary() });
  if (!valid) return steps; // never converge an invalid model (Article 10)

  const { apply } = await import("../apply/apply.ts");
  const a1 = await apply(host, { check: opts.check });
  steps.push({ step: "apply", ok: !a1.failed, detail: `${a1.changes.length} change(s)` });

  if (opts.tools) {
    const { syncTools } = await import("../tools/sync.ts");
    const t = await syncTools(host, { reportOnly: opts.check });
    steps.push({
      step: "tools",
      ok: !t.failed,
      detail: t.rows.map((x) => `${x.id}: ${x.action}`).join("; "),
    });
    const changed = t.rows.some((x) => /^upgraded|^installed/.test(x.action));
    if (!opts.check && changed) {
      const a2 = await apply(host, { check: false, only: ["dotfiles"] });
      steps.push({
        step: "apply (dotfiles)",
        ok: !a2.failed,
        detail: `${a2.changes.length} change(s)`,
      });
    }
  }

  if (!opts.check) {
    const { failedChecks, verify } = await import("../state/verify.ts");
    const vr = await verify(host);
    // A warning check reports, but never counts as a failure (CheckDef).
    const failed = failedChecks(vr).length;
    const warned = vr.filter((c) => !c.ok).length - failed;
    steps.push({
      step: "verify",
      ok: failed === 0,
      detail: `${vr.length - failed - warned} passed, ${failed} failed${
        warned ? `, ${warned} warning(s)` : ""
      }`,
    });
  }
  return steps;
}
