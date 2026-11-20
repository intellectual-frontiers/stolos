/**
 * Calm output (Article XXII, spec 018): quiet on success, loud and actionable
 * on problems, full detail always in the log. On IFC TypeScript's `tty`,
 * `stdio` and `fs`; this is the one module of the engine that writes for a
 * person to the terminal (the lint rule `ifc/terminal-writers` allows it alone).
 *
 *   ✅ Packages         86 installed (1m12s)
 *   ⠸ Files            [██████░░░░] 30/47  /etc/ssh/sshd_config.d/50-archon.conf
 *
 * Terminal: spinner, progress bar, in-place redraw, colors, emoji.
 * Pipe/timer/journald: plain final lines only. NO_COLOR disables color.
 * Non-UTF-8 locale or ARCHON_PLAIN=1: ASCII marks ([ok] [warn] [FAIL]).
 *
 * @module
 */
// Spec: 099-engine-update FR-007
// Spec: 101-ladder FR-006
// Spec: 105-calm-output FR-002 to FR-011
import * as palette from "@intellectual-frontiers/terminal/palette";
import type { LineKind, OutcomeLevel, Verbosity } from "../ontology.auto.ts";
import { fs, proc, stdio, tty } from "@intellectual-frontiers/system";
import { EXPLAIN, translate } from "./explain.ts";
import { asRoot, P } from "./paths.ts";

// ARCHON_VERBOSE=1 (or -v): every item is shown, dimmed, as it happens.
// --json: nothing on screen; the log file still records everything.

/** How a phase ended: ok, with warnings, failed, deferred (a disruptive change left for later), or skipped. */
export type Level = "ok" | "warn" | "fail" | "defer" | "skip";

/**
 * Spec 052: the states, the same everywhere. "fail" and "warn" are problems;
 * "pending" is something not set up yet, expected until someone does it (a
 * token not pushed, a certificate not issued yet): shown with its next step,
 * never a failure, never counted as a warning. Spec 099: "action" (⚡) is a
 * step that is the operator's to take (send a change, back up, approve):
 * nothing is wrong, so it is neither a warning nor an error. Spec 101-ladder FR-006: "pending"
 * and "action" are the ontology's outcome levels (`stolos:OutcomeLevel`); "warn" and "fail" are
 * the words a run's log and JSON carry for the levels "warning" and "failed".
 */
export type ProblemLevel = "warn" | "fail" | Extract<OutcomeLevel, "pending" | "action">;

/** A problem a run found, shown again under "Needs attention" (or "Not set up yet") when it ends. */
export interface Problem {
  /** Failure, warning, or not set up yet. */
  level: ProblemLevel;
  /** The phase it happened in. */
  phase: string;
  /** What happened. */
  message: string;
  /** How to fix it (for pending: the next step). */
  fix?: string;
  /** A stable code: archon explain <code> (spec 052). */
  code?: string;
  /** Its line in the run's log, when there is one. */
  logLine?: number;
  /** The raw text of a system error, when `message` is its plain sentence (spec 105-calm-output FR-009): shown with --verbose. */
  raw?: string;
}

/** An optional feature that is merely off (spec 105-calm-output FR-008): a hint, not a problem. */
export interface Hint {
  /** Its stable id: it is shown at most once per 7 days. */
  id: string;
  /** What is off, and what it would give. */
  message: string;
  /** The command that turns it on, when there is one. */
  command?: string;
}

/** How long a hint stays quiet after it was shown (spec 105-calm-output FR-008). */
export const HINT_DAYS = 7;

/** How many failed, warned, waiting and your-move items a child run found, and each of them (the STOLOS_SUMMARY file, spec 105-calm-output FR-005). */
export interface RunSummary {
  /** Failures. */
  fails: number;
  /** Warnings. */
  warns: number;
  /** Items waiting on time or someone else. */
  pending: number;
  /** Items for the person to do. */
  actions: number;
  /** Every problem, in order. */
  problems: Problem[];
  /** The outcome lines the run wants the person to see ("Sent: every server applies it within 15 minutes"). */
  outcomes: string[];
}

/**
 * A fix text split into the one command in it and the instruction around it (spec 105-calm-output
 * FR-011): a `run:`, `next:` or `fix:` line holds only the command, any words go on another line.
 */
