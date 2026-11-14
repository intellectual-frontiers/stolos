/**
 * Calm output (Article XXII, spec 018): quiet on success, loud and actionable
 * on problems, full detail always in the log. Native Deno only.
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
import { translate } from "./explain.ts";

// ARCHON_VERBOSE=1 (or -v): every item is shown, dimmed, as it happens.
// --json: nothing on screen; the log file still records everything.

/** How a phase ended: ok, with warnings, failed, deferred (a disruptive change left for later), or skipped. */
export type Level = "ok" | "warn" | "fail" | "defer" | "skip";

/**
 * Spec 052: four states, the same everywhere. "fail" and "warn" are problems;
 * "pending" is something not set up yet, expected until someone does it (a
 * token not pushed, a certificate not issued yet): shown with its next step,
 * never a failure, never counted as a warning.
 */
export type ProblemLevel = "warn" | "fail" | "pending";

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
  /** Where output goes; default: stdout. */
  write?: (s: string) => void;
  /** The run's log file (null: none). */
  logPath?: string | null;
  /** The clock, in milliseconds (tests give their own). */
  now?: () => number;
}

const env = (k: string) => {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined;
  }
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
  if (env("ARCHON_PLAIN")) return false;
  if (env("ARCHON_EMOJI")) return true;
  if (utf8Locale()) return true;
  if (Deno.build.os === "windows") {
    return !!(env("WT_SESSION") || env("TERM_PROGRAM") || env("ConEmuANSI") === "ON");
  }
  return Deno.build.os === "darwin" && !!env("TERM_PROGRAM");
}

