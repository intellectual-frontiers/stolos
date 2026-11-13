// `archon tools sync` (spec 008, Articles V and XII).
//
// upstream-binary: latest GitHub release -> verify the asset's published
//   SHA-256 digest -> install under /opt/tools/<id>/<version> -> smoke test ->
//   atomically switch /usr/local/bin/<bin> -> keep the previous version.
// apt: installed by apt; reported against the candidate in Ubuntu's archive.
// Nothing is ever built from source on a host: binaries only.
// self-updating: install for persona holders, then record versions only.

import { join } from "../core/path.ts";
import { ensureDir, exists, walkFiles } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { isRoot, run, splitArgs } from "../core/exec.ts";
import { journal } from "../core/log.ts";
import { ui } from "../core/ui.ts";
import { planFor } from "../build.ts";
import type { HostDef, ToolDef } from "../model/types.ts";
import { expandPersonas } from "../personas/mod.ts";
import { homeOf, loadFleet, usersFor } from "../model/load.ts";

interface Release {
  tag: string;
  version: string;
  assets: Array<{ name: string; url: string; digest?: string }>;
}

export interface ToolStatus {
  id: string;
  source: ToolDef["source"];
  installed?: string;
  latest?: string;
  debian?: string;
  action: string;
  ok: boolean;
}

/** Compare dotted versions with optional letter suffixes (tmux 3.5a). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(/[.\-+~]/).map((p) => {
      const m = p.match(/^(\d+)([a-z]*)$/i);
      return m ? [Number(m[1]), m[2]] as const : [0, p] as const;
    });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [na, sa] = pa[i] ?? [0, ""];
    const [nb, sb] = pb[i] ?? [0, ""];
    if (na !== nb) return na - nb;
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

/** Package version "3.6a-2ubuntu0.1" or "1:2.53.0-1ubuntu1" -> upstream part "3.6a". */
export function aptUpstream(v: string): string {
  return v.replace(/^\d+:/, "").replace(/-[^-]*$/, "").replace(/\+.*$/, "");
}

/** Extract the version number from `--version` output. */
export function versionFrom(output: string): string | undefined {
  return output.match(/(\d+\.\d+(?:\.\d+)?[a-z]?)/)?.[1];
}

let cachedToken: string | undefined | null = null;

/**
 * A GitHub token for release lookups: GITHUB_TOKEN, else the gh login of the
 * checkout's owner (ops, spec 016). Unauthenticated, the API allows 60 calls
 * an hour per IP address, which one bootstrap behind a shared NAT can exhaust
 * (every tool then fails with "GitHub API 403").
 */
export async function githubToken(): Promise<string | undefined> {
  if (cachedToken !== null) return cachedToken;
  cachedToken = Deno.env.get("GITHUB_TOKEN") || Deno.env.get("GH_TOKEN") || undefined;
  if (!cachedToken) {
    const owner = (await run(["stat", "-c", "%U", P.repo])).stdout.trim();
    for (const user of [owner, Deno.env.get("SUDO_USER"), undefined]) {
      const r = await run(["gh", "auth", "token", "--hostname", "github.com"], {
        asUser: user && isRoot() ? user : undefined,
      });
      if (r.ok && r.stdout.trim()) {
        cachedToken = r.stdout.trim();
        break;
      }
    }
  }
  return cachedToken;
}

export async function latestRelease(repo: string, tagPrefix = ""): Promise<Release> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "archon",
  };
  const token = await githubToken();
  if (token) headers.authorization = `Bearer ${token}`;
  // ARCHON_GITHUB_API points at GitHub Enterprise or a mirror of the releases API.
  const api = (Deno.env.get("ARCHON_GITHUB_API") ?? "https://api.github.com").replace(/\/$/, "");
  const res = await fetch(`${api}/repos/${repo}/releases/latest`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);
  const j = await res.json() as {
    tag_name: string;
    prerelease: boolean;
    assets: Array<{ name: string; browser_download_url: string; digest?: string }>;
  };
  if (j.prerelease) throw new Error(`${repo}: latest release is a pre-release`);
  return {
    tag: j.tag_name,
    version: j.tag_name.startsWith(tagPrefix) ? j.tag_name.slice(tagPrefix.length) : j.tag_name,
    assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, digest: a.digest })),
  };
}

