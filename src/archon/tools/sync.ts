/**
 * `archon tools sync` (spec 008, Articles V and XII).
 *
 * upstream-binary: latest GitHub release -> verify the asset's published
 *   SHA-256 digest -> install under /opt/tools/<id>/<version> -> smoke test ->
 *   atomically switch /usr/local/bin/<bin> -> keep the previous version.
 * apt: installed by apt; reported against the candidate in Ubuntu's archive.
 * Nothing is ever built from source on a host: binaries only.
 * self-updating: install for persona holders, then record versions only.
 *
 * @module
 */

import { array, boolean, nullable, object, splitArgs, string } from "@intellectual-frontiers/core";
import { sha256Of } from "@intellectual-frontiers/crypto";
import { fs, http, net, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { asRoot, P } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import { journal } from "../core/log.ts";
import { ui } from "../core/ui.ts";
import { planFor } from "../build.ts";
import type { HostDef, ToolDef } from "../model/types.ts";
import { expandPersonas } from "../personas/mod.ts";
import { homeOf, loadFleet, usersFor } from "../model/load.ts";

/** A tool's latest stable GitHub release, as `latestRelease` reads it. */
export interface Release {
  /** The release's git tag, as published (for example `"v2.1.0"`). */
  tag: string;
  /** The version: the tag without the tool's tag prefix. */
  version: string;
  /** The release's downloadable files, each with its published digest when GitHub has one. */
  assets: Array<{
    /** The file name. */
    name: string;
    /** Where to download it. */
    url: string;
    /** GitHub's digest for it, `sha256:<hex>`, when published. */
    digest?: string;
  }>;
}

/** A release as GitHub's releases API gives it (the fields read). */
const releaseDecoder = object({
  tag_name: string,
  prerelease: boolean,
  assets: array(
    object({ name: string, browser_download_url: string }, { digest: nullable(string) }),
  ),
});

/** The words of a command line, or none where it is not one (an unclosed quote). */
const argvOf = (line: string): readonly string[] => {
  const r = splitArgs(line);
  return r.kind === "ok" ? r.value : [];
};

/** One tool's row in a `archon tools sync` run: what is installed, what is latest, what was done. */
export interface ToolStatus {
  /** The tool's id. */
  id: string;
  /** Where it comes from: `upstream-binary`, `apt` or `self-updating`. */
  source: ToolDef["source"];
  /** The installed version (for self-updating tools, one entry per user, joined by `; `). */
  installed?: string;
  /** The latest version: the GitHub release, the apt candidate, or `"self-updating"`. */
  latest?: string;
  /** The candidate version in Ubuntu's archive, for apt tools (the report's "Trixie" column). */
  debian?: string;
  /** What the run did or would do (`"current"`, `"upgraded a -> b"`, `"FAILED: ..."`, and so on). */
  action: string;
  /** False when the tool failed to sync. */
  ok: boolean;
}

/** Compare dotted versions with optional letter suffixes (tmux 3.5a). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): ReadonlyArray<readonly [number, string]> =>
    v
      .replace(/^v/, "")
      .split(/[.\-+~]/)
      .map((p) => {
        const m = p.match(/^(\d+)([a-z]*)$/i);
        return m ? ([Number(m[1]), m[2] ?? ""] as const) : ([0, p] as const);
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
  return v
    .replace(/^\d+:/, "")
    .replace(/-[^-]*$/, "")
    .replace(/\+.*$/, "");
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
  cachedToken = proc.env.get("GITHUB_TOKEN") || proc.env.get("GH_TOKEN") || undefined;
  if (!cachedToken) {
    const owner = (await run(["stat", "-c", "%U", P.repo])).stdout.trim();
    for (const user of [owner, proc.env.get("SUDO_USER"), undefined]) {
      const r = await run(["gh", "auth", "token", "--hostname", "github.com"], {
        ...(user && asRoot() ? { asUser: user } : {}),
      });
      if (r.ok && r.stdout.trim()) {
        cachedToken = r.stdout.trim();
        break;
      }
    }
  }
  return cachedToken;
}

/**
 * The latest stable release of a GitHub repository (`owner/name`), read from
 * the releases API (or the mirror in `ARCHON_GITHUB_API`). `tagPrefix` is cut
 * from the tag to give the version. Throws on an HTTP error or a pre-release.
 */
export async function latestRelease(repo: string, tagPrefix = ""): Promise<Release> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "archon",
  };
  const token = await githubToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  // ARCHON_GITHUB_API points at GitHub Enterprise or a mirror of the releases API.
  const api = (proc.env.get("ARCHON_GITHUB_API") ?? "https://api.github.com").replace(/\/$/, "");
  const t = http.liveTransport({ credentials: "allow", userAgent: "archon" });
  const r = await http.getJson(t, `${api}/repos/${repo}/releases/latest`, releaseDecoder, headers);
  if (r.kind === "err") {
    const e = r.error;
    throw new Error(
      e.kind === "denied" || e.kind === "status"
        ? `GitHub API ${e.status} for ${repo}`
        : `GitHub API for ${repo}: ${http.formatReadError(e)}`,
    );
  }
  const j = r.value;
  if (j.prerelease) throw new Error(`${repo}: latest release is a pre-release`);
  return {
    tag: j.tag_name,
    version: j.tag_name.startsWith(tagPrefix) ? j.tag_name.slice(tagPrefix.length) : j.tag_name,
    assets: j.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      ...(typeof a.digest === "string" ? { digest: a.digest } : {}),
    })),
  };
}

