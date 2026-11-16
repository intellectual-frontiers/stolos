/**
 * Spec 062: the bootstrap scripts. The template stays in step with the engine
 * (the pinned Bun, spec 096), a fleet's copy has its repository filled in, and
 * bootstrap.sh runs for real in a throwaway home: a clone, the shortcut, a
 * second run, the refusals, and --destroy-existing (clean, and with work that
 * exists only there). The Windows script is parsed where PowerShell is here
 * (CI runs it for real on Windows: .github/workflows/ci.yml).
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import {
  BOOTSTRAP_PATHS,
  bootstrapBunVersion,
  bootstrapFiles,
  bootstrapTemplate,
  githubSlug,
} from "../src/archon/fleet/bootstrap.ts";
import { scaffoldFiles } from "../src/archon/fleet/scaffold.ts";
import { BUN_VERSION } from "../src/archon/core/bun-pin.ts";

const SCRIPT = path.fromFileUrl(new URL("../bin/bootstrap.sh", import.meta.url));
const PS1 = path.fromFileUrl(new URL("../bin/bootstrap.windows.ps1", import.meta.url));
const has = (cmd: string): boolean => proc.which(cmd) !== undefined;

proves(
  ["062-bootstrap FR-001", "096-bun-runtime FR-007"],
  "062: the template installs the engine's pinned Bun, on both systems",
  () => {
    for (const p of BOOTSTRAP_PATHS) {
      assertEquals(bootstrapBunVersion(bootstrapTemplate(p)), BUN_VERSION, p);
    }
  },
);

proves(
  ["062-bootstrap FR-007"],
  "062: a fleet's copy has its repository; without one it asks for --repo",
  () => {
    const f = bootstrapFiles("example/fleet");
    assertStringIncludes(f["bin/bootstrap.sh"] ?? "", 'DEFAULT_REPO="example/fleet"');
    assertStringIncludes(f["bin/bootstrap.windows.ps1"] ?? "", '$DefaultRepo = "example/fleet"');
    assertStringIncludes(bootstrapFiles()["bin/bootstrap.sh"] ?? "", 'DEFAULT_REPO=""');
    const s = scaffoldFiles("v1.0.0", undefined, "example/fleet");
    assertEquals(s["bin/bootstrap.sh"], f["bin/bootstrap.sh"]);
    assertStringIncludes(s[".gitattributes"] ?? "", "* text=auto eol=lf");
    for (const [url, slug] of [
      ["https://github.com/example/fleet.git", "example/fleet"],
      ["git@github.com:example/fleet.git", "example/fleet"],
      ["https://github.com/example/fleet", "example/fleet"],
      ["https://gitlab.com/example/fleet.git", undefined],
    ] as const)
      assertEquals(githubSlug(url), slug, url);
  },
);

test(
  "062: shellcheck finds nothing in bootstrap.sh",
  async () => {
    const r = await proc.output(["shellcheck", SCRIPT], { stdout: "piped" });
    assert(r.success, new TextDecoder().decode(r.stdout));
  },
  { skip: !has("shellcheck") && "shellcheck is not installed" },
);

test(
  "062: bootstrap.windows.ps1 parses (PowerShell)",
  async () => {
    const r = await proc.output(
      [
        "pwsh",
        "-NoProfile",
        "-Command",
        `$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('${PS1}', [ref]$null, [ref]$e) | Out-Null; if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }`,
      ],
      { stdout: "piped", stderr: "piped" },
    );
    assert(r.success, new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr));
  },
  { skip: !has("pwsh") && "PowerShell is not installed" },
);

/** A throwaway home, a source repository to clone, and a runner for bootstrap.sh (no terminal). */
async function bootSandbox(): Promise<{
  home: string;
  src: string;
  fleet: string;
  boot: (...args: string[]) => Promise<{ code: number; out: string }>;
  git: (cwd: string, ...a: string[]) => Promise<string>;
}> {
  const home = await fs.makeTempDir({ prefix: "stolos-bootstrap-test-" });
  const src = path.join(home, "src");
  const git = async (cwd: string, ...a: string[]): Promise<string> => {
    const r = await proc.output(["git", ...a], { cwd, env, stdout: "piped", stderr: "piped" });
    if (!r.success) throw new Error(`git ${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
    return new TextDecoder().decode(r.stdout).trim();
  };
  const env: Record<string, string> = {
    HOME: home,
    PATH: proc.env.get("PATH") ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    NO_COLOR: "1",
  };
  await fs.mkdir(src);
  await git(src, "init", "-q", "-b", "main");
  await fs.writeTextFile(path.join(src, "README.md"), "a fleet\n");
  await git(src, "add", "-A");
  await git(src, "commit", "-q", "--no-gpg-sign", "-m", "a fleet");
  const boot = async (...args: string[]): Promise<{ code: number; out: string }> => {
    // No controlling terminal, as in CI (a prompt must refuse, never wait): setsid, or on macOS
    // (no setsid) Perl's POSIX::setsid, which macOS has.
    const detach =
      proc.which("setsid") !== undefined
        ? ["setsid"]
        : ["perl", "-MPOSIX=setsid", "-e", "setsid(); exec(@ARGV) or die $!"];
    const r = await proc.output([...detach, "bash", SCRIPT, ...args], {
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const d = new TextDecoder();
    return { code: r.code, out: d.decode(r.stdout) + d.decode(r.stderr) };
  };
  return { home, src, fleet: path.join(home, "fleet"), boot, git };
}

const posix = proc.build.os !== "windows";

proves(
  [
    "062-bootstrap FR-002",
    "062-bootstrap FR-003",
    "062-bootstrap FR-004",
    "062-bootstrap FR-006",
    "059-stolos-and-archon FR-006",
  ],
  "062: bootstrap.sh clones into ~/fleet, adds the shortcut once, and is safe to run again",
  async () => {
    const s = await bootSandbox();
    try {
      let r = await s.boot("--dry-run");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "which fleet repository?");

      r = await s.boot("--repo", s.src, "--dry-run");
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, `would run: git clone ${s.src} ${s.fleet}`);
      assert(!(await exists(s.fleet)), "--dry-run changes nothing");

      r = await s.boot("--repo", s.src);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "[ok] Bun");
      assert(!r.out.includes("gh"), "a repository that is not on GitHub needs no gh");
      assertEquals(await fs.readTextFile(path.join(s.fleet, "README.md")), "a fleet\n");
      const rc = await fs.readTextFile(path.join(s.home, ".bashrc"));
      assertStringIncludes(rc, 'stolos() { bun run stolos "$@"; }');

      // Again: the fleet is there, so it would be brought up to date; the shortcut is not added twice.
      r = await s.boot("--repo", s.src, "--dry-run");
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "bringing it up to date");
      assertStringIncludes(r.out, "bun run stolos update");
      r = await s.boot("--repo", s.src, "--no-shortcut", "--dry-run");
      assert(!r.out.includes("Shortcut"), r.out);
      assertEquals(
        (await fs.readTextFile(path.join(s.home, ".bashrc"))).split("# stolos shortcut").length - 1,
        1,
      );

      // A folder that is something else is never touched, even with --destroy-existing.
      const other = path.join(s.home, "other");
      await fs.mkdir(other);
      await fs.writeTextFile(path.join(other, "notes.txt"), "mine\n");
      r = await s.boot("--repo", s.src, "--in", other, "--destroy-existing");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "is not a checkout of");
      assertEquals(await fs.readTextFile(path.join(other, "notes.txt")), "mine\n");
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
  { skip: !posix && "bootstrap.sh is for Linux and macOS" },
);

proves(
  ["062-bootstrap FR-003"],
  "062: bootstrap.sh --destroy-existing clones fresh; work only there needs the folder's name typed",
  async () => {
    const s = await bootSandbox();
    try {
      assertEquals((await s.boot("--repo", s.src, "--no-shortcut")).code, 0);
      // Clean: removed and cloned again (a file inside .git marks the old checkout).
      await fs.writeTextFile(path.join(s.fleet, ".git", "old-checkout"), "");
      let r = await s.boot("--repo", s.src, "--no-shortcut", "--destroy-existing");
      assertEquals(r.code, 0, r.out);
      assert(!(await exists(path.join(s.fleet, ".git", "old-checkout"))), "a fresh clone");

      // An edit and a commit not pushed: listed; with no terminal to confirm in, nothing is removed.
      await fs.writeTextFile(path.join(s.fleet, "README.md"), "edited\n");
      await fs.writeTextFile(path.join(s.fleet, "new.txt"), "x\n");
      await s.git(s.fleet, "add", "new.txt");
      await s.git(s.fleet, "commit", "-q", "--no-gpg-sign", "-m", "local only");
      r = await s.boot("--repo", s.src, "--no-shortcut", "--destroy-existing");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "would be lost");
      assertStringIncludes(r.out, "README.md");
      assertStringIncludes(r.out, "local only");
      assertStringIncludes(r.out, "no terminal to confirm in");
      assertEquals(await fs.readTextFile(path.join(s.fleet, "README.md")), "edited\n");
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
  { skip: !posix && "bootstrap.sh is for Linux and macOS" },
);

proves(
  ["062-bootstrap FR-005"],
  "062: the same options on both systems: --repo, --in, --destroy-existing, --no-shortcut, --runtime, --dry-run, --help",
  async () => {
    // Each option, in both scripts' usage and parsing (the Windows one also takes -Repo, -DryRun:
    // its parser drops the dashes and the case; CI runs it for real, tests/bootstrap/windows-check.ps1).
    const ps1 = await fs.readTextFile(PS1);
    const sh = await fs.readTextFile(SCRIPT);
    for (const o of [
      "repo",
      "in",
      "destroy-existing",
      "no-shortcut",
      "runtime",
      "dry-run",
      "help",
    ]) {
      assertStringIncludes(sh, `--${o}`, `bootstrap.sh: --${o}`);
      assertStringIncludes(ps1, `'${o.replace(/-/g, "")}'`, `bootstrap.windows.ps1: --${o}`);
    }
    assertStringIncludes(ps1, "TrimStart('-').ToLower()");
    if (!posix) return;
    const s = await bootSandbox();
    try {
      let r = await s.boot("--help");
      assertEquals(r.code, 0, r.out);
      for (const o of ["--repo", "--in", "--destroy-existing", "--no-shortcut", "--runtime"]) {
        assertStringIncludes(r.out, o);
      }
      assertStringIncludes(
        r.out,
        "--dry-run             say what each step would do; change nothing",
      );
      // --runtime node, and --in: says each step, changes nothing.
      const there = path.join(s.home, "elsewhere");
      r = await s.boot("--repo", s.src, "--in", there, "--runtime", "node", "--dry-run");
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, `would run: git clone ${s.src} ${there}`);
      assertStringIncludes(r.out, "[ok] Node");
      assert(!(await exists(there)), "--dry-run changes nothing");
      r = await s.boot("--repo", s.src, "--runtime=python", "--dry-run");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "python is not bun or node");
      r = await s.boot("--frobnicate");
      assertEquals(r.code, 2, r.out);
      assertStringIncludes(r.out, "unknown option: --frobnicate (see --help)");
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  ["062-bootstrap FR-008"],
  "062: the README, the disaster recovery guide and RESTORE.txt give the one line first; $HOME/fleet, never C:\\fleet",
  async () => {
    const { restoreText } = await import("../src/archon/vault/zip.ts");
    const { bootstrapOneLiner } = await import("../src/archon/fleet/bootstrap.ts");
    const { engineFile } = await import("../src/archon/core/assets.ts");
    // RESTORE.txt: the bootstrap line (both systems) is the first step, then $HOME\fleet.
    const restore = restoreText(["lab"], "example/fleet");
    const steps = restore.slice(restore.indexOf("On the new or rebuilt PC"));
    assert(/^ 1-2\. Bootstrap/m.test(steps), steps);
    const win = bootstrapOneLiner("windows", "example/fleet");
    assertStringIncludes(steps, win);
    assertStringIncludes(steps, bootstrapOneLiner("posix", "example/fleet"));
    assert(steps.indexOf(win) < steps.indexOf("vault restore"), "the one line before the restore");
    assertStringIncludes(restore, "cd $HOME\\fleet");
    // The disaster recovery guide: its first step is the one line.
    const dr = engineFile("docs/disaster-recovery.md");
    const first = dr.indexOf("\n1. ");
    assert(first > 0, "a numbered list");
    assert(dr.indexOf("bootstrap.windows.ps1", first) - first < 400, dr.slice(first, first + 400));
    assertStringIncludes(dr, "$HOME\\fleet");
    // The README: the bootstrap section's one lines come before anything else is run.
    const readme = await fs.readTextFile(
      path.fromFileUrl(new URL("../README.md", import.meta.url)),
    );
    const boot = readme.indexOf("### Bootstrap your PC in one line");
    assert(boot > 0);
    const firstCode = readme.slice(boot).search(/`(& \(|bash <\(|bun |git |cd )/);
    assert(readme.slice(boot + firstCode).startsWith("`& ([scriptblock]"), "the one line first");
    assertStringIncludes(readme, "**`$HOME/fleet`**");
    // Nowhere C:\fleet: not in the README, the engine's sources, or the scripts.
    const bad: string[] = [];
    const roots = ["src", "bin"].map((d) => path.fromFileUrl(new URL(`../${d}`, import.meta.url)));
    for (const root of roots) {
      for (const f of await fs.walkFiles(root)) {
        // The generated assets carry the specs' own text, which names what it replaced.
        if (f.endsWith("assets.auto.ts")) continue;
        if (/C:\\\\?fleet\b/i.test(await fs.readTextFile(path.join(root, f)))) bad.push(f);
      }
    }
    if (/C:\\\\?fleet\b/i.test(readme)) bad.push("README.md");
    assertEquals(bad, []);
  },
);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
