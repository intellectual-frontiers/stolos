// A sandbox for tests that run archon or the boot server as a subprocess.
//
// The child starts from a cleared environment (clearEnv): every per-user root
// Archon reads, on Linux (HOME, XDG_*) and on Windows (USERPROFILE, APPDATA,
// LOCALAPPDATA, OneDrive), points inside a temporary folder, and
// ARCHON_SANDBOX makes archon refuse to start if any of them escapes it. Only
// what a process needs is passed through: PATH, Windows' system variables,
// temp folders, a proxy, and Deno's own cache. Before a test runs anything,
// `probe()` asks a child where its secrets, ledger, vault, and logs resolve
// and fails unless all are inside the sandbox; `fingerprint()` hashes the real
// archon folders so a test can prove it left them untouched.
//
// Layout (the same on every OS): <home>/config/archon/secrets (secrets),
// <home>/data/archon/... (boot cache, ledger, logs on Windows), <home>/OneDrive.

import { assert } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";

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
  "DENO_CERT",
  "NODE_EXTRA_CA_CERTS",
];

let denoDir: string | undefined;

/** The parent's Deno cache, so the child does not download its dependencies again. */
async function parentDenoDir(): Promise<string | undefined> {
  if (denoDir !== undefined) return denoDir || undefined;
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  })
    .output();
  try {
    denoDir = JSON.parse(new TextDecoder().decode(o.stdout)).denoDir ?? "";
  } catch {
    denoDir = "";
  }
  return denoDir || undefined;
}

export interface Sandbox {
  home: string;
  env: Record<string, string>;
  /** Run `deno run -A <script> ...args` in the sandbox. */
  run(
    script: string,
    args: string[],
    stdin?: string,
    extra?: Record<string, string>,
  ): Promise<{ code: number; out: string }>;
}

export async function sandbox(prefix = "archon-test-"): Promise<Sandbox> {
  const home = await Deno.makeTempDir({ prefix });
  const config = join(home, "config");
  const data = join(home, "data");
  const tmp = join(home, "tmp");
  for (const d of [config, data, tmp, join(home, "OneDrive")]) {
    await Deno.mkdir(d, { recursive: true });
  }
  const env: Record<string, string> = {};
  for (const k of PASS) {
    const v = Deno.env.get(k);
    if (v !== undefined) env[k] = v;
  }
  const dd = await parentDenoDir();
  Object.assign(env, {
    ARCHON_SANDBOX: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    APPDATA: config,
    LOCALAPPDATA: data,
    OneDrive: join(home, "OneDrive"),
    OneDriveConsumer: join(home, "OneDrive"),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    NO_COLOR: "1",
    ARCHON_PLAIN: "1",
    ...(dd ? { DENO_DIR: dd } : {}),
  });
  const run = async (
    script: string,
    args: string[],
    stdin = "",
    extra: Record<string, string> = {},
  ) => {
    const c = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script, ...args],
      env: { ...env, ...extra },
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = c.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
    const o = await c.output();
    const d = new TextDecoder();
    return { code: o.code, out: d.decode(o.stdout) + d.decode(o.stderr) };
  };
  await probe(home, run);
  return { home, env, run };
}

/** Fail fast unless every path archon would touch resolves inside the sandbox. */
async function probe(home: string, run: Sandbox["run"]): Promise<void> {
  const script = join(home, "probe.ts");
  const src = (rel: string) => new URL(`../src/archon/${rel}`, import.meta.url).href;
  await Deno.writeTextFile(
    script,
    `import { P } from ${JSON.stringify(src("core/paths.ts"))};
import { LEDGER, VAULT_LOCAL } from ${JSON.stringify(src("core/secret-ledger.ts"))};
import { PROMPT_STATUS, vaultDir } from ${JSON.stringify(src("vault/state.ts"))};
import { defaultLogPath } from ${JSON.stringify(src("core/ui.ts"))};
console.log(JSON.stringify([P.secrets, P.bootCache, LEDGER, VAULT_LOCAL, PROMPT_STATUS, vaultDir(), defaultLogPath()]));`,
  );
  const r = await run(script, []);
  assert(r.code === 0, `sandbox probe failed: ${r.out}`);
  const paths = JSON.parse(r.out.trim().split("\n").pop()!) as Array<string | null>;
  const root = home.toLowerCase();
  for (const p of paths) {
    if (p === null) continue;
    // Logs as root on Linux go to /var/log/archon: not per-user state, allowed.
    if (p.startsWith("/var/log/archon")) continue;
    assert(p.toLowerCase().startsWith(root), `sandbox leak: ${p} is outside ${home}`);
  }
}

/**
 * A fingerprint of the real archon folders of the test process itself (the
 * secrets' parent, and the boot cache's parent): every file's path, size, and
 * SHA-256. Equal before and after means the tests left them byte for byte as
 * they were. A boot server running at the same time owns boot.log and its
 * telemetry files, so those are left out.
 */
const OWNED_BY_A_RUNNING_SERVER = /[\\/](boot\.log(\.1)?|telemetry[\\/].*)$/;

export async function fingerprint(dirs: string[]): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries: Deno.DirEntry[] = [];
    try {
      entries = await Array.fromAsync(Deno.readDir(d));
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (OWNED_BY_A_RUNNING_SERVER.test(p)) continue;
      if (e.isDirectory) await walk(p);
      else if (e.isFile) {
        const data = await Deno.readFile(p).catch(() => new Uint8Array());
        const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
        out.push(
          `${p} ${data.length} ${[...h].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        );
      }
    }
  };
  for (const d of dirs) await walk(d);
  return out.join("\n");
}
