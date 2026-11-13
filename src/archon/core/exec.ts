// Process execution through Deno.Command. Archon calls Debian's own binaries
// (apt-get, systemctl, nft, useradd, ...) directly, never through a shell.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  /** Run as this user via runuser(1) (requires root). */
  asUser?: string;
  /** Stream output to the terminal instead of capturing it. */
  inherit?: boolean;
}

/** A user's home directory from the account database (or "/"). */
export async function homeDir(user: string): Promise<string> {
  try {
    const c = await new Deno.Command("getent", {
      args: ["passwd", user],
      stdout: "piped",
      stderr: "null",
    })
      .output();
    return new TextDecoder().decode(c.stdout).trim().split(":")[5] || "/";
  } catch {
    return "/";
  }
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  let cmd = argv;
  let cwd = opts.cwd;
  if (opts.asUser && opts.asUser !== currentUser()) {
    cmd = ["runuser", "-u", opts.asUser, "--", ...argv];
    // Spec 009: never inherit root's working directory, which the target user
    // usually cannot read (chezmoi failed with "stat .: permission denied").
    cwd ??= await homeDir(opts.asUser);
  }
  try {
    const c = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd,
      env: opts.env,
      stdin: opts.stdin !== undefined ? "piped" : "null",
      stdout: opts.inherit ? "inherit" : "piped",
      stderr: opts.inherit ? "inherit" : "piped",
    });
    const child = c.spawn();
    if (opts.stdin !== undefined) {
      const w = child.stdin.getWriter();
      await w.write(new TextEncoder().encode(opts.stdin));
      await w.close();
    }
    const r = await child.output();
    const dec = new TextDecoder();
    return {
      code: r.code,
      ok: r.code === 0,
      stdout: opts.inherit ? "" : dec.decode(r.stdout),
      stderr: opts.inherit ? "" : dec.decode(r.stderr),
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { code: 127, ok: false, stdout: "", stderr: `${cmd[0]}: command not found` };
    }
    throw e;
  }
}

/** Run and throw on failure. */
export async function must(argv: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(argv, opts);
  if (!r.ok) {
    throw new Error(`${argv.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

export async function which(bin: string): Promise<string | undefined> {
  for (const dir of (Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin").split(":")) {
    try {
      const p = `${dir}/${bin}`;
      const s = await Deno.stat(p);
      if (s.isFile) return p;
    } catch { /* keep looking */ }
  }
  return undefined;
}

export function isRoot(): boolean {
  return Deno.uid?.() === 0;
}

export function currentUser(): string {
  return Deno.env.get("USER") ?? Deno.env.get("LOGNAME") ?? "";
}

/**
 * Split a command line into argv without invoking a shell. Supports single
 * and double quotes. Verification commands (archon:verifiedBy) use this.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | undefined;
  let has = false;
  for (const ch of line) {
    if (q) {
      if (ch === q) q = undefined;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (q) throw new Error(`unterminated quote in: ${line}`);
  if (cur || has) out.push(cur);
  return out;
}

/**
 * Run a command and receive its output line by line (for progress bars).
 * Returns the exit code; nothing reaches the terminal.
 */
export async function stream(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    cwd?: string;
    onLine: (line: string, from: "stdout" | "stderr") => void;
  },
): Promise<number> {
  let child;
  try {
    child = new Deno.Command(argv[0], {
      args: argv.slice(1),
      env: opts.env,
      cwd: opts.cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      opts.onLine(`${argv[0]}: command not found`, "stderr");
      return 127;
    }
    throw e;
  }
  const pump = async (rs: ReadableStream<Uint8Array>, from: "stdout" | "stderr") => {
    let buf = "";
    for await (const chunk of rs.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let i;
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) opts.onLine(line, from);
      }
    }
    if (buf.trim()) opts.onLine(buf, from);
  };
  await Promise.all([pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]);
  return (await child.status).code;
}