/** A pinned release (spec 096): the one asset for this machine, with its pinned SHA-256. */
export async function pinnedRelease(
  pin: NonNullable<NonNullable<ToolDef["github"]>["pinned"]>,
): Promise<Release> {
  const a = await pin.asset();
  return {
    tag: pin.version,
    version: pin.version,
    assets: [{ name: a.name, url: a.url, digest: `sha256:${a.sha256}` }],
  };
}

async function installedVersion(t: ToolDef): Promise<string | undefined> {
  const r = await run(argvOf(t.versionCommand));
  return r.ok ? versionFrom(r.stdout + r.stderr) : undefined;
}

async function aptCandidate(
  pkg: string,
): Promise<{ installed?: string | undefined; candidate?: string | undefined }> {
  const r = await run(["apt-cache", "policy", pkg]);
  const get = (k: string): string | undefined => {
    const v = r.stdout.match(new RegExp(`${k}:\\s*(\\S+)`))?.[1];
    return v && v !== "(none)" ? aptUpstream(v) : undefined;
  };
  return { installed: get("Installed"), candidate: get("Candidate") };
}

/** The retries of downloads, said on the Tools phase. */
const retries = new net.Retries({ tries: 4, base: 2, cap: 30 }, (line) =>
  ui.active("Tools").status(line),
);

/** Article XII: activate only verified, smoke-tested binaries; roll back on failure. */
async function activate(t: ToolDef, version: string, binDir: string): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const bin of t.bins) {
    const link = path.join(P.bin, bin);
    try {
      previous[bin] = await fs.readLink(link);
    } catch {
      /* first install */
    }
    const tmp = `${link}.archon-tmp`;
    try {
      await fs.remove(tmp);
    } catch {
      /* none */
    }
    await fs.symlink(path.join(binDir, bin), tmp);
    await fs.rename(tmp, link);
  }
  // The smoke test runs the linked command (`/usr/local/bin/<bin>`) where it is linked: P.bin.
  const [cmd, ...rest] = argvOf(t.verify);
  const linked = cmd?.startsWith("/usr/local/bin/") ? path.join(P.bin, cmd.slice(15)) : cmd;
  const smoke = await run(linked === undefined ? [] : [linked, ...rest], {
    ...(t.unprivileged && asRoot() ? { asUser: "nobody" } : {}),
    cwd: "/", // nobody's home does not exist
  });
  if (!smoke.ok) {
    for (const bin of t.bins) {
      const link = path.join(P.bin, bin);
      await fs.remove(link).catch(() => {});
      const before = previous[bin];
      if (before) await fs.symlink(before, link);
    }
    throw new Error(
      `${t.id} ${version}: smoke test failed, rolled back (${(
        smoke.stderr || smoke.stdout
      ).trim()})`,
    );
  }
}

async function prune(t: ToolDef, keep = 2): Promise<void> {
  const root = path.join(P.toolsRoot, t.id);
  const versions: string[] = [];
  try {
    for await (const e of fs.readDir(root)) {
      if (e.isDirectory && !e.name.endsWith(".partial")) versions.push(e.name);
    }
  } catch {
    return;
  }
  versions.sort(compareVersions);
  const active = new Set<string>();
  for (const bin of t.bins) {
    try {
      // <toolsRoot>/<tool>/<version>/bin/<bin>: the version is the folder under the tool's.
      const target = await fs.readLink(path.join(P.bin, bin));
      const v = target.startsWith(`${root}/`)
        ? target.slice(root.length + 1).split("/")[0]
        : undefined;
      if (v !== undefined) active.add(v);
    } catch {
      /* none */
    }
  }
  for (const v of versions.slice(0, Math.max(0, versions.length - keep))) {
    if (!active.has(v)) await fs.remove(path.join(root, v), { recursive: true });
  }
}