export function splitFix(fix: string | undefined): { say?: string; cmd?: string } {
  if (!fix) return {};
  const text = fix.trim();
  const head =
    /^((?:bun run stolos|stolos|archon|git|gh|sudo|ssh|bun)\b[^;(]*?)(?:\s+\((.*)\))?\s*$/s.exec(
      text,
    );
  if (head?.[1] && !/,\s|\bthen\b/.test(head[1])) {
    const say = head[2]?.trim();
    return { cmd: head[1].trim(), ...(say ? { say: say[0]?.toUpperCase() + say.slice(1) } : {}) };
  }
  const inner =
    /(?:^|[:;,]\s*|\bthen\s+)((?:bun run stolos|archon|stolos)\s+[A-Za-z][^;(,]*?)\s*(?:\(|;|,|\.\s|$)/.exec(
      text,
    );
  if (inner?.[1]) {
    const cmd = inner[1].trim();
    const say = text
      .replace(cmd, "")
      .replace(/^\s*[:;,]\s*/, "")
      .replace(/\s*(,\s*)?(then|:)\s*$/i, "")
      .replace(/^then\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();
    const said = say ? say[0]?.toUpperCase() + say.slice(1) : "";
    return { cmd, ...(said && said !== ":" ? { say: said } : {}) };
  }
  return { say: text };
}

/** How a {@link Ui} draws: the defaults come from the terminal and the environment. */
export interface UiOptions {
  /** Draw for a terminal (spinner, redraws); default: stdout is a terminal. */
  tty?: boolean;
  /** Use color; default: a terminal without NO_COLOR. */
  color?: boolean;
  /** Use emoji; default: where the terminal shows them. */
  emoji?: boolean;
  /** Show every item as it happens, dimmed. */
  verbose?: boolean;
  /** Show nothing (the log still records everything). */
  quiet?: boolean;
  /** How much of the run reaches the screen (spec 105-calm-output FR-002); default: verbose, every phase line. */
  mode?: Verbosity;
  /** Where hints are remembered (default: `hints.json` in this PC's state folder of the program). */
  hintsFile?: string | null;
  /** Where output goes; default: stdout. */
  write?: (s: string) => void;
  /** The run's log file (null: none). */
  logPath?: string | null;
  /** The clock, in milliseconds (tests give their own). */
  now?: () => number;
}

const env = (k: string): string | undefined => {
  const v = proc.env.get(k);
  return v === "" ? undefined : v;
};

function utf8Locale(): boolean {
  const l = env("LC_ALL") || env("LC_CTYPE") || env("LANG") || "";
  return /utf-?8/i.test(l);
}

/**
 * Can this terminal show emoji? A UTF-8 locale says so on Linux. Windows sets
 * no locale variables, so its modern terminals are recognized directly:
 * Windows Terminal (WT_SESSION), VS Code and others (TERM_PROGRAM), ConEmu.
 * ARCHON_PLAIN=1 turns them off; ARCHON_EMOJI=1 turns them on.
 */
export function emojiTerminal(): boolean {
  if (env("ARCHON_PLAIN") !== undefined) return false;
  if (env("ARCHON_EMOJI") !== undefined) return true;
  if (utf8Locale()) return true;
  if (proc.build.os === "windows") {
    return (
      env("WT_SESSION") !== undefined ||
      env("TERM_PROGRAM") !== undefined ||
      env("ConEmuANSI") === "ON"
    );
  }
  return proc.build.os === "darwin" && env("TERM_PROGRAM") !== undefined;
}

const MARKS = {
  emoji: {
    ok: "✅",
    warn: "⚠️ ",
    fail: "❌",
    // Commons 0006-signals FR-022 and FR-027: the same marks in every command line.
    pending: palette.MARKS.pending.emoji,
    action: palette.MARKS.action.emoji,
    defer: "🔒",
    skip: "⏭️ ",
    start: "🛰️ ",
    done: "✨",
    bad: "❌",
  },
  ascii: {
    ok: "[ok]",
    warn: "[warn]",
    fail: "[FAIL]",
    pending: palette.MARKS.pending.ascii,
    action: palette.MARKS.action.ascii,
    defer: "[defer]",
    skip: "[skip]",
    start: "==>",
    done: "==>",
    bad: "!!",
  },
};
/** The code a problem carries when its raiser gave none (spec 105-calm-output FR-009): each is explained by `stolos explain`. */
const GENERIC_CODE: Record<ProblemLevel, string> = {
  fail: "E105-FAILED",
  warn: "E105-WARNING",
  pending: "P105-WAITING",
  action: "E105-YOURS",
};
const SPIN = {
  emoji: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  ascii: ["|", "/", "-", "\\"],
};

/** A duration for people: "850ms", "12s", "3m05s". */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** One phase of a run ("Packages", "Verify", ...): its progress, its items, its problems, and its one-line result. */
export class Phase {
  /** How many changes it made. */
  changes = 0;
  /** How many items were already right. */
  oks = 0;
  /** How many warnings. */
  warns = 0;
  /** How many failures. */
  fails = 0;
  /** How many items are not set up yet. */
  pendings = 0;
  /** Spec 099: steps that are the operator's to take. */
  actions = 0;
  /** How many disruptive changes it left for later. */
  deferred = 0;
  /** How many items it skipped. */
  skipped = 0;
  /** Its one-line result, when set. */
  result?: string;
  /** Its progress bar's state. */
  progress?: { n: number; total: number; label: string };
  /** When it started (the Ui's clock). */
  readonly started: number;
  /** Its name, as printed. */
  readonly name: string;
  /** The Ui it belongs to. */
  readonly ui: Ui;
  /** A phase of `ui`, named `name`; started by {@link Ui.phase}. */
  constructor(name: string, ui: Ui) {
    this.name = name;
    this.ui = ui;
    this.started = ui.now();
  }
  /** Update the progress bar (n of total) with a short label. */
  step(n: number, total: number, label = ""): void {
    this.progress = { n, total, label };
    this.ui.redraw();
  }
  /** A label without a known total (spinner only). */
  status(label: string): void {
    this.progress = { n: 0, total: 0, label };
    this.ui.redraw();
  }
  /** A change it made. */
  change(msg: string): void {
    this.changes++;
    this.ui.item("change", msg);
  }
  /** An item already right. */
  ok(msg: string): void {
    this.oks++;
    this.ui.item("ok", msg);
  }
  /** An item it skipped. */
  skip(msg: string): void {
    this.skipped++;
    this.ui.item("skip", msg);
  }
  /** A disruptive change left for later (shown with how to run it). */
  defer(msg: string): void {
    this.deferred++;
    this.ui.deferred.push(msg);
    this.ui.item("defer", msg);
  }
  /** A warning: shown, with its fix and code; never fails the run. */
  warn(msg: string, fix?: string, code?: string): void {
    this.warns++;
    this.ui.problem("warn", this.name, msg, fix, code);
  }
  /** A failure: shown, with its fix and code; the run exits 1. */
  fail(msg: string, fix?: string, code?: string): void {
    this.fails++;
    this.ui.problem("fail", this.name, msg, fix, code);
  }
  /** Not set up yet (spec 052): its next step; never a failure or a warning. */
  pending(msg: string, next: string, code?: string): void {
    this.pendings++;
    this.ui.problem("pending", this.name, msg, next, code);
  }
  /** Spec 099: a step that is the operator's to take (⚡): what, and the command; never a problem. */
  action(msg: string, next: string, code?: string): void {
    this.actions++;
    this.ui.problem("action", this.name, msg, next, code);
  }
  /** Detail for the log only (shown dimmed with --verbose). */
  note(msg: string): void {
    this.ui.item("note", msg);
  }
  /** Set the one-line result shown when the phase ends. */
  done(result?: string): void {
    if (result !== undefined) this.result = result;
    this.ui.endPhase(this);
  }
  /** How it ended: fail when anything failed, else warn, else ok. */
  get level(): Level {
    return this.fails ? "fail" : this.warns ? "warn" : "ok";
  }
  /**
   * Its honest mark (spec 105-calm-output FR-004): a cross for a failure, a warning mark for a
   * warning, a lightning mark where it holds something for the person to do, an hourglass where
   * it holds something waiting, a check only where it recorded none of them.
   */
  get mark(): "ok" | "warn" | "fail" | "action" | "pending" {
    return this.fails
      ? "fail"
      : this.warns
        ? "warn"
        : this.actions
          ? "action"
          : this.pendings
            ? "pending"
            : "ok";
  }
  /** Take in what a nested run found (spec 105-calm-output FR-005): its problems become this phase's, shown once by the parent. */
  merge(problems: readonly Problem[], outcomes: readonly string[] = []): void {
    for (const o of outcomes) this.ui.outcome(o);
    for (const p of problems) {
      if (p.level === "fail") this.fail(p.message, p.fix, p.code);
      else if (p.level === "warn") this.warn(p.message, p.fix, p.code);
      else if (p.level === "pending") this.pending(p.message, p.fix ?? "", p.code);
      else this.action(p.message, p.fix ?? "", p.code);
    }
  }
  /** An optional feature that is merely off (spec 105-calm-output FR-008): a hint, shown at most once a week. */
  hint(id: string, message: string, command?: string): void {
    this.ui.hint(id, message, command);
  }
  /** Its one-line result: set by done(), or counted from its items. */
  summary(): string {
    if (this.result !== undefined) {
      return this.deferred ? `${this.result} · ${this.deferred} deferred` : this.result;
    }
    const parts: string[] = [];
    if (this.changes) parts.push(`${this.changes} changed`);
    if (this.fails) parts.push(`${this.fails} failed`);
    if (this.warns) parts.push(`${this.warns} warning${this.warns > 1 ? "s" : ""}`);
    if (this.pendings) parts.push(`${this.pendings} not set up yet`);
    if (this.actions) parts.push(`${this.actions} for you to do`);
    if (this.deferred) parts.push(`${this.deferred} deferred`);
    return parts.join(" · ") || "up to date";
  }
}

/** The terminal output of an archon run: a header, phases with progress, problems with fixes, and a closing summary whose color always matches the exit code. */
export class Ui {
  /** Drawing for a terminal. */
  readonly tty: boolean;
  /** Using color. */
  readonly color: boolean;
  /** Using emoji. */
  readonly emoji: boolean;
  /** Showing every item. */
  verbose: boolean;
  /** Showing nothing on screen. */
  quiet: boolean;
  /** How much of the run reaches the screen (spec 105-calm-output FR-002). */
  mode: Verbosity;
  /**
   * Run inside another run (spec 105-calm-output FR-005): the parent's mode, else undefined. A run
   * in another process is told by the environment; one in this process by {@link Ui.nestedRun}
   * (spec 106-one-passphrase-speed FR-006).
   */
  nested: Verbosity | undefined;
  /** The word that opens the closing verdict ("Up to date", "Updated to stolos-v0.136.0"). */
  verdictTitle: string | undefined;
  /** Optional features that are off, found by this run. */
  readonly hints: Hint[] = [];
  /** The outcome lines of this run (spec 105-calm-output FR-003). */
  readonly outcomes: string[] = [];
  private hintsFile: string | null | undefined;
  private readonly screen: (s: string) => unknown;
  private readonly customWrite: boolean;
  /** The clock (milliseconds). */
  readonly now: () => number;
  /** When the run started. */
  readonly started: number;
  /** Every problem so far. */
  readonly problems: Problem[] = [];
  /** The closing summary was printed (once per run). */
  private finished = false;
  /** Every disruptive change left for later. */
  readonly deferred: string[] = [];
  /** How to run the deferred changes. */
  deferHint = "run from the console or AMT: sudo archon apply --include-disruptive";
  /** Suggested next steps printed under the closing line. */
  next: string[] = [];
  /** The secrets backup panel (spec 029), shown once: by finish, or by the entry point on exit. */
  panel?:
    | {
        lines: string[];
        level: "amber" | "red";
        /** The same, as one thing for the person to do (spec 105-calm-output FR-017). */
        summary?: { text: string; command: string };
      }
    | undefined;
  private panelShown = false;
  /** Set while a run nested in this process is running (spec 106-one-passphrase-speed FR-006): what it found, when it ends. */
  private scope: { summary?: RunSummary } | undefined;

  /** The closing block was printed already (once per run). */
  get closed(): boolean {
    return this.finished;
  }

  /** Print the backup panel, once (calm: one panel per run). */
  printPanel(): void {
    if (!this.panel || this.panelShown || this.mode === "quiet" || this.mode === "json") return;
    this.panelShown = true;
    const color = this.panel.level === "red" ? this.red : this.yellow;
    this.out("");
    for (const l of this.panel.lines) this.out(color(l));
  }
  /** The run's log file. */
  logPath: string | null;
  private current: Phase | undefined;
  private phases: Phase[] = [];
  private write: (s: string) => void;
  private logFile: fs.FsFile | undefined;
  private logLines = 0;
  private spinIndex = 0;
  private timer: proc.Timer | undefined;
  private enc = new TextEncoder();
  /** The terminal is gone (an SSH session dropped); output goes only to the run log. */
  detached = false;

  /** A Ui with these options (see {@link UiOptions}). */
  constructor(o: UiOptions = {}) {
    this.tty = o.tty ?? tty.isTerminal("stderr");
    this.color =
      o.color ?? (env("NO_COLOR") === undefined && (this.tty || env("FORCE_COLOR") !== undefined));
    this.emoji = o.emoji ?? emojiTerminal();
    this.verbose = o.verbose ?? env("ARCHON_VERBOSE") !== undefined;
    this.quiet = o.quiet ?? false;
    this.mode = o.mode ?? (this.quiet ? "json" : "verbose");
    const parent = env("STOLOS_NESTED");
    this.nested =
      parent === "calm" || parent === "verbose" || parent === "quiet" ? parent : undefined;
    this.hintsFile = o.hintsFile;
    this.now = o.now ?? Date.now;
    this.started = Number(env("ARCHON_UI_START")) || this.now();
    // The screen's own writer, taken now: --quiet holds back what commands write themselves, never this.
    this.screen = stdio.stderr.writeSync.bind(stdio.stderr);
    this.customWrite = o.write !== undefined;
    this.write =
      o.write ??
      ((s) => {
        // After the terminal goes away (an SSH session dropped mid-run) keep
        // going: the run log still records everything.
        if (this.detached) return;
        try {
          stdio.stderr.writeSync(s);
        } catch {
          this.detached = true;
        }
      });
    this.logPath = o.logPath === undefined ? null : o.logPath;
  }

  /** The marks for each state, emoji or ASCII. */
  private get m(): typeof MARKS.emoji {
    return this.emoji ? MARKS.emoji : MARKS.ascii;
  }
  /** Text in an ANSI color, when color is on. */
  private c(code: string, s: string): string {
    return this.color ? `\x1b[${code}m${s}\x1b[0m` : s;
  }
  /** Dimmed text. */
  dim = (s: string): string => this.c("2", s);
  /** Bold text. */
  bold = (s: string): string => this.c("1", s);
  /** Red text (failures). */
  red = (s: string): string => this.c("31", s);
  /** Yellow text (warnings). */
  yellow = (s: string): string => this.c("33", s);
  /** Green text (success). */
  green = (s: string): string => this.c("32", s);
  /** Cyan text. */
  cyan = (s: string): string => this.c("36", s);
  /** Blue text. */
  blue = (s: string): string => this.c("34", s);
  /** Magenta text. */
  magenta = (s: string): string => this.c("35", s);

  /** Whether a line of this kind reaches the screen in this run's mode (spec 105-calm-output FR-003): calm hides only the green steps. */
  shows(kind: LineKind): boolean {
    if (this.nested !== undefined && this.nested !== "verbose") return false;
    if (this.mode === "json" || this.mode === "quiet") return false;
    if (this.mode === "verbose") return true;
    return kind !== "step";
  }

  /** Choose how much of the run reaches the screen: quiet and json draw nothing during the run. */
  setMode(mode: Verbosity): void {
    this.mode = mode;
    if (mode === "quiet" || mode === "json") this.quiet = true;
    if (mode === "verbose" && this.nested === undefined) this.quiet = false;
  }

  /** Open the run log lazily (operations only). */
  private openLog(): void {
    if (this.logFile || this.logPath === null) return;
    try {
      this.logFile = fs.openSync(this.logPath, { create: true, append: true });
    } catch {
      this.logPath = null;
    }
  }

  /** Start logging to a file (call before the first phase). */
  useLog(path: string | null): void {
    this.logPath = path;
    if (path) this.openLog();
  }

  /** Write a line to the log; returns its line number. */
  log(line: string): number {
    this.openLog();
    if (!this.logFile) return 0;
    for (const l of line.split("\n")) {
      this.logFile.writeSync(this.enc.encode(`${new Date().toISOString()} ${l}\n`));
      this.logLines++;
    }
    return this.logLines;
  }

  /** Erase the spinner's line. */
  private clearLine(): void {
    if (this.tty) this.write("\r\x1b[2K");
  }

  /** Write a line on screen (and in the log). */
  private out(line: string): void {
    if (this.quiet || (this.nested !== undefined && this.nested !== "verbose")) return;
    this.clearLine();
    this.write(line + "\n");
    this.redraw();
  }

  /** The run's header: its title and what it acts on. */
  header(title: string, subtitle = ""): void {
    this.log(`== ${title}${subtitle ? ` · ${subtitle}` : ""}`);
    // One run, one header (spec 105-calm-output FR-005): a nested run draws none.
    if (env("ARCHON_UI_CONTINUE") || this.nested !== undefined) return;
    const head = `${this.m.start} ${this.bold(this.cyan(title))}${
      subtitle ? this.dim(`  ·  ${subtitle}`) : ""
    }`;
    const rule = (this.emoji ? "─" : "-").repeat(
      Math.min(72, Math.max(24, title.length + subtitle.length + 8)),
    );
    this.out(`${head}\n${this.dim(rule)}`);
  }

  /** Start a phase (the previous one ends). */
  phase(name: string): Phase {
    if (this.current) this.endPhase(this.current);
    const p = new Phase(name, this);
    this.current = p;
    this.phases.push(p);
    for (const l of this.listeners) {
      try {
        l.start?.(name);
      } catch {
        /* telemetry is best effort */
      }
    }
    this.log(`-- ${name}`);
    this.startSpinner();
    this.redraw();
    return p;
  }

  /** The active phase, or a fresh one named `name`. */
  active(name = "Working"): Phase {
    return this.current ?? this.phase(name);
  }

  /** One item of the current phase (shown with -v; always logged). */
  item(kind: "change" | "ok" | "skip" | "defer" | "note", msg: string): void {
    this.log(`   ${kind.padEnd(6)} ${msg}`);
    if (!this.verbose || this.quiet || this.nested !== undefined) return;
    const mark =
      kind === "change" ? "~" : kind === "defer" ? this.m.defer : kind === "skip" ? "-" : " ";
    this.out(this.dim(`     ${mark} ${msg}`));
  }

  /**
   * Record a problem (spec 105-calm-output FR-007, FR-009): a known raw error from another tool gets
   * its plain sentence, code and fix (spec 052) and keeps its raw text for the log and --verbose;
   * every problem has a code. In a calm run it is shown once, in the closing block; in a verbose
   * report also where it happened.
   */
  problem(level: ProblemLevel, phase: string, message: string, fix?: string, code?: string): void {
    let raw: string | undefined;
    const t = translate(message);
    if (t) {
      if (!code || code === t.code) {
        raw = message;
        message = EXPLAIN[t.code]?.title ?? message;
      }
      fix ||= t.fix;
      code ??= t.code;
    }
    // A fix that points at `explain <code>` says its code: it is shown as the code, once.
    const pointer = fix
      ? /\s*\(?\b(?:bun run stolos|stolos|archon) explain ([EP]\d{3}-[A-Z0-9-]+)\)?/.exec(fix)
      : null;
    if (pointer?.[1] && fix) {
      code ??= pointer[1];
      fix = fix.replace(pointer[0], "").replace(/[\s:;,]+$/, "");
    }
    code ??= GENERIC_CODE[level];
    const logLine = this.log(
      `   ${level === "pending" ? "TODO" : level === "action" ? "YOU" : level.toUpperCase()} ${message}${
        fix ? ` (${level === "pending" || level === "action" ? "next" : "fix"}: ${fix})` : ""
      } [${code}]${raw ? ` raw: ${raw.replace(/\n/g, " | ")}` : ""}`,
    );
    if (this.problems.some((p) => p.level === level && p.message === message)) return;
    this.problems.push({
      level,
      phase,
      message,
      ...(fix ? { fix } : {}),
      code,
      logLine,
      ...(raw !== undefined ? { raw } : {}),
    });
    // A nested run hands its problems to its parent; a calm run shows them once, at the end.
    if (this.nested !== undefined || this.mode !== "verbose") return;
    const mark = this.m[level];
    const text =
      level === "fail" ? this.red(message) : level === "warn" ? this.yellow(message) : message;
    this.out(`   ${mark} ${text}`);
  }

  /**
   * An outcome the person needs ("Sent: every server applies it within 15 minutes"): shown in a calm
   * run (a verbose one has it as a phase line), kept in the log, and handed to the parent of a nested run.
   */
  outcome(msg: string): void {
    this.log(`   OUT ${msg}`);
    if (this.outcomes.includes(msg)) return;
    this.outcomes.push(msg);
    if ((this.mode === "calm" || this.mode === "verbose") && this.nested === undefined)
      this.out(msg);
  }

  /**
   * A line shown now even by a nested run, for what is said right before the person is asked for
   * something (what is being signed, a passphrase that did not unlock): never in --quiet.
   */
  live(msg: string): void {
    this.log(`   ${msg}`);
    if (this.mode === "quiet" || this.mode === "json" || this.nested === "quiet") return;
    this.clearLine();
    this.write(`${msg}\n`);
  }

  /** An optional feature that is merely off: a hint, shown at most once per 7 days per id, always with --verbose. */
  hint(id: string, message: string, command?: string): void {
    this.log(`   HINT ${message}${command ? ` (${command})` : ""} [${id}]`);
    if (this.hints.some((h) => h.id === id)) return;
    this.hints.push({ id, message, ...(command ? { command } : {}) });
  }

  /** A progress bar, n of total. */
  private bar(n: number, total: number, width = 20): string {
    const filled = total ? Math.round((n / total) * width) : 0;
    const [a, b] = this.emoji ? ["█", "░"] : ["#", "-"];
    return `[${a.repeat(filled)}${b.repeat(width - filled)}]`;
  }

  /** Draw the current phase's line again (spinner, progress). */
  redraw(): void {
    if (!this.tty || this.quiet || this.nested !== undefined || !this.current) return;
    const p = this.current;
    const spin =
      (this.emoji ? SPIN.emoji : SPIN.ascii)[this.spinIndex % (this.emoji ? 10 : 4)] ?? "";
    let line = `${this.c("36", spin)} ${p.name.padEnd(16)}`;
    if (p.progress?.total) {
      line += ` ${this.bar(p.progress.n, p.progress.total)} ${p.progress.n}/${p.progress.total}`;
    }
    if (p.progress?.label) line += `  ${this.dim(p.progress.label)}`;
    const cols = (() => {
      try {
        const c = tty.consoleSize()?.columns ?? 0;
        return c >= 20 ? c : 100;
      } catch {
        return 100;
      }
    })();
    this.write(`\r\x1b[2K${truncate(line, cols - 1, this.color)}`);
  }

  /** Start the spinner (terminals only). */
  private startSpinner(): void {
    if (!this.tty || this.quiet || this.nested !== undefined || this.timer !== undefined) return;
    // A timer that never keeps the process alive, set again on each tick.
    const tick = (): void => {
      this.spinIndex++;
      this.redraw();
      this.timer = proc.unrefTimer(tick, 100);
    };
    this.timer = proc.unrefTimer(tick, 100);
  }

  /** Stop the spinner. */
  private stopSpinner(): void {
    this.timer?.clear();
    this.timer = undefined;
    // Nothing of the spinner stays in the scrollback (spec 105-calm-output FR-003).
    this.clearLine();
  }

  /** Called as each phase ends (the first boot reports progress to the boot server). */
  onPhaseEnd?: (name: string, level: string, summary: string) => void;
  /** Phase listeners (telemetry: each phase is a span). */
  readonly listeners: Array<{
    start?(name: string): void;
    end?(name: string, level: string, summary: string): void;
  }> = [];

  /** End a phase: its mark, name, result, and time. */
  endPhase(p: Phase): void {
    if (!this.phases.includes(p) || (p as { ended?: boolean }).ended) return;
    (p as { ended?: boolean }).ended = true;
    try {
      this.onPhaseEnd?.(p.name, p.level, p.summary());
      for (const l of this.listeners) l.end?.(p.name, p.level, p.summary());
    } catch {
      /* progress is best effort */
    }
    if (this.current === p) this.current = undefined;
    if (!this.current) this.stopSpinner();
    const took = this.now() - p.started;
    const time = took >= 5000 ? this.dim(` (${fmtDuration(took)})`) : "";
    const level = p.mark;
    const mark = this.m[level];
    const summary =
      level === "fail"
        ? this.red(p.summary())
        : level === "warn"
          ? this.yellow(p.summary())
          : p.summary();
    this.log(`-- ${p.name}: ${p.summary()} (${fmtDuration(took)})`);
    // Spec 106-one-passphrase-speed FR-010: the time of every phase, for the log only.
    this.log(`   TIME ${p.name} ${took}ms`);
    // Calm: a phase that went well is not printed; what did not is in the closing block.
    if (this.shows("step")) this.out(`${mark} ${this.bold(p.name.padEnd(16))} ${summary}${time}`);
    else this.clearLine();
  }

  /** Pause in-place drawing (for prompts). */
  /** One visible line under the current phase (a destination, a step done). */
  say(msg: string): void {
    this.log(`   ${msg}`);
    this.out(`   ${msg}`);
  }

  /** Stop drawing (another program uses the terminal, or a prompt is shown). */
  pause(): void {
    this.stopSpinner();
    this.clearLine();
  }
  /** Draw again after pause(). */
  resume(): void {
    if (this.current) this.startSpinner();
  }

  /**
   * Ask a question at the terminal without fighting the spinner, and give the line typed (without
   * its line ending), or undefined where standard input is not a terminal or ends first. The
   * portable form of `prompt()`, which Node does not have.
   */
  async ask(question: string): Promise<string | undefined> {
    if (!tty.isTerminal("stdin")) return undefined;
    this.pause();
    this.write(`${question} `);
    const answer = await readLine();
    this.resume();
    this.log(`?  ${question} -> ${answer === undefined ? "(no answer)" : "(answered)"}`);
    return answer;
  }

  /** Ask a yes/no question without fighting the spinner: yes only for `y` or `yes`. */
  async confirm(question: string): Promise<boolean> {
    const answer = await this.ask(`\n${question} [y/N]`);
    const yes = answer !== undefined && /^y(es)?$/i.test(answer.trim());
    this.log(`?  ${question} -> ${yes ? "yes" : "no"}`);
    return yes;
  }

  /**
   * Print the closing block and return the exit code (spec 105-calm-output FR-006). In order:
   * problems, your move, waiting, hints, the verdict line (counts, or the root cause of a failure),
   * then at most one `next:` line. A nested run prints nothing: it hands its problems to its parent.
   */
  finish(o: { title?: string; next?: string[] } = {}): number {
    if (this.current) this.endPhase(this.current);
    this.stopSpinner();
    const fails = this.problems.filter((p) => p.level === "fail");
    // A run nested in this process hands what it found to its parent, which draws it once.
    if (this.scope) {
      this.scope.summary = this.summarize();
      return fails.length ? 1 : 0;
    }
    // Once per run: a command that ends with its own summary, run by main (which
    // ends every operation with one), would otherwise print it twice.
    if (this.finished) return fails.length ? 1 : 0;
    this.finished = true;
    // A caller that ran this as a step (stolos update runs boot doctor) reads every problem.
    const summaryFile = env("STOLOS_SUMMARY");
    if (summaryFile !== undefined) {
      try {
        // A nested run hands the secrets reminder to its parent as one thing to do.
        fs.writeTextFileSync(summaryFile, JSON.stringify(this.summarize()));
      } catch (e) {
        console.error(`could not write ${summaryFile}: ${(e as Error).message}`);
      }
    }
    const warns = this.problems.filter((p) => p.level === "warn");
    const pending = this.problems.filter((p) => p.level === "pending");
    const actions = this.problems.filter((p) => p.level === "action");
    const code = fails.length ? 1 : 0;
    const closeLog = (): void => {
      this.log(`   TIME total ${this.now() - this.started}ms`);
      this.log(
        `== finished: ${fails.length} failure(s), ${warns.length} warning(s), ${pending.length} not set up yet, ${actions.length} for you to do, ${
          this.deferred.length
        } deferred`,
      );
      try {
        this.logFile?.close();
      } catch {
        /* closed */
      }
      this.logFile = undefined;
    };
    if (this.nested !== undefined || this.mode === "json") {
      closeLog();
      return code;
    }
    const root = fails[0];
    const secrets = this.takePanel();
    const shownHints = this.hintsToShow();
    const lines: string[] = [];
    const say = (l: string): void => void lines.push(l);
    const showProblem = (p: Problem): void => {
      const msg =
        p.level === "fail"
          ? this.red(p.message)
          : p.level === "warn"
            ? this.yellow(p.message)
            : p.message;
      say(`${this.m[p.level]} ${msg}${p.code ? this.dim(` [${p.code}]`) : ""}`);
      const f = splitFix(p.fix);
      if (f.say) say(`   ${f.say}`);
      if (f.cmd)
        say(
          `   ${this.dim(`${p.level === "fail" || p.level === "warn" ? "fix" : "run"}: ${f.cmd}`)}`,
        );
      if (this.verbose && p.raw) say(`   ${this.dim(`raw: ${p.raw}`)}`);
      if (this.verbose && this.logPath && p.logLine) {
        say(`   ${this.dim(`log: ${this.logPath}:${p.logLine}`)}`);
      }
    };
    if (this.deferred.length) {
      say(
        `${this.m.defer} ${this.deferred.length} disruptive change${
          this.deferred.length > 1 ? "s" : ""
        } left for later`,
      );
      say(`   ${this.dim(this.deferHint)}`);
    }
    // 1. Problems (the root cause of a failure is the verdict, not listed twice).
    for (const p of [...fails.slice(1), ...warns]) showProblem(p);
    // 2. Your move.
    for (const p of actions) showProblem(p);
    if (secrets) showProblem(secrets);
    // 3. Not set up yet: only what waits on time or on someone else.
    for (const p of pending) showProblem(p);
    // 4. Hints.
    for (const h of shownHints) {
      say(`${palette.MARKS.hint[this.emoji ? "emoji" : "ascii"]} ${h.message}`);
      if (h.command) say(`   ${this.dim(`run: ${h.command}`)}`);
    }
    // Steps a command spells out for the person ("then: power on alpha"): lines of their own; the one
    // line that is a `next:` is a candidate for the closing next line, and holds only the command.
    let suggested: string | undefined;
    for (const e of o.next ?? this.next) {
      const m = /^next:\s*(.+)$/.exec(e);
      if (m?.[1]) suggested ??= splitFix(m[1]).cmd ?? m[1];
      else say(`   ${this.dim(e.replace(/^then:\s*/, ""))}`);
    }
    // 5. The verdict, with counts; a failure is its own cause.
    const forYou = actions.length + (secrets ? 1 : 0);
    let verdict: string;
    if (root) {
      verdict = `${this.m.bad} ${this.red(root.message)}${root.code ? this.dim(` [${root.code}]`) : ""}`;
    } else {
      const parts = [o.title ?? this.verdictTitle ?? "Up to date"];
      if (warns.length) parts.push(`${warns.length} warning${warns.length > 1 ? "s" : ""}`);
      if (forYou) parts.push(`${forYou} for you`);
      if (pending.length) parts.push(`${pending.length} waiting`);
      if (shownHints.length) parts.push(`${shownHints.length} optional`);
      verdict = `${this.m.done} ${this.green(parts.join(" · "))}`;
    }
    const rootFix = splitFix(root?.fix);
    if (root && rootFix.say) say(`   ${rootFix.say}`);
    if (this.verbose && this.logPath) say(this.dim(`   log: ${this.logPath}`));
    // 6. Exactly one next: the one command of the failure, else the most important thing for you.
    const nextCmd =
      rootFix.cmd ??
      (root
        ? undefined
        : (splitFix(actions[0]?.fix).cmd ??
          (secrets ? splitFix(secrets.fix).cmd : undefined) ??
          suggested));
    if (this.mode === "quiet") {
      (this.customWrite ? this.write : this.screen)(`${verdict}\n`);
    } else {
      this.out("");
      for (const l of lines) this.out(l);
      this.out(verdict);
      if (nextCmd) this.out(`next: ${nextCmd}`);
    }
    closeLog();
    return code;
  }

  /** What this run found, as a parent wants it: every problem (a nested run's secrets reminder as one more), the outcomes, the counts. */
  private summarize(): RunSummary {
    const count = (l: Problem["level"]): number =>
      this.problems.filter((p) => p.level === l).length;
    const nestedPanel = this.nested !== undefined ? this.takePanel(true) : undefined;
    return {
      fails: count("fail"),
      warns: count("warn"),
      pending: count("pending"),
      actions: count("action"),
      problems: [...this.problems, ...(nestedPanel ? [nestedPanel] : [])],
      outcomes: [...this.outcomes],
    };
  }

  /**
   * Run `fn` as a run nested in this one, in this process (spec 106-one-passphrase-speed FR-006):
   * what a child process does by its environment (no header, no summary, no log of its own), with
   * this run's phases, problems, outcomes, hints and secrets reminder set aside until it ends.
   * Gives what `fn` returned and what it found, as the child's `STOLOS_SUMMARY` would have.
   */
  async nestedRun<T>(fn: () => Promise<T>): Promise<{ value: T; summary: RunSummary }> {
    this.pause();
    const saved = {
      problems: this.problems.splice(0),
      outcomes: this.outcomes.splice(0),
      deferred: this.deferred.splice(0),
      hints: this.hints.splice(0),
      phases: this.phases,
      current: this.current,
      finished: this.finished,
      nested: this.nested,
      scope: this.scope,
      panel: this.panel,
      panelShown: this.panelShown,
      next: this.next,
      verdictTitle: this.verdictTitle,
    };
    const scope: { summary?: RunSummary } = {};
    this.phases = [];
    this.current = undefined;
    this.finished = false;
    this.scope = scope;
    this.panel = undefined;
    this.panelShown = false;
    this.next = [];
    this.nested =
      this.mode === "quiet" || this.mode === "json"
        ? "quiet"
        : this.mode === "verbose"
          ? "verbose"
          : "calm";
    try {
      const value = await fn();
      if (this.current) this.endPhase(this.current);
      return { value, summary: scope.summary ?? this.summarize() };
    } finally {
      this.stopSpinner();
      this.problems.splice(0, this.problems.length, ...saved.problems);
      this.outcomes.splice(0, this.outcomes.length, ...saved.outcomes);
      this.deferred.splice(0, this.deferred.length, ...saved.deferred);
      this.hints.splice(0, this.hints.length, ...saved.hints);
      this.phases = saved.phases;
      this.current = saved.current;
      this.finished = saved.finished;
      this.nested = saved.nested;
      this.scope = saved.scope;
      this.panel = saved.panel;
      this.panelShown = saved.panelShown;
      this.next = saved.next;
      this.verdictTitle = saved.verdictTitle;
      this.resume();
    }
  }

  /** The one line `--quiet` prints for a command that draws no phases of its own (spec 105-calm-output FR-002). */
  quietVerdict(command: string, code: number): void {
    (this.customWrite ? this.write : this.screen)(
      code === 0
        ? `${this.m.done} ${this.green(`${command}: up to date`)}\n`
        : `${this.m.bad} ${this.red(`${command} did not finish (exit code ${code})`)}\n`,
    );
  }

  /** The secrets backup panel as one thing for the person to do, once (spec 105-calm-output FR-017); undefined where the box is shown instead. */
  private takePanel(force = false): Problem | undefined {
    if (!this.panel || this.panelShown || (this.mode === "verbose" && !force)) return undefined;
    this.panelShown = true;
    const x = this.panel.summary;
    if (!x) return undefined;
    return {
      level: "action",
      phase: "Secrets",
      message: x.text,
      fix: x.command,
      code: "E105-BACKUP",
    };
  }

  /** The hints to show now: all with --verbose, none with --quiet, else those not shown in the last 7 days (and remember them). */
  private hintsToShow(): Hint[] {
    if (!this.hints.length || this.mode === "quiet") return [];
    if (this.mode === "verbose") return this.hints;
    const file = this.hintsFile === undefined ? defaultHintsFile() : this.hintsFile;
    const now = hintClock(this.now);
    const seen = file ? readHints(file) : {};
    const due = this.hints.filter((h) => now - (seen[h.id] ?? -Infinity) >= HINT_DAYS * 86_400_000);
    if (file && due.length) {
      for (const h of due) seen[h.id] = now;
      writeHints(file, seen);
    }
    return due;
  }
}

/** The clock hints are measured on: STOLOS_HINT_NOW (milliseconds, for tests), else the Ui's. */
function hintClock(now: () => number): number {
  return Number(env("STOLOS_HINT_NOW")) || now();
}

/**
 * The program's local state folder, never in Git: `%LOCALAPPDATA%\\stolos` on Windows, else
 * `~/.local/state/<program>` (spec 105-calm-output FR-008, spec 106-one-passphrase-speed FR-008).
 */
export function stateFolder(): string {
  const win = proc.build.os === "windows";
  return win
    ? `${env("LOCALAPPDATA") ?? `${env("USERPROFILE") ?? "C:"}\\AppData\\Local`}\\${logProgram}`
    : `${env("HOME") ?? "/tmp"}/.local/state/${logProgram}`;
}

/** Where this PC remembers when each hint was shown: `hints.json` in the program's local state folder (never in Git). */
export function defaultHintsFile(): string | null {
  return `${stateFolder()}${proc.build.os === "windows" ? "\\" : "/"}hints.json`;
}

/** The hints' times (id to milliseconds); empty where there is no file or it is unreadable. */
function readHints(file: string): Record<string, number> {
  try {
    const d: unknown = JSON.parse(fs.readTextFileSync(file));
    const out: Record<string, number> = {};
    if (typeof d === "object" && d !== null) {
      for (const [k, v] of Object.entries(d)) if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember the hints' times; best effort. */
function writeHints(file: string, seen: Record<string, number>): void {
  try {
    fs.mkdirSync(file.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
    fs.writeTextFileSync(file, JSON.stringify(seen));
  } catch {
    /* a hint shown twice is harmless */
  }
}

/** One line read from standard input, without its line ending; undefined where the input ends first. */
async function readLine(): Promise<string | undefined> {
  const dec = new TextDecoder();
  const one = new Uint8Array(1);
  let line = "";
  for (;;) {
    const n = await stdio.stdin.read(one);
    if (n === null) return line === "" ? undefined : line;
    const ch = dec.decode(one.subarray(0, n), { stream: true });
    if (ch === "\n") return line.replace(/\r$/, "");
    line += ch;
  }
}

/** Truncate to a visible width, ignoring ANSI escape sequences. */
export function truncate(s: string, width: number, ansi = true): string {
  if (!ansi) return s.length > width ? s.slice(0, width - 1) + "…" : s;
  let visible = 0;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      out += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible >= width - 1) return out + "…\x1b[0m";
    out += s[i];
    visible++;
  }
  return out;
}

/** The program writing logs: "stolos" on your PC, "archon" on a machine (spec 059). */
let logProgram = proc.build.os === "windows" ? "stolos" : "archon";
/** Set which program writes the run log (its folder is named after it), and names it in hints. */
export function setLogProgram(name: "stolos" | "archon"): void {
  logProgram = name;
}

/** How to explain a code where this runs: `bun run stolos explain <code>` on your PC, else `archon explain <code>`. */
export function explainHint(code: string): string {
  return logProgram === "stolos" ? `bun run stolos explain ${code}` : `archon explain ${code}`;
}

/** How long run logs are kept (spec 019 FR-002). */
export const RUN_LOG_DAYS = 30;

/**
 * Remove the run logs (`*.log`) in `dir` older than `days` (spec 019: kept 30 days), by their
 * modification time. Root's folder is also pruned by tmpfiles.d (`30d`); a user's, and the Stolos
 * PC's, only here. Best effort: a file that cannot be removed stays. Returns the names removed.
 */
export function pruneRunLogs(dir: string, now = Date.now(), days = RUN_LOG_DAYS): string[] {
  const gone: string[] = [];
  let entries: fs.DirEntry[];
  try {
    entries = fs.readDirSync(dir);
  } catch {
    return gone;
  }
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(".log")) continue;
    const file = `${dir}/${e.name}`;
    try {
      const at = fs.statSync(file).mtime?.getTime();
      if (at !== undefined && now - at > days * 86_400_000) {
        fs.removeSync(file);
        gone.push(e.name);
      }
    } catch {
      /* best effort */
    }
  }
  return gone;
}

/**
 * Where this run's log goes: /var/log/archon as root; else the program's folder
 * (Windows: %LOCALAPPDATA%\\stolos\\log; Linux: ~/.local/state/<program>/log). Logs older than
 * 30 days in that folder are removed first (spec 019).
 */
export function defaultLogPath(): string | null {
  const inherited = env("ARCHON_LOG");
  if (inherited !== undefined) return inherited;
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const dir = logDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    pruneRunLogs(dir);
    return `${dir}${proc.build.os === "windows" ? "\\" : "/"}${stamp}-${proc.pid}.log`;
  } catch {
    return null;
  }
}

/** The folder the program's run logs are in (spec 105-calm-output FR-010: `stolos log` reads the newest). */
export function logDir(): string {
  const win = proc.build.os === "windows";
  return win
    ? `${
        env("LOCALAPPDATA") ?? `${env("USERPROFILE") ?? "C:"}\\AppData\\Local`
      }\\${logProgram}\\log`
    : asRoot()
      ? P.log
      : `${env("HOME") ?? "/tmp"}/.local/state/${logProgram}/log`;
}

/** The newest run log in the folder (by modification time), or undefined. */
export function lastLogPath(dir = logDir()): string | undefined {
  let best: { file: string; at: number } | undefined;
  try {
    for (const e of fs.readDirSync(dir)) {
      if (!e.isFile || !e.name.endsWith(".log")) continue;
      const file = `${dir}${proc.build.os === "windows" ? "\\" : "/"}${e.name}`;
      const at = fs.statSync(file).mtime?.getTime() ?? 0;
      if (!best || at >= best.at) best = { file, at };
    }
  } catch {
    return undefined;
  }
  return best?.file;
}

/**
 * `--quiet` (spec 105-calm-output FR-002): nothing but the verdict line reaches the screen, so what
 * a command writes itself is held back until the run ends. Returns the function that restores it.
 */
export function muteOutput(): () => void {
  const out = stdio.stdout.writeSync.bind(stdio.stdout);
  const err = stdio.stderr.writeSync.bind(stdio.stderr);
  const log = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const none = (): number => 0;
  stdio.stdout.writeSync = none;
  stdio.stderr.writeSync = none;
  console.log = console.info = console.warn = console.error = (): void => {};
  return () => {
    stdio.stdout.writeSync = out;
    stdio.stderr.writeSync = err;
    Object.assign(console, log);
  };
}

/** The process-wide UI. */
export const ui = new Ui();
