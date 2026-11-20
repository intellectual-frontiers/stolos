/**
 * A sandbox for tests that run archon or the boot server as a subprocess.
 *
 * The child starts from a cleared environment: every per-user root Archon reads, on Linux (`HOME`,
 * `XDG_*`) and on Windows (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `OneDrive`), points inside a
 * temporary folder, and `ARCHON_SANDBOX` makes archon refuse to start if any of them escapes it.
 * Only what a process needs is passed through: `PATH`, Windows' system variables, temp folders and a
 * proxy. The child runs with the runtime of the test itself (Bun or Node, spec 096). Before a test
 * runs anything, `probe()` asks a child where its secrets, ledger, vault and logs resolve and fails
 * unless all are inside the sandbox; `fingerprint()` hashes the real archon folders so a test can
 * prove it left them untouched.
 *
 * Layout (the same on every OS): `<home>/config/stolos/secrets` (secrets),
 * `<home>/data/stolos/...` (boot cache, ledger, logs on Windows), `<home>/OneDrive`.
 *
 * @module
 */

import { sha256 } from "@intellectual-frontiers/crypto";
import { fs, path, proc } from "@intellectual-frontiers/system";
import { assert } from "@intellectual-frontiers/commons/ts/runtime/test";
import { runtimeCommand } from "../src/archon/install/bun.ts";

const PASS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "COMSPEC",
  "SystemDrive",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TERM",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
];

/** What a command run in the sandbox did: its exit code, and its output and error joined. */
export type SandboxResult = { readonly code: number; readonly out: string };

/** A temporary home for subprocess tests, and the way to run a script in it. */
export interface Sandbox {
  /** The sandbox's home folder (removed by the test when it is done). */
  readonly home: string;
  /** The whole environment a child is given. */
  readonly env: Record<string, string>;
  /** Runs `<runtime> <script> ...args` in the sandbox, with the runtime of the test itself. */
  run(
    script: string,
    args: readonly string[],
    stdin?: string,
    extra?: Readonly<Record<string, string>>,
  ): Promise<SandboxResult>;
}

/** How long a command in the sandbox may run before its test fails. */
const RUN_TIMEOUT_MS = 90_000;

/** A new sandbox, probed: it fails unless every path archon would touch resolves inside it. */
export async function sandbox(prefix = "archon-test-"): Promise<Sandbox> {
  // Its real path: macOS's temporary folder is reached through /var -> /private/var, Windows' as
  // a short name (RUNNER~1); a child that resolves its working directory sees the real one.
  const home = await fs.realPath(await fs.makeTempDir({ prefix }));
  const config = path.join(home, "config");
  const data = path.join(home, "data");
  const tmp = path.join(home, "tmp");
  for (const d of [config, data, tmp, path.join(home, "OneDrive")]) {
    await fs.mkdir(d, { recursive: true });
  }
  const env: Record<string, string> = {};
  for (const k of PASS) {
    const v = proc.env.get(k);
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    ARCHON_SANDBOX: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    APPDATA: config,
    LOCALAPPDATA: data,
    OneDrive: path.join(home, "OneDrive"),
    OneDriveConsumer: path.join(home, "OneDrive"),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    NO_COLOR: "1",
    ARCHON_PLAIN: "1",
  });
  const run = async (
    script: string,
    args: readonly string[],
    stdin = "",
    extra: Readonly<Record<string, string>> = {},
  ): Promise<SandboxResult> => {
    // A command that hangs fails its test, saying so, instead of stalling the suite.
    const stop = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, RUN_TIMEOUT_MS);
    const o = await proc
      .run([...runtimeCommand(), script, ...args], {
        env: { ...env, ...extra },
        clearEnv: true,
        input: stdin,
        signal: stop.signal,
        killAfterMs: 1000,
      })
      .finally(() => clearTimeout(timer));
    const out = o.stdout + o.stderr;
    if (timedOut) {
      return {
        code: 124,
        out: `${out}\n[sandbox] archon ${args.join(" ")} did not finish in ${
          RUN_TIMEOUT_MS / 1000
        }s: killed`,
      };
    }
    return { code: o.code, out };
  };
  await probe(home, run);
  return { home, env, run };
}