/**
 * Spec 010 FR-001: download a release's asset, refused unless it matches the release's published
 * SHA-256; unpack it into `/opt/tools/<tool>/<version>`, link its commands into `/usr/local/bin`,
 * smoke-test it, and roll the links back to the previous version when the test fails.
 */
export async function installUpstream(t: ToolDef, rel: Release, arch: "amd64"): Promise<void> {
  if (!t.github) throw new Error(`${t.id}: not a GitHub release`);
  const re = t.github.asset(arch, rel.version);
  const asset = rel.assets.find((a) => re.test(a.name));
  if (!asset) throw new Error(`${t.id} ${rel.version}: no release asset matches ${re}`);
  const sum = asset.digest?.startsWith("sha256:") ? sha256Of(asset.digest.slice(7)) : undefined;
  if (sum === undefined) {
    throw new Error(`${t.id}: release asset has no published SHA-256 digest (Article XII)`);
  }
  const dest = path.join(P.toolsRoot, t.id, rel.version);
  const work = `${dest}.partial`;
  await fs.remove(work, { recursive: true }).catch(() => {});
  await fs.ensureDir(work);
  ui.active("Tools").status(`downloading ${asset.name}`);
  const got = await net.downloadVerified(retries, asset.url, sum, work, {
    headers: { "user-agent": "archon" },
  });
  if (got.kind === "err") throw new Error(`${t.id}: ${got.error}`);
  const file = got.value;
  const extract = path.join(work, "x");
  await fs.ensureDir(extract);
  if (asset.name.endsWith(".zip")) await mustRun(["unzip", "-q", file, "-d", extract]);
  else if (asset.name.endsWith(".tar.xz")) await mustRun(["tar", "-xJf", file, "-C", extract]);
  else if (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".tgz")) {
    await mustRun(["tar", "-xzf", file, "-C", extract]);
  } else await fs.rename(file, path.join(extract, t.bins[0] ?? t.id));
  const binDir = path.join(work, "bin");
  await fs.ensureDir(binDir);
  const all = await fs.walkFiles(extract);
  for (const bin of t.bins) {
    const found =
      all.find((p) => p === bin || p.endsWith(`/${bin}`) || p.endsWith(`/bin/${bin}`)) ??
      (all.length === 1 ? all[0] : undefined);
    if (!found) throw new Error(`${t.id}: ${bin} not found in ${asset.name}`);
    await fs.rename(path.join(extract, found), path.join(binDir, bin));
    await fs.chmod(path.join(binDir, bin), 0o755);
  }
  await fs.remove(extract, { recursive: true });
  await fs.remove(path.join(work, "downloads"), { recursive: true }).catch(() => undefined);
  await fs.remove(dest, { recursive: true }).catch(() => undefined);
  await fs.rename(work, dest);
  await activate(t, rel.version, path.join(dest, "bin"));
}

async function mustRun(argv: string[], opts: { cwd?: string } = {}): Promise<void> {
  const r = await run(argv, opts);
  if (!r.ok) {
    throw new Error(
      `${argv.join(" ")}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`,
    );
  }
}

async function ensureShell(shell: string): Promise<void> {
  const shells = await fs.readTextFile("/etc/shells").catch(() => "");
  if (!shells.split("\n").includes(shell)) await run(["add-shell", shell]);
}

