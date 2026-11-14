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

export type Level = "ok" | "warn" | "fail" | "defer" | "skip";

/**
 * Spec 052: four states, the same everywhere. "fail" and "warn" are problems;
 * "pending" is something not set up yet, expected until someone does it (a
 * token not pushed, a certificate not issued yet): shown with its next step,
 * never a failure, never counted as a warning.
 */
export type ProblemLevel = "warn" | "fail" | "pending";

export interface Problem {
  level: ProblemLevel;
  phase: string;
  message: string;
  fix?: string;
  /** A stable code: archon explain <code> (spec 052). */
  code?: string;
  logLine?: number;
}

export interface UiOptions {
  tty?: boolean;
  color?: boolean;
  emoji?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  write?: (s: string) => void;
  logPath?: string | null;
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

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

export class Phase {
  changes = 0;
  oks = 0;
  warns = 0;
  fails = 0;
  pendings = 0;
  deferred = 0;
  skipped = 0;
  result?: string;
  progress?: { n: number; total: number; label: string };
  readonly started: number;
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
  change(msg: string) {
    this.changes++;
    this.ui.item("change", msg);
  }
  ok(msg: string) {
    this.oks++;
    this.ui.item("ok", msg);
  }
  skip(msg: string) {
    this.skipped++;
    this.ui.item("skip", msg);
  }
  defer(msg: string) {
    this.deferred++;
    this.ui.deferred.push(msg);
    this.ui.item("defer", msg);
  }
  warn(msg: string, fix?: string, code?: string) {
    this.warns++;
    this.ui.problem("warn", this.name, msg, fix, code);
  }
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
  get level(): Level {
    return this.fails ? "fail" : this.warns ? "warn" : "ok";
  }
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

export class Ui {
  readonly tty: boolean;
  readonly color: boolean;
  readonly emoji: boolean;
  verbose: boolean;
  quiet: boolean;
  readonly now: () => number;
  readonly started: number;
  readonly problems: Problem[] = [];
  readonly deferred: string[] = [];
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

  private get m() {
    return this.emoji ? MARKS.emoji : MARKS.ascii;
  }
  private c(code: string, s: string) {
    return this.color ? `\x1b[${code}m${s}\x1b[0m` : s;
  }
  dim = (s: string) => this.c("2", s);
  bold = (s: string) => this.c("1", s);
  red = (s: string) => this.c("31", s);
  yellow = (s: string) => this.c("33", s);
  green = (s: string) => this.c("32", s);
  cyan = (s: string) => this.c("36", s);
  blue = (s: string) => this.c("34", s);
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

  log(line: string): number {
    this.openLog();
    if (!this.logFile) return 0;
    for (const l of line.split("\n")) {
      this.logFile.writeSync(this.enc.encode(`${new Date().toISOString()} ${l}\n`));
      this.logLines++;
    }
    return this.logLines;
  }

  private clearLine() {
    if (this.tty) this.write("\r\x1b[2K");
  }

  private out(line: string) {
    if (this.quiet) return;
    this.clearLine();
    this.write(line + "\n");
    this.redraw();
  }

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

  private bar(n: number, total: number, width = 20): string {
    const filled = total ? Math.round((n / total) * width) : 0;
    const [a, b] = this.emoji ? ["█", "░"] : ["#", "-"];
    return `[${a.repeat(filled)}${b.repeat(width - filled)}]`;
  }

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

  pause() {
    this.stopSpinner();
    this.clearLine();
  }
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
      if (p.code) this.out(`   ${" ".repeat(14)} ${this.dim(`explain: archon explain ${p.code}`)}`);
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

/** Where this run's log goes: /var/log/archon as root, else ~/.local/state. */
export function defaultLogPath(): string | null {
  const inherited = env("ARCHON_LOG");
  if (inherited) return inherited;
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const root = Deno.uid?.() === 0;
  // Windows: %LOCALAPPDATA%\archon\log (beside boot.log), with Windows separators.
  const win = Deno.build.os === "windows";
  const sep = win ? "\\" : "/";
  const dir = win
    ? `${env("LOCALAPPDATA") ?? `${env("USERPROFILE") ?? "C:"}\\AppData\\Local`}\\archon\\log`
    : root
    ? "/var/log/archon"
    : `${env("HOME") ?? "/tmp"}/.local/state/archon/log`;
  try {
    Deno.mkdirSync(dir, { recursive: true });
    return `${dir}${sep}${stamp}-${Deno.pid}.log`;
  } catch {
    return null;
  }
}

/** The process-wide UI. */
export const ui = new Ui();