/** Fail fast unless every path archon would touch resolves inside the sandbox. */
async function probe(home: string, run: Sandbox["run"]): Promise<void> {
  const script = path.join(home, "probe.ts");
  const src = (rel: string): string => new URL(`../src/archon/${rel}`, import.meta.url).href;
  await fs.writeTextFile(
    script,
    `import { P } from ${JSON.stringify(src("core/paths.ts"))};
import { LEDGER, VAULT_LOCAL } from ${JSON.stringify(src("core/secret-ledger.ts"))};
import { PROMPT_STATUS } from ${JSON.stringify(src("vault/state.ts"))};
import { BACKUP_DIR } from ${JSON.stringify(src("vault/zip.ts"))};
import { defaultLogPath } from ${JSON.stringify(src("core/ui.ts"))};
console.log(JSON.stringify([P.secrets, P.bootCache, LEDGER, VAULT_LOCAL, PROMPT_STATUS, BACKUP_DIR, defaultLogPath()]));`,
  );
  const r = await run(script, []);
  assert(r.code === 0, `sandbox probe failed: ${r.out}`);
  const last = r.out.trim().split("\n").pop() ?? "[]";
  const parsed: unknown = JSON.parse(last);
  assert(Array.isArray(parsed), `sandbox probe printed no list: ${r.out}`);
  const root = home.toLowerCase();
  for (const p of parsed) {
    if (p === null) continue;
    assert(typeof p === "string", `sandbox probe printed a non-path: ${String(p)}`);
    // Logs as root on Linux go to /var/log/archon: not per-user state, allowed.
    if (p.startsWith("/var/log/archon")) continue;
    assert(p.toLowerCase().startsWith(root), `sandbox leak: ${p} is outside ${home}`);
  }
}

/**
 * A fingerprint of the real archon folders of the test process itself (the secrets' parent, and the
 * boot cache's parent): every file's path, size, and SHA-256. Equal before and after means the tests
 * left them byte for byte as they were. A boot server running at the same time owns boot.log and its
 * telemetry files, so those are left out.
 */
const OWNED_BY_A_RUNNING_SERVER = /[\\/](boot\.log(\.1)?|telemetry[\\/].*)$/;

/** Every file under the folders, with its size and SHA-256, one per line (see above); `leaveOut` too. */
export async function fingerprint(dirs: readonly string[], leaveOut?: RegExp): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries: fs.DirEntry[] = [];
    try {
      for await (const e of fs.readDir(d)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (OWNED_BY_A_RUNNING_SERVER.test(p) || leaveOut?.test(p) === true) continue;
      if (e.isDirectory) await walk(p);
      else if (e.isFile) {
        const data = await fs.readFile(p).catch(() => new Uint8Array());
        out.push(`${p} ${data.length} ${await sha256(data)}`);
      }
    }
  };
  for (const d of dirs) await walk(d);
  return out.join("\n");
}

/**
 * The helper OpenSSH runs for a passphrase (`SSH_ASKPASS`; tests stand in for a person typing it):
 * a shell script, or on Windows a `.cmd`, which OpenSSH for Windows can start (CreateProcess runs a
 * batch file, not a script: error 193). Its path.
 */
export async function askpassHelper(dir: string, passphrase: string): Promise<string> {
  if (proc.build.os === "windows") {
    const file = path.join(dir, "askpass.cmd");
    await fs.writeTextFile(file, `@echo ${passphrase}\r\n`);
    return file;
  }
  const file = path.join(dir, "askpass.sh");
  await fs.writeTextFile(file, `#!/bin/sh\necho '${passphrase}'\n`);
  await fs.chmod(file, 0o755);
  return file;
}

/** The engine checkout the tests run. */
export const ENGINE_ROOT: string = path
  .fromFileUrl(new URL("..", import.meta.url))
  .replace(/[\\/]$/, "");

/**
 * Make `repo` a fleet repository with the engine installed, as `bun install` would leave it:
 * `node_modules/@intellectual-frontiers/stolos` is this checkout (its package.json maps every path
 * under `src/`), so the fleet's files import the engine by its name, on Bun and on Node.
 */
export async function linkEngine(repo: string): Promise<void> {
  const scope = path.join(repo, "node_modules", "@intellectual-frontiers");
  await fs.mkdir(scope, { recursive: true });
  const link = path.join(scope, "stolos");
  if (!(await fs.exists(link))) await fs.symlink(ENGINE_ROOT, link, { type: "dir" });
}
