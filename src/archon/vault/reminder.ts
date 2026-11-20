/**
 * Backup reminders (spec 029, Article 22): hard to miss, calm (Article 19).
 * - the panel at the end of a command that changed a secret, and at the start
 *   of `boot serve` and `boot status`, until backed up;
 * - `boot doctor` reports it as a warning whose fix is the command;
 * - the prompt's 🔐 backup token while anything is unbacked;
 * - email: after 24 hours unbacked, one "N secrets not backed up" (names
 *   only), then weekly; and, every six months, to check the recovery key
 *   (spec 057);
 * - a non-blocking git pre-push hook that prints the panel.
 *
 * @module
 */

// Spec: 029-vault
// Spec: 105-calm-output FR-017
import { fs, path as paths, proc } from "@intellectual-frontiers/system";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { readLedger, writeLedger } from "../core/secret-ledger.ts";
import { labelFor } from "../model/secret-inventory.ts";
import { assess, type Assessment, writePromptStatus } from "./state.ts";
import { panelLines, secretsInWords } from "./panel.ts";

export { secretsInWords };
import { PRE_PUSH_HOOK } from "../identity/keys.ts";

const DAY = 86_400_000;
/** This machine's short hostname, as the panel names it. */
export const pcName = (): string => proc.hostname().split(".")[0] ?? "";

/** Compute the panel for this run (shown by ui.finish or at exit). */
export async function preparePanel(a?: Assessment): Promise<Assessment> {
  const x = a ?? (await assess());
  await writePromptStatus(x);
  const lines = panelLines(x, pcName());
  if (lines) {
    ui.panel = {
      lines,
      level: x.severity === "red" ? "red" : "amber",
      summary: {
        text: `Your secrets changed since the last backup: ${secretsInWords(x)}`,
        command: "bun run stolos vault backup",
      },
    };
  } else delete ui.panel;
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
          ...a.unbacked.map(
            (s) => `- ${s.name}: ${s.ref ? labelFor(s.ref, s.name) : "not in the inventory"}`,
          ),
          "",
          `If ${pcName()} failed now, these would have to be recreated (bun run stolos docs disaster-recovery).`,
        ].join("\n"),
        todo: "On the boot machine: bun run stolos vault backup, then move the ZIP somewhere safe",
        key: `vault:unbacked:${new Date(now).toISOString().slice(0, 10)}`,
      });
      if (r === "queued") {
        l.remindedAt = new Date(now).toISOString();
        await writeLedger(l);
      }
    }
    // Spec 057: the recovery key, checked twice a year (one email a week while due).
    const { collectKeyFacts, keyChecks, writeKeyState } = await import("../identity/keys.ts");
    const kf = await collectKeyFacts();
    const due57 = keyChecks(kf, now).find((c) => c.code === "E057-RECOVERY-CHECK" && !c.ok);
    if (due57 && due(kf.state.recoveryRemindedAt)) {
      const r = await notify({
        event: "check the fleet's recovery key",
        level: "info",
        what: `${due57.what}. A recovery key you cannot use (a forgotten passphrase, a dead USB drive) cannot replace a lost daily key.`,
        todo: due57.fix,
        key: `keys:recovery:${new Date(now).toISOString().slice(0, 10)}`,
      });
      if (r === "queued") {
        await writeKeyState(
          { ...kf.state, recoveryRemindedAt: new Date(now).toISOString() },
          kf.paths.state,
        );
      }
    }
  } catch {
    /* reminders never fail the command that runs them */
  }
}

/** The git pre-push hook (specs 029 and 057): the signature check, then the backup panel. */
export { PRE_PUSH_HOOK as PRE_PUSH } from "../identity/keys.ts";

/**
 * Installs the pre-push hook in a checkout. Leaves another program's hook
 * alone and does nothing in a sandbox. Returns whether it wrote the hook.
 */
export async function installPrePushHook(repo = P.repo): Promise<boolean> {
  // A sandboxed run (tests) touches nothing outside its sandbox, the checkout's hooks included.
  if (proc.env.get("ARCHON_SANDBOX")) return false;
  const hooks = paths.join(repo, ".git", "hooks");
  if (!(await fs.exists(hooks))) return false;
  const path = paths.join(hooks, "pre-push");
  const current = await fs.readTextOr(path);
  if (current === PRE_PUSH_HOOK) return false;
  if (current && !current.includes("Installed by archon")) return false; // someone else's hook
  await fs.writeTextFile(path, PRE_PUSH_HOOK);
  if (proc.build.os !== "windows") await fs.chmod(path, 0o755);
  return true;
}