async function installedVersion(t: ToolDef): Promise<string | undefined> {
  const r = await run(splitArgs(t.versionCommand));
  return r.ok ? versionFrom(r.stdout + r.stderr) : undefined;
}

async function aptCandidate(pkg: string): Promise<{ installed?: string; candidate?: string }> {
  const r = await run(["apt-cache", "policy", pkg]);
  const get = (k: string) => {
    const v = r.stdout.match(new RegExp(`${k}:\\s*(\\S+)`))?.[1];
    return v && v !== "(none)" ? aptUpstream(v) : undefined;
  };
  return { installed: get("Installed"), candidate: get("Candidate") };
}

async function sha256(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function download(url: string, to: string) {
  const res = await fetch(url, { headers: { "user-agent": "archon" } });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const name = url.split("/").pop() ?? url;
  let got = 0;
  const p = ui.active("Tools");
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      got += chunk.byteLength;
      const mb = (n: number) => (n / 1048576).toFixed(1);
      if (total) p.step(got, total, `downloading ${name} (${mb(got)}/${mb(total)} MB)`);
      else p.status(`downloading ${name} (${mb(got)} MB)`);
      ctl.enqueue(chunk);
    },
  });
  const f = await Deno.open(to, { create: true, write: true, truncate: true });
  await res.body.pipeThrough(counter).pipeTo(f.writable);
}

/** Article XII: activate only verified, smoke-tested binaries; roll back on failure. */
async function activate(t: ToolDef, version: string, binDir: string): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const bin of t.bins) {
    const link = join(P.bin, bin);
    try {
      previous[bin] = await Deno.readLink(link);
    } catch { /* first install */ }
    const tmp = `${link}.archon-tmp`;
    try {
      await Deno.remove(tmp);
    } catch { /* none */ }
    await Deno.symlink(join(binDir, bin), tmp);
    await Deno.rename(tmp, link);
  }
  const smoke = await run(splitArgs(t.verify), {
    asUser: t.unprivileged && isRoot() ? "nobody" : undefined,
    cwd: "/", // nobody's home does not exist
  });
  if (!smoke.ok) {
    for (const bin of t.bins) {
      const link = join(P.bin, bin);
      await Deno.remove(link).catch(() => {});
      if (previous[bin]) await Deno.symlink(previous[bin]!, link);
    }
    throw new Error(
      `${t.id} ${version}: smoke test failed, rolled back (${
        (smoke.stderr || smoke.stdout).trim()
      })`,
    );
  }
}

async function prune(t: ToolDef, keep = 2) {
  const root = join(P.toolsRoot, t.id);
  const versions: string[] = [];
  try {
    for await (const e of Deno.readDir(root)) {
      if (e.isDirectory && !e.name.endsWith(".partial")) versions.push(e.name);
    }
  } catch {
    return;
  }
  versions.sort(compareVersions);
  const active = new Set<string>();
  for (const bin of t.bins) {
    try {
      active.add((await Deno.readLink(join(P.bin, bin))).split("/")[4]);
    } catch { /* none */ }
  }
  for (const v of versions.slice(0, Math.max(0, versions.length - keep))) {
    if (!active.has(v)) await Deno.remove(join(root, v), { recursive: true });
  }
}