const MARKS = {
  emoji: {
    ok: "✅",
    warn: "⚠️ ",
    fail: "❌",
    pending: "⏳",
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
    pending: "[todo]",
    defer: "[defer]",
    skip: "[skip]",
    start: "==>",
    done: "==>",
    bad: "!!",
  },
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
  /** A phase of `ui`, named `name`; started by {@link Ui.phase}. */
  constructor(readonly name: string, readonly ui: Ui) {
    this.started = ui.now();
  }
  /** Update the progress bar (n of total) with a short label. */
  step(n: number, total: number, label = "") {
    this.progress = { n, total, label };
    this.ui.redraw();
  }
  /** A label without a known total (spinner only). */
  status(label: string) {
    this.progress = { n: 0, total: 0, label };
    this.ui.redraw();
  }
  /** A change it made. */
  change(msg: string) {
    this.changes++;
    this.ui.item("change", msg);
  }
  /** An item already right. */
  ok(msg: string) {
    this.oks++;
    this.ui.item("ok", msg);
  }
  /** An item it skipped. */
  skip(msg: string) {
    this.skipped++;
    this.ui.item("skip", msg);
  }
  /** A disruptive change left for later (shown with how to run it). */
  defer(msg: string) {
    this.deferred++;
    this.ui.deferred.push(msg);
    this.ui.item("defer", msg);
  }
  /** A warning: shown, with its fix and code; never fails the run. */
  warn(msg: string, fix?: string, code?: string) {
    this.warns++;
    this.ui.problem("warn", this.name, msg, fix, code);
  }
  /** A failure: shown, with its fix and code; the run exits 1. */
  fail(msg: string, fix?: string, code?: string) {
    this.fails++;
    this.ui.problem("fail", this.name, msg, fix, code);
  }
  /** Not set up yet (spec 052): its next step; never a failure or a warning. */
  pending(msg: string, next: string, code?: string) {
    this.pendings++;
    this.ui.problem("pending", this.name, msg, next, code);
  }
  /** Detail for the log only (shown dimmed with --verbose). */
  note(msg: string) {
    this.ui.item("note", msg);
  }
  /** Set the one-line result shown when the phase ends. */
  done(result?: string) {
    if (result !== undefined) this.result = result;
    this.ui.endPhase(this);
  }
  /** How it ended: fail when anything failed, else warn, else ok. */
  get level(): Level {
    return this.fails ? "fail" : this.warns ? "warn" : "ok";
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
  /** The clock (milliseconds). */
  readonly now: () => number;
  /** When the run started. */
  readonly started: number;
  /** Every problem so far. */
  readonly problems: Problem[] = [];
  /** Every disruptive change left for later. */
  readonly deferred: string[] = [];
  /** How to run the deferred changes. */
  deferHint = "run from the console or AMT: sudo archon apply --include-disruptive";
  /** Suggested next steps printed under the closing line. */
  next: string[] = [];
  /** The secrets backup panel (spec 029), shown once: by finish, or by the entry point on exit. */
  panel?: { lines: string[]; level: "amber" | "red" };
  private panelShown = false;

  /** Print the backup panel, once (calm: one panel per run). */
  printPanel(): void {
    if (!this.panel || this.panelShown) return;
    this.panelShown = true;
    const color = this.panel.level === "red" ? this.red : this.yellow;
    this.out("");
    for (const l of this.panel.lines) this.out(color(l));
  }
  /** The run's log file. */
  logPath: string | null;
  private current?: Phase;
  private phases: Phase[] = [];
  private write: (s: string) => void;
  private logFile?: Deno.FsFile;
  private logLines = 0;
  private spinIndex = 0;
  private timer?: ReturnType<typeof setInterval>;
  private enc = new TextEncoder();
  /** The terminal is gone (an SSH session dropped); output goes only to the run log. */
  detached = false;

  /** A Ui with these options (see {@link UiOptions}). */
  constructor(o: UiOptions = {}) {
    this.tty = o.tty ?? Deno.stderr.isTerminal();
    this.color = o.color ?? (!env("NO_COLOR") && (this.tty || !!env("FORCE_COLOR")));
    this.emoji = o.emoji ?? emojiTerminal();
    this.verbose = o.verbose ?? !!env("ARCHON_VERBOSE");
    this.quiet = o.quiet ?? false;
    this.now = o.now ?? Date.now;
    this.started = Number(env("ARCHON_UI_START")) || this.now();
    this.write = o.write ?? ((s) => {
      // After the terminal goes away (an SSH session dropped mid-run) keep
      // going: the run log still records everything.
      if (this.detached) return;
      try {
        Deno.stderr.writeSync(this.enc.encode(s));
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
  dim = (s: string) => this.c("2", s);
  /** Bold text. */
  bold = (s: string) => this.c("1", s);
  /** Red text (failures). */
  red = (s: string) => this.c("31", s);
  /** Yellow text (warnings). */
  yellow = (s: string) => this.c("33", s);
  /** Green text (success). */
  green = (s: string) => this.c("32", s);
  /** Cyan text. */
  cyan = (s: string) => this.c("36", s);
  /** Blue text. */
  blue = (s: string) => this.c("34", s);
  /** Magenta text. */
  magenta = (s: string) => this.c("35", s);

  /** Open the run log lazily (operations only). */
  private openLog() {
    if (this.logFile || this.logPath === null) return;
    try {
      this.logFile = Deno.openSync(this.logPath, { create: true, append: true });
    } catch {
      this.logPath = null;
    }
  }

  /** Start logging to a file (call before the first phase). */
  useLog(path: string | null) {
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
  private clearLine() {
    if (this.tty) this.write("\r\x1b[2K");
  }

  /** Write a line on screen (and in the log). */
  private out(line: string) {
    if (this.quiet) return;
    this.clearLine();
    this.write(line + "\n");
    this.redraw();
  }

  /** The run's header: its title and what it acts on. */
  header(title: string, subtitle = "") {
    this.log(`== ${title}${subtitle ? ` · ${subtitle}` : ""}`);
    if (env("ARCHON_UI_CONTINUE")) return;
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
      } catch { /* telemetry is best effort */ }
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
  item(kind: "change" | "ok" | "skip" | "defer" | "note", msg: string) {
    this.log(`   ${kind.padEnd(6)} ${msg}`);
    if (!this.verbose || this.quiet) return;
    const mark = kind === "change"
      ? "~"
      : kind === "defer"
      ? this.m.defer
      : kind === "skip"
      ? "-"
      : " ";
    this.out(this.dim(`     ${mark} ${msg}`));
  }

  /** Record a problem: shown now, and again when the run ends. A known raw error from another tool gets its code and fix (spec 052). */
  problem(level: ProblemLevel, phase: string, message: string, fix?: string, code?: string) {
    // Spec 052: a raw tool error gets its plain cause and fix, when it is a known one.
    if (!fix || !code) {
      const t = translate(message);
      if (t) {
        fix ??= t.fix;
        code ??= t.code;
      }
    }
    const logLine = this.log(
      `   ${level === "pending" ? "TODO" : level.toUpperCase()} ${message}${
        fix ? ` (${level === "pending" ? "next" : "fix"}: ${fix})` : ""
      }${code ? ` [${code}]` : ""}`,
    );
    if (this.problems.some((p) => p.level === level && p.message === message)) return;
    this.problems.push({ level, phase, message, fix, ...(code ? { code } : {}), logLine });
    const mark = this.m[level];
    const text = level === "fail"
      ? this.red(message)
      : level === "warn"
      ? this.yellow(message)
      : message;
    this.out(`   ${mark} ${text}`);
  }

  /** A progress bar, n of total. */
  private bar(n: number, total: number, width = 20): string {
    const filled = total ? Math.round((n / total) * width) : 0;
    const [a, b] = this.emoji ? ["█", "░"] : ["#", "-"];
    return `[${a.repeat(filled)}${b.repeat(width - filled)}]`;
  }

  /** Draw the current phase's line again (spinner, progress). */
  redraw() {
    if (!this.tty || this.quiet || !this.current) return;
    const p = this.current;
    const spin = (this.emoji ? SPIN.emoji : SPIN.ascii)[this.spinIndex % (this.emoji ? 10 : 4)];
    let line = `${this.c("36", spin)} ${p.name.padEnd(16)}`;
    if (p.progress?.total) {
      line += ` ${this.bar(p.progress.n, p.progress.total)} ${p.progress.n}/${p.progress.total}`;
    }
    if (p.progress?.label) line += `  ${this.dim(p.progress.label)}`;
    const cols = (() => {
      try {
        const c = Deno.consoleSize().columns;
        return c >= 20 ? c : 100;
      } catch {
        return 100;
      }
    })();
    this.write(`\r\x1b[2K${truncate(line, cols - 1, this.color)}`);
  }

  /** Start the spinner (terminals only). */
  private startSpinner() {
    if (!this.tty || this.quiet || this.timer !== undefined) return;
    const t = setInterval(() => {
      this.spinIndex++;
      this.redraw();
    }, 100);
    this.timer = t;
    try {
      Deno.unrefTimer(t as unknown as number);
    } catch { /* older Deno */ }
  }

  /** Stop the spinner. */
  private stopSpinner() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Called as each phase ends (the first boot reports progress to the boot server). */
  onPhaseEnd?: (name: string, level: string, summary: string) => void;
  /** Phase listeners (telemetry: each phase is a span). */
  readonly listeners: Array<{
    start?(name: string): void;
    end?(name: string, level: string, summary: string): void;
  }> = [];

  /** End a phase: its mark, name, result, and time. */
  endPhase(p: Phase) {
    if (!this.phases.includes(p) || (p as { ended?: boolean }).ended) return;
    (p as { ended?: boolean }).ended = true;
    try {
      this.onPhaseEnd?.(p.name, p.level, p.summary());
      for (const l of this.listeners) l.end?.(p.name, p.level, p.summary());
    } catch { /* progress is best effort */ }
    if (this.current === p) this.current = undefined;
    if (!this.current) this.stopSpinner();
    const took = this.now() - p.started;
    const time = took >= 5000 ? this.dim(` (${fmtDuration(took)})`) : "";
    const mark = this.m[p.level];
    const summary = p.level === "fail"
      ? this.red(p.summary())
      : p.level === "warn"
      ? this.yellow(p.summary())
      : p.summary();
    this.log(`-- ${p.name}: ${p.summary()} (${fmtDuration(took)})`);
    this.out(`${mark} ${this.bold(p.name.padEnd(16))} ${summary}${time}`);
  }

  /** Pause in-place drawing (for prompts). */
  /** One visible line under the current phase (a destination, a step done). */
  say(msg: string) {
    this.log(`   ${msg}`);
    this.out(`   ${msg}`);
  }

  /** Stop drawing (another program uses the terminal, or a prompt is shown). */
  pause() {
    this.stopSpinner();
    this.clearLine();
  }
  /** Draw again after pause(). */
  resume() {
    if (this.current) this.startSpinner();
  }

  /** Ask a yes/no question without fighting the spinner. */
  confirm(question: string): boolean {
    if (!Deno.stdin.isTerminal()) return false;
    this.pause();
    const answer = globalThis.confirm(`\n${question}`);
    this.resume();
    this.log(`?  ${question} -> ${answer ? "yes" : "no"}`);
    return answer;
  }

  /** Print the closing summary and return the exit code. */
  finish(o: { title?: string; next?: string[] } = {}): number {
    if (this.current) this.endPhase(this.current);
    this.stopSpinner();
    const fails = this.problems.filter((p) => p.level === "fail");
    // A caller that ran this as a step (stolos update runs boot doctor) reads the counts.
    const summaryFile = env("STOLOS_SUMMARY");
    if (summaryFile) {
      try {
        Deno.writeTextFileSync(
          summaryFile,
          JSON.stringify({
            fails: fails.length,
            warns: this.problems.filter((p) => p.level === "warn").length,
            pending: this.problems.filter((p) => p.level === "pending").length,
          }),
        );
      } catch (e) {
        console.error(`could not write ${summaryFile}: ${(e as Error).message}`);
      }
    }
    if (this.deferred.length) {
      this.out("");
      this.out(
        `${this.m.defer} ${"Deferred".padEnd(16)} ${this.deferred.length} disruptive change${
          this.deferred.length > 1 ? "s" : ""
        }`,
      );
      this.out(`   ${" ".repeat(16)} ${this.dim(this.deferHint)}`);
    }
    const rule = (title: string) =>
      this.bold(`${this.emoji ? "━━" : "=="} ${title} ${(this.emoji ? "━" : "=").repeat(40)}`);
    const show = (p: Problem) => {
      const msg = p.level === "fail"
        ? this.red(p.message)
        : p.level === "warn"
        ? this.yellow(p.message)
        : p.message;
      this.out(`${this.m[p.level]} ${this.bold(p.phase.toLowerCase().padEnd(14))} ${msg}`);
      if (p.fix) {
        this.out(
          `   ${" ".repeat(14)} ${this.dim(`${p.level === "pending" ? "next" : "fix"}: ${p.fix}`)}`,
        );
      }
      if (p.code) this.out(`   ${" ".repeat(14)} ${this.dim(`explain: ${explainHint(p.code)}`)}`);
      if (this.logPath && p.logLine && p.level !== "pending") {
        this.out(`   ${" ".repeat(14)} ${this.dim(`log: ${this.logPath}:${p.logLine}`)}`);
      }
    };
    const real = this.problems.filter((p) => p.level !== "pending");
    const pending = this.problems.filter((p) => p.level === "pending");
    if (real.length) {
      this.out("");
      this.out(rule("Needs attention"));
      real.forEach(show);
    }
    if (pending.length) {
      this.out("");
      this.out(rule("Not set up yet"));
      pending.forEach(show);
    }
    this.printPanel();
    const took = fmtDuration(this.now() - this.started);
    const where = this.logPath ? ` · log: ${this.logPath}` : "";
    this.out("");
    if (fails.length) {
      this.out(
        `${this.m.bad} ${
          this.red(
            `${o.title ?? "finished"} with ${fails.length} failure${fails.length > 1 ? "s" : ""}`,
          )
        } in ${took}${this.dim(where)}`,
      );
    } else {
      this.out(`${this.m.done} ${this.green(o.title ?? "done")} in ${took}${this.dim(where)}`);
    }
    for (const n of o.next ?? this.next) this.out(`   ${this.dim(n)}`);
    this.log(
      `== finished: ${fails.length} failure(s), ${
        this.problems.filter((p) => p.level === "warn").length
      } warning(s), ${pending.length} not set up yet, ${this.deferred.length} deferred`,
    );
    try {
      this.logFile?.close();
    } catch { /* closed */ }
    this.logFile = undefined;
    return fails.length ? 1 : 0;
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
let logProgram = Deno.build.os === "windows" ? "stolos" : "archon";
/** Set which program writes the run log (its folder is named after it), and names it in hints. */
export function setLogProgram(name: "stolos" | "archon"): void {
  logProgram = name;
}

/** How to explain a code where this runs: `deno task stolos explain <code>` on your PC, else `archon explain <code>`. */
export function explainHint(code: string): string {
  return logProgram === "stolos" ? `deno task stolos explain ${code}` : `archon explain ${code}`;
}

/**
 * Where this run's log goes: /var/log/archon as root; else the program's folder
 * (Windows: %LOCALAPPDATA%\\stolos\\log; Linux: ~/.local/state/<program>/log).
 */
export function defaultLogPath(): string | null {
  const inherited = env("ARCHON_LOG");
  if (inherited) return inherited;
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const root = Deno.uid?.() === 0;
  // Windows: %LOCALAPPDATA%\stolos\log (beside boot.log), with Windows separators.
  const win = Deno.build.os === "windows";
  const sep = win ? "\\" : "/";
  const dir = win
    ? `${
      env("LOCALAPPDATA") ?? `${env("USERPROFILE") ?? "C:"}\\AppData\\Local`
    }\\${logProgram}\\log`
    : root
    ? "/var/log/archon"
    : `${env("HOME") ?? "/tmp"}/.local/state/${logProgram}/log`;
  try {
    Deno.mkdirSync(dir, { recursive: true });
    return `${dir}${sep}${stamp}-${Deno.pid}.log`;
  } catch {
    return null;
  }
}

/** The process-wide UI. */
export const ui = new Ui();
