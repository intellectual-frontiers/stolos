/**
 * Backup reminders (spec 029, Article 22): hard to miss, calm (Article 19).
 * - the panel at the end of a command that changed a secret, and at the start
 *   of `boot serve` and `boot status`, until backed up;
 * - `boot doctor` reports it as a warning whose fix is the command;
 * - the prompt's 🔐 backup token while anything is unbacked;
 * - email: after 24 hours unbacked, one "N secrets not backed up" (names
 *   only), then weekly;
 * - a non-blocking git pre-push hook that prints the panel.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { readLedger, writeLedger } from "../core/secret-ledger.ts";
import { labelFor } from "../model/secret-inventory.ts";
import { assess, type Assessment, writePromptStatus } from "./state.ts";
import { panelLines } from "./panel.ts";

const DAY = 86_400_000;
/** This machine's short hostname, as the panel names it. */
export const pcName = (): string => Deno.hostname().split(".")[0];

/** Compute the panel for this run (shown by ui.finish or at exit). */
export async function preparePanel(a?: Assessment): Promise<Assessment> {
  const x = a ?? await assess();
  await writePromptStatus(x);
  const lines = panelLines(x, pcName());
  ui.panel = lines ? { lines, level: x.severity === "red" ? "red" : "amber" } : undefined;
  return x;
}

/** Show the panel now (boot serve and boot status start with it). */
export async function showPanelNow(): Promise<Assessment> {
  const a = await preparePanel();
  ui.printPanel();
  return a;
}

/**
 * The email reminders, by the shared mailbox (spec 025). Called by boot serve
 * (at start and hourly), boot status, boot doctor, and vault status.
 */
export async function remind(now = Date.now()): Promise<void> {
  try {
    const a = await assess();
    await writePromptStatus(a);
    const l = await readLedger();
    const oldest = a.unbacked.map((s) => Date.parse(s.changedAt)).sort()[0];
    const due = (at?: string) => !at || now - Date.parse(at) >= 7 * DAY;
    const { notify } = await import("../notify/events.ts");
    if (oldest && now - oldest > DAY && due(l.remindedAt)) {
      const r = await notify({
        event: `${a.unbacked.length} secret${a.unbacked.length === 1 ? "" : "s"} not backed up`,
        level: a.severity === "red" ? "fail" : "warn",
        what: [
          `These secrets on ${pcName()} are newer than its last backup${
            a.lastBackup ? ` (${a.lastBackup.at.slice(0, 10)})` : " (there is none)"
          }:`,
          ...a.unbacked.map((s) =>
            `- ${s.name}: ${s.ref ? labelFor(s.ref, s.name) : "not in the inventory"}`
          ),
          "",
          `If ${pcName()} failed now, these would have to be recreated (docs/disaster-recovery.md).`,
        ].join("\n"),
        todo: "On the boot machine: deno task boot vault backup, then move the ZIP somewhere safe",
        key: `vault:unbacked:${new Date(now).toISOString().slice(0, 10)}`,
      });
      if (r === "queued") {
        l.remindedAt = new Date(now).toISOString();
        await writeLedger(l);
      }
    }
  } catch { /* reminders never fail the command that runs them */ }
}

/** The git pre-push hook (fleet init, and vault status if missing): prints the panel, never blocks. */
export const PRE_PUSH = `#!/bin/sh
# Installed by archon (spec 029): reminds you to back up the boot machine's
# secrets when any are newer than the last vault backup. Never blocks a push.
deno run -A src/archon/main.ts vault status --hook >&2 || true
exit 0
`;

/**
 * Installs the pre-push hook in a checkout. Leaves another program's hook
 * alone and does nothing in a sandbox. Returns whether it wrote the hook.
 */
export async function installPrePushHook(repo = P.repo): Promise<boolean> {
  // A sandboxed run (tests) touches nothing outside its sandbox, the checkout's hooks included.
  if (Deno.env.get("ARCHON_SANDBOX")) return false;
  const hooks = join(repo, ".git", "hooks");
  if (!(await exists(hooks))) return false;
  const path = join(hooks, "pre-push");
  const current = await readTextOr(path);
  if (current === PRE_PUSH) return false;
  if (current && !current.includes("Installed by archon (spec 029)")) return false; // someone else's hook
  await Deno.writeTextFile(path, PRE_PUSH);
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o755);
  return true;
}