async function syncOne(t: ToolDef, host: HostDef, reportOnly: boolean): Promise<ToolStatus> {
  const s: ToolStatus = { id: t.id, source: t.source, action: "none", ok: true };
  try {
    if (t.source === "self-updating") {
      const holders = usersFor(await loadFleet(), host).filter(
        (u) => t.forPersona && expandPersonas(u.personas).includes(t.forPersona),
      );
      const versions: string[] = [];
      for (const u of holders) {
        const bin = path.join(homeOf(u), ".local", "bin", t.bins[0] ?? t.id);
        if (!(await fs.exists(bin))) {
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
          if (!r.ok || !(await fs.exists(bin))) r = await install();
          if (!r.ok || !(await fs.exists(bin))) {
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
    const installed = await installedVersion(t);
    if (installed !== undefined) s.installed = installed;
    if (t.source === "apt") {
      const d = await aptCandidate(t.package ?? t.id);
      if (d.candidate !== undefined) {
        s.debian = d.candidate;
        s.latest = d.candidate;
      }
      s.action = s.installed ? "ubuntu" : "missing (apt)";
      if (!reportOnly) {
        // A tool that used to be built or downloaded (tmux before) leaves its
        // /usr/local/bin link ahead of Ubuntu's binary on PATH: drop it.
        for (const bin of t.bins) {
          const link = path.join(P.bin, bin);
          const target = await fs.readLink(link).catch(() => undefined);
          if (target?.startsWith(P.toolsRoot)) {
            await fs.remove(link);
            const now = await installedVersion(t);
            if (now === undefined) delete s.installed;
            else s.installed = now;
          }
        }
      }
      return s;
    }
    if (!t.github) throw new Error(`${t.id}: an upstream binary names no GitHub release`);
    const pin = t.github.pinned;
    const rel = pin
      ? await pinnedRelease(pin)
      : await latestRelease(t.github.repo, t.github.tagPrefix);
    s.latest = rel.version;
    // A pinned tool is at its pin exactly; any other is current at the newest or later.
    if (
      s.installed &&
      (pin ? s.installed === pin.version : compareVersions(s.installed, rel.version) >= 0)
    ) {
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
    if (t.id === "fish") await ensureShell(path.join(P.bin, "fish"));
  } catch (e) {
    s.ok = false;
    s.action = `FAILED: ${e instanceof Error ? e.message : String(e)}`;
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

/**
 * `archon tools sync`: bring every tool in the host's plan up to date (or,
 * with `reportOnly`, only report what would change). As root, it also writes
 * the week's Markdown report under the state directory's `reports/` and logs
 * a summary to the journal. Must run as root unless `reportOnly`.
 */
export async function syncTools(
  host: HostDef,
  opts: { reportOnly: boolean },
): Promise<{ rows: ToolStatus[]; report: string; failed: boolean }> {
  if (!opts.reportOnly && !asRoot()) throw new Error("tools sync must run as root");
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
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.source} | ${r.installed ?? "-"} | ${r.latest ?? "-"} | ${
          r.debian ?? "-"
        } | ${r.action} |`,
    ),
    "",
  ].join("\n");
  if (asRoot()) {
    await fs.ensureDir(path.join(P.varLib, "reports"));
    await fs.writeTextFile(path.join(P.varLib, "reports", `tools-${week}.md`), report);
    await journal(
      "archon-tools",
      `tools sync: ${rows.filter((r) => r.action.startsWith("upgraded")).length} upgraded, ${
        rows.filter((r) => !r.ok).length
      } failed`,
    );
  }
  return { rows, report, failed: rows.some((r) => !r.ok) };
}

/**
 * Each tool in the host's plan with its installed
 * version and, when `latest` is set, the latest GitHub release (upstream
 * tools only; a lookup error is shown in place of the version).
 */
export async function listTools(
  host: HostDef,
  opts: { latest: boolean },
): Promise<Array<{ id: string; source: string; installed?: string; latest?: string }>> {
  const plan = await planFor(host);
  const rows: Array<{ id: string; source: string; installed?: string; latest?: string }> = [];
  for (const t of plan.tools) {
    const installed = await installedVersion(t);
    const row: { id: string; source: string; installed?: string; latest?: string } = {
      id: t.id,
      source: t.source,
      ...(installed === undefined ? {} : { installed }),
    };
    if (opts.latest && t.github) {
      try {
        row.latest = (await latestRelease(t.github.repo, t.github.tagPrefix)).version;
      } catch (e) {
        row.latest = `? (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** "fish 4.9.3 · gh 2.103.3 (new) · ..." for the Tools phase result. */
export function toolSummary(rows: ToolStatus[]): string {
  return rows
    .map((r) => {
      const v =
        r.source === "self-updating"
          ? (r.installed?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "")
          : /^upgraded/.test(r.action)
            ? (r.latest ?? "")
            : (r.installed ?? r.latest ?? "");
      const tag = /^upgraded|^installed/.test(r.action)
        ? ui.emoji
          ? " ↑"
          : " (new)"
        : /available/.test(r.action)
          ? " (update available)"
          : "";
      return `${r.id} ${v}${tag}`.trim();
    })
    .join(" · ");
}
