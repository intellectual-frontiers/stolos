/**
 * The engine's way of running a program (spec 096-bun-runtime), on IFC TypeScript's `proc`. Archon
 * calls Ubuntu's own binaries (apt-get, systemctl, nft, useradd, ...) directly, by their argument
 * vector, never through a shell. Two things here are the engine's own, beyond `proc.run`:
 *
 * - a program that is not installed is an outcome, exit code 127 with "command not found", never an
 *   exception, so a check on a machine that lacks a tool reads like any other failure;
 * - `asUser` runs it as another account through runuser(1), from that account's home folder (spec
 *   009: never root's working directory, which the account usually cannot read).
 *
 * `stream` gives a program's output line by line as it comes (apt's progress), splitting on carriage
 * returns as well as line feeds. Everything else (`which`, `isRoot`, `must`, `splitArgs`) is IFC
 * TypeScript's: `proc.which`, `proc.isRoot`, `proc.must`, and the kernel's `splitArgs`.
 *
 * @example
 * ```ts
 * import { run } from "./exec.ts";
 * const r = await run(["systemctl", "is-active", "ssh"]);
 * if (r.code === 127) console.log("no systemd here");
 * ```
 *
 * @module
 */
// Spec: 096-bun-runtime
// Spec: 107-pairing-and-query FR-010
import { errors, proc } from "@intellectual-frontiers/commons/ts/runtime";

/** What a program did. */
export type RunResult = {
  /** The exit code (127 where the program is not installed). */
  readonly code: number;
  /** What it printed (empty with `inherit`). */
  readonly stdout: string;
  /** What it printed as errors (empty with `inherit`). */
  readonly stderr: string;
  /** Whether the exit code was 0. */
  readonly ok: boolean;
};

/** How to run a program. */
export type RunOptions = {
  /** Its working folder. */
  readonly cwd?: string;
  /** Variables added to its environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Text for its standard input. */
  readonly stdin?: string;
  /** Run it as this account through runuser(1) (needs root). */
  readonly asUser?: string;
  /** Its output goes to this process's terminal instead of being kept. */
  readonly inherit?: boolean;
  /** Stops it (SIGTERM, then SIGKILL) when the signal aborts: a time limit's way. */
  readonly signal?: AbortSignal;
};

/** The result of a program that is not installed. */
function notFound(program: string): RunResult {
  return { code: 127, ok: false, stdout: "", stderr: `${program}: command not found` };
}

/** An account's home folder from the account database (getent), or `/`. */
export async function homeOf(user: string): Promise<string> {
  const r = await run(["getent", "passwd", user]);
  return (r.ok ? r.stdout.trim().split(":")[5] : undefined) || "/";
}

/** This process's account name (`USER`, else `LOGNAME`), or "" where neither is set. */
export function currentUser(): string {
  return proc.env.get("USER") ?? proc.env.get("LOGNAME") ?? "";
}

/** Run a program, by its argument vector, to its end. Never throws for a program that is not installed (127). */
export async function run(argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  let cmd = argv;
  let cwd = opts.cwd;
  if (opts.asUser !== undefined && opts.asUser !== currentUser()) {
    cmd = ["runuser", "-u", opts.asUser, "--", ...argv];
    cwd ??= await homeOf(opts.asUser);
  }
  try {
    const r = await proc.run(cmd, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
      ...(opts.stdin === undefined ? {} : { input: opts.stdin }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal, killAfterMs: 2000 }),
      stdout: opts.inherit === true ? "inherit" : "piped",
      stderr: opts.inherit === true ? "inherit" : "piped",
    });
    return { code: r.code, ok: r.success, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    if (e instanceof errors.NotFound) return notFound(cmd[0] ?? "");
    throw e;
  }
}

/** A stream's text, line by line (split on `\r` and `\n`, blank lines dropped), to `onLine`. */
async function pump(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (stream === null) return;
  const dec = new TextDecoder();
  let buf = "";
  for await (const bytes of stream) {
    buf += dec.decode(bytes, { stream: true });
    for (let i = buf.search(/[\r\n]/); i >= 0; i = buf.search(/[\r\n]/)) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() !== "") onLine(line);
    }
  }
  buf += dec.decode();
  if (buf.trim() !== "") onLine(buf);
}

/**
 * Run a program and receive its output line by line as it comes (for progress bars); nothing
 * reaches the terminal. Gives the exit code (127 where the program is not installed).
 */
export async function stream(
  argv: readonly string[],
  opts: {
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
    readonly onLine: (line: string, from: "stdout" | "stderr") => void;
  },
): Promise<number> {
  let child: proc.Child;
  try {
    child = proc.spawn(argv, {
      ...(opts.env === undefined ? {} : { env: opts.env }),
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
  } catch (e) {
    if (e instanceof errors.NotFound) {
      opts.onLine(`${argv[0] ?? ""}: command not found`, "stderr");
      return 127;
    }
    throw e;
  }
  await Promise.all([
    pump(child.stdout, (l) => opts.onLine(l, "stdout")),
    pump(child.stderr, (l) => opts.onLine(l, "stderr")),
  ]);
  return (await child.status).code;
}