async function installUpstream(t: ToolDef, rel: Release, arch: "amd64"): Promise<void> {
  const re = t.github!.asset(arch, rel.version);
  const asset = rel.assets.find((a) => re.test(a.name));
  if (!asset) throw new Error(`${t.id} ${rel.version}: no release asset matches ${re}`);
  if (!asset.digest?.startsWith("sha256:")) {
    throw new Error(`${t.id}: release asset has no published SHA-256 digest (Article XII)`);
  }
  const dest = join(P.toolsRoot, t.id, rel.version);
  const work = `${dest}.partial`;
  await Deno.remove(work, { recursive: true }).catch(() => {});
  await ensureDir(work);
  const file = join(work, asset.name);
  await download(asset.url, file);
  const digest = await sha256(file);
  if (`sha256:${digest}` !== asset.digest) {
    throw new Error(`${t.id}: digest mismatch for ${asset.name}`);
  }
  const extract = join(work, "x");
  await ensureDir(extract);
  if (asset.name.endsWith(".zip")) await mustRun(["unzip", "-q", file, "-d", extract]);
  else if (asset.name.endsWith(".tar.xz")) await mustRun(["tar", "-xJf", file, "-C", extract]);
  else if (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".tgz")) {
    await mustRun(["tar", "-xzf", file, "-C", extract]);
  } else await Deno.rename(file, join(extract, t.bins[0]));
  const binDir = join(work, "bin");
  await ensureDir(binDir);
  const all = await walkFiles(extract);
  for (const bin of t.bins) {
    const found = all.find((p) =>
      p === bin || p.endsWith(`/${bin}`) || p.endsWith(`/bin/${bin}`)
    ) ??
      (all.length === 1 ? all[0] : undefined);
    if (!found) throw new Error(`${t.id}: ${bin} not found in ${asset.name}`);
    await Deno.rename(join(extract, found), join(binDir, bin));
    await Deno.chmod(join(binDir, bin), 0o755);
  }
  await Deno.remove(extract, { recursive: true });
  await Deno.remove(file).catch(() => {});
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await Deno.rename(work, dest);
  await activate(t, rel.version, join(dest, "bin"));
}

async function mustRun(argv: string[], opts: { cwd?: string } = {}) {
  const r = await run(argv, opts);
  if (!r.ok) {
    throw new Error(
      `${argv.join(" ")}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`,
    );
  }
}

async function ensureShell(path: string) {
  const shells = await Deno.readTextFile("/etc/shells").catch(() => "");
  if (!shells.split("\n").includes(path)) await run(["add-shell", path]);
}

async function syncOne(t: ToolDef, host: HostDef, reportOnly: boolean): Promise<ToolStatus> {
  const s: ToolStatus = { id: t.id, source: t.source, action: "none", ok: true };
  try {
    if (t.source === "self-updating") {
      const holders = usersFor(await loadFleet(), host).filter((u) =>
        t.forPersona && expandPersonas(u.personas).includes(t.forPersona)
      );
      const versions: string[] = [];
      for (const u of holders) {
        const bin = join(homeOf(u), ".local", "bin", t.bins[0]);
        if (!(await exists(bin))) {
          if (reportOnly) {
            versions.push(`${u.name}: not installed`);
            continue;
          }
          // pipefail: a failed download must not look like a successful install.
          // The vendor installer is occasionally killed on a busy first boot;
          // once more is enough.
          const install = () =>
            run(["bash", "-o", "pipefail", "-c", `curl -fsSL ${t.installer} | bash`], {
              asUser: u.name,
            });
          let r = await install();
          if (!r.ok || !(await exists(bin))) r = await install();
          if (!r.ok || !(await exists(bin))) {
            throw new Error(
              `installing ${t.id} for ${u.name} failed: ${
                (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" / ") ||
                `${bin} is missing`
              }`,
            );
          }
          s.action = "installed";
        }
        const v = await run([bin, "--version"], { asUser: u.name });
        versions.push(`${u.name}: ${versionFrom(v.stdout) ?? "?"}`);
      }
      s.installed = versions.join("; ") || "no operator users";
      s.latest = "self-updating";
      return s;
    }
    s.installed = await installedVersion(t);
    if (t.source === "apt") {
      const d = await aptCandidate(t.package!);
      s.debian = d.candidate;
      s.latest = d.candidate;
      s.action = s.installed ? "ubuntu" : "missing (apt)";
      if (!reportOnly) {
        // A tool that used to be built or downloaded (tmux before) leaves its
        // /usr/local/bin link ahead of Ubuntu's binary on PATH: drop it.
        for (const bin of t.bins) {
          const link = join(P.bin, bin);
          const target = await Deno.readLink(link).catch(() => undefined);
          if (target?.startsWith(P.toolsRoot)) {
            await Deno.remove(link);
            s.installed = await installedVersion(t);
          }
        }
      }
      return s;
    }
    const rel = await latestRelease(t.github!.repo, t.github!.tagPrefix);
    s.latest = rel.version;
    if (s.installed && compareVersions(s.installed, rel.version) >= 0) {
      s.action = "current";
      return s;
    }
    s.action = reportOnly
      ? `upgrade available ${s.installed ?? "none"} -> ${rel.version}`
      : `upgraded ${s.installed ?? "none"} -> ${rel.version}`;
    if (reportOnly) return s;
    await installUpstream(t, rel, host.arch);
    await prune(t);
    // A tool's own service picks up the new binary (only where it is enabled).
    for (const unit of t.restarts ?? []) {
      if ((await run(["systemctl", "is-enabled", "--quiet", unit])).ok) {
        await run(["systemctl", "restart", unit]);
      }
    }
    if (t.id === "fish") await ensureShell(join(P.bin, "fish"));
  } catch (e) {
    s.ok = false;
    s.action = `FAILED: ${(e as Error).message}`;
  }
  return s;
}

