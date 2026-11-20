/**
 * `archon pg admin-tui` (rainfrog) and `archon pg observe-tui` (pgcenter top):
 * each finds the instance the way `archon pg show` does (an instance Archon
 * keeps, any cluster here, or a service section) and starts the tool already
 * connected. On this server: the socket and you as yourself (peer, no
 * password). With --remote: the published name over TLS, verify-full against
 * the system's roots. A password never goes on a command line (other users
 * see those in ps): rainfrog asks for it; pgcenter gets it from ~/.pgpass or,
 * asked here, in its own environment only.
 *
 * @module
 */

import { fs, path as paths, proc, stdio, tty } from "@intellectual-frontiers/system";
import { homeOf, run } from "../core/exec.ts";
import { entryServes, findTarget, parsePgpass, readSecret, type Target } from "./connections.ts";

/** Ubuntu's bundle of trusted roots (what libpq's sslrootcert=system means on Linux). */
export const SYSTEM_ROOTS = "/etc/ssl/certs/ca-certificates.crt";

/** The terminal tools: what each is for, and the command that starts it. */
export const TUIS = {
  rainfrog: { what: "rainfrog (browse, query, edit)", command: "archon pg admin-tui" },
  pgcenter: {
    what: "pgcenter top (activity, statements, waits)",
    command: "archon pg observe-tui",
  },
} as const;
/** A terminal tool's name: rainfrog or pgcenter. */
export type Tui = keyof typeof TUIS;

const enc = encodeURIComponent;

/** rainfrog's --url (sqlx): the socket through the host parameter, or TLS verify-full. */
export function rainfrogArgs(t: Target): string[] {
  const base = `postgres://${enc(t.user)}@`;
  const url = t.network
    ? `${base}${t.host}:${t.port}/${enc(t.database)}?sslmode=verify-full&sslrootcert=${enc(
        SYSTEM_ROOTS,
      )}`
    : `${base}localhost:${t.port}/${enc(t.database)}?host=${enc(t.host)}&sslmode=disable`;
  return ["--driver", "postgres", "--url", url];
}

/** pgcenter top (pgx): libpq's flags, and TLS through libpq's environment variables. */
export function pgcenterArgs(t: Target): { args: string[]; env: Record<string, string> } {
  return {
    args: ["top", "-h", t.host, "-p", String(t.port), "-U", t.user, "-d", t.database],
    env: t.network
      ? { PGSSLMODE: "verify-full", PGSSLROOTCERT: SYSTEM_ROOTS }
      : { PGSSLMODE: "disable" },
  };
}

/** Whether the person's password file has a usable line for this target. */
async function inPgpass(t: Target): Promise<boolean> {
  const me = (await run(["id", "-un"])).stdout.trim();
  const path =
    proc.env.get("PGPASSFILE") || paths.join(proc.env.get("HOME") ?? (await homeOf(me)), ".pgpass");
  try {
    const st = await fs.stat(path);
    if (st.mode !== null && (st.mode & 0o077) !== 0) return false; // libpq ignores it
    return parsePgpass(await fs.readTextFile(path)).some((e) =>
      entryServes(e, {
        host: t.host,
        port: String(t.port),
        database: t.database,
        user: t.user,
      }),
    );
  } catch {
    return false;
  }
}

/**
 * Start a terminal tool connected to NAME and return its exit code: 2 without
 * a terminal or a password, 1 when the tool is missing or NAME is not found.
 */
export async function pgTui(
  hostName: string,
  tool: Tui,
  name: string,
  remote: boolean,
): Promise<number> {
  if (!tty.isTerminal("stdin") || !tty.isTerminal("stdout")) {
    stdio.stderr.writeSync(
      `${TUIS[tool].command} needs a terminal: ${TUIS[tool].what} is full screen.\n`,
    );
    return 2;
  }
  if (!(await run(["sh", "-c", `command -v ${tool}`])).ok) {
    stdio.stderr.writeSync(
      `${tool} is not installed here (the tool catalog installs it: archon tools sync).\n`,
    );
    return 1;
  }
  const t = await findTarget(hostName, name, remote);
  if (typeof t === "string") {
    stdio.stderr.writeSync(`${t}\n`);
    return 1;
  }
  let args: string[];
  let env: Record<string, string> = {};
  if (tool === "rainfrog") args = rainfrogArgs(t);
  else {
    ({ args, env } = pgcenterArgs(t));
    if (t.network && !(await inPgpass(t))) {
      const pw = await readSecret(`Password for ${t.user} on ${t.host}: `);
      if (!pw) {
        stdio.stderr.writeSync("No password given.\n");
        return 2;
      }
      env["PGPASSWORD"] = pw; // this process's child only: never argv, a file, or a log
    }
  }
  stdio.stderr.writeSync(
    `${TUIS[tool].what}: ${t.user}@${
      t.network ? `${t.host}:${t.port} (TLS, verify-full)` : `${name} through ${t.host} (peer)`
    }, database ${t.database}\n`,
  );
  const child = proc.spawn([tool, ...args], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await child.status).code;
}