function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

export async function syncTools(host: HostDef, opts: { reportOnly: boolean }) {
  if (!opts.reportOnly && !isRoot()) throw new Error("tools sync must run as root");
  const plan = await planFor(host);
  const rows: ToolStatus[] = [];
  const phase = ui.phase("Tools");
  for (const t of plan.tools) {
    const p = ui.active("Tools");
    p.step(rows.length + 1, plan.tools.length, `${t.id} (${t.source})`);
    const s = await syncOne(t, host, opts.reportOnly);
    if (!s.ok) p.fail(`${t.id}: ${s.action.replace(/^FAILED: /, "")}`);
    else if (/^upgraded|^installed|available/.test(s.action)) p.change(`${t.id}: ${s.action}`);
    else p.ok(`${t.id}: ${s.action}`);
    rows.push(s);
  }
  phase.done(toolSummary(rows));
  const week = isoWeek();
  const report = [
    `# Tools report ${week}: ${host.name}`,
    "",
    `Generated ${new Date().toISOString()} by archon tools sync${
      opts.reportOnly ? " --report-only" : ""
    }.`,
    "",
    "| Tool | Source | Installed | Latest | Trixie | Action |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.id} | ${r.source} | ${r.installed ?? "-"} | ${r.latest ?? "-"} | ${
        r.debian ?? "-"
      } | ${r.action} |`
    ),
    "",
  ].join("\n");
  if (isRoot()) {
    await ensureDir(join(P.varLib, "reports"));
    await Deno.writeTextFile(join(P.varLib, "reports", `tools-${week}.md`), report);
    await journal(
      "archon-tools",
      `tools sync: ${rows.filter((r) => r.action.startsWith("upgraded")).length} upgraded, ${
        rows.filter((r) => !r.ok).length
      } failed`,
    );
  }
  return { rows, report, failed: rows.some((r) => !r.ok) };
}

export async function listTools(host: HostDef, opts: { latest: boolean }) {
  const plan = await planFor(host);
  const rows: Array<{ id: string; source: string; installed?: string; latest?: string }> = [];
  for (const t of plan.tools) {
    const row: { id: string; source: string; installed?: string; latest?: string } = {
      id: t.id,
      source: t.source,
      installed: await installedVersion(t),
    };
    if (opts.latest && t.github) {
      try {
        row.latest = (await latestRelease(t.github.repo, t.github.tagPrefix)).version;
      } catch (e) {
        row.latest = `? (${(e as Error).message})`;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** "fish 4.9.3 · gh 2.103.3 (new) · ..." for the Tools phase result. */
export function toolSummary(rows: ToolStatus[]): string {
  return rows.map((r) => {
    const v = r.source === "self-updating"
      ? (r.installed?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "")
      : /^upgraded/.test(r.action)
      ? (r.latest ?? "")
      : (r.installed ?? r.latest ?? "");
    const tag = /^upgraded|^installed/.test(r.action)
      ? (ui.emoji ? " ↑" : " (new)")
      : /available/.test(r.action)
      ? " (update available)"
      : "";
    return `${r.id} ${v}${tag}`.trim();
  }).join(" · ");
}
