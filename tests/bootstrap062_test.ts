// Spec 062: the bootstrap scripts. The template stays in step with the engine
// (its Deno minimum), a fleet's copy has its repository filled in, and
// bootstrap.sh runs for real in a throwaway home: a clone, the shortcut, a
// second run, the refusals, and --destroy-existing (clean, and with work that
// exists only there). The Windows script is parsed where PowerShell is here
// (CI runs it for real on Windows: .github/workflows/ci.yml).

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";
import {
  BOOTSTRAP_PATHS,
  bootstrapDenoMin,
  bootstrapFiles,
  bootstrapTemplate,
  githubSlug,
} from "../src/archon/fleet/bootstrap.ts";
import { scaffoldFiles } from "../src/archon/fleet/scaffold.ts";
import { MIN_DENO } from "../src/archon/update/operator.ts";

const SCRIPT = new URL("../bin/bootstrap.sh", import.meta.url).pathname;
const PS1 = new URL("../bin/bootstrap.windows.ps1", import.meta.url).pathname;
const has = async (cmd: string) => {
  try {
    return (await new Deno.Command("sh", { args: ["-c", `command -v ${cmd}`], stdout: "null" })
      .output()).success;
  } catch {
    return false;
  }
};

Deno.test("062: the template installs the engine's minimum Deno, on both systems", () => {
  for (const p of BOOTSTRAP_PATHS) {
    assertEquals(bootstrapDenoMin(bootstrapTemplate(p)), MIN_DENO, p);
  }
});

Deno.test("062: a fleet's copy has its repository; without one it asks for --repo", () => {
  const f = bootstrapFiles("example/fleet");
  assertStringIncludes(f["bin/bootstrap.sh"], 'DEFAULT_REPO="example/fleet"');
  assertStringIncludes(f["bin/bootstrap.windows.ps1"], '$DefaultRepo = "example/fleet"');
  assertStringIncludes(bootstrapFiles()["bin/bootstrap.sh"], 'DEFAULT_REPO=""');
  const s = scaffoldFiles("v1.0.0", undefined, "example/fleet");
  assertEquals(s["bin/bootstrap.sh"], f["bin/bootstrap.sh"]);
  assertStringIncludes(s[".gitattributes"], "*.sh text eol=lf");
  for (
    const [url, slug] of [
      ["https://github.com/example/fleet.git", "example/fleet"],
      ["git@github.com:example/fleet.git", "example/fleet"],
      ["https://github.com/example/fleet", "example/fleet"],
      ["https://gitlab.com/example/fleet.git", undefined],
    ] as const
  ) assertEquals(githubSlug(url), slug, url);
});

Deno.test(
  "062: shellcheck finds nothing in bootstrap.sh",
  { ignore: !(await has("shellcheck")) },
  async () => {
    const r = await new Deno.Command("shellcheck", { args: [SCRIPT], stdout: "piped" }).output();
    assert(r.success, new TextDecoder().decode(r.stdout));
  },
);

Deno.test(
  "062: bootstrap.windows.ps1 parses (PowerShell)",
  { ignore: !(await has("pwsh")) },
  async () => {
    const r = await new Deno.Command("pwsh", {
      args: [
        "-NoProfile",
        "-Command",
        `$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('${PS1}', [ref]$null, [ref]$e) | Out-Null; if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(r.success, new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr));
  },
);

/** A throwaway home, a source repository to clone, and a runner for bootstrap.sh (no terminal). */
async function bootSandbox() {
  const home = await Deno.makeTempDir({ prefix: "stolos-bootstrap-test-" });
  const src = join(home, "src");
  const git = async (cwd: string, ...a: string[]) => {
    const r = await new Deno.Command("git", { args: a, cwd, env, stdout: "piped", stderr: "piped" })
      .output();
    if (!r.success) throw new Error(`git ${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
    return new TextDecoder().decode(r.stdout).trim();
  };
  const env: Record<string, string> = {
    HOME: home,
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    NO_COLOR: "1",
  };
  await Deno.mkdir(src);
  await git(src, "init", "-q", "-b", "main");
  await Deno.writeTextFile(join(src, "README.md"), "a fleet\n");
  await git(src, "add", "-A");
  await git(src, "commit", "-q", "--no-gpg-sign", "-m", "a fleet");
  const boot = async (...args: string[]) => {
    // setsid: no controlling terminal, as in CI (a prompt must refuse, never wait).
    const r = await new Deno.Command("setsid", {
      args: ["bash", SCRIPT, ...args],
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    return { code: r.code, out: d.decode(r.stdout) + d.decode(r.stderr) };
  };
  return { home, src, fleet: join(home, "fleet"), boot, git };
}

const posix = Deno.build.os !== "windows";

Deno.test(
  "062: bootstrap.sh clones into ~/fleet, adds the shortcut once, and is safe to run again",
  {
    ignore: !posix,
  },
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
      assertStringIncludes(r.out, "[ok] Deno");
      assert(!r.out.includes("gh"), "a repository that is not on GitHub needs no gh");
      assertEquals(await Deno.readTextFile(join(s.fleet, "README.md")), "a fleet\n");
      const rc = await Deno.readTextFile(join(s.home, ".bashrc"));
      assertStringIncludes(rc, 'stolos() { deno task stolos "$@"; }');

      // Again: the fleet is there, so it would be brought up to date; the shortcut is not added twice.
      r = await s.boot("--repo", s.src, "--dry-run");
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "bringing it up to date");
      assertStringIncludes(r.out, "deno task stolos update");
      r = await s.boot("--repo", s.src, "--no-shortcut", "--dry-run");
      assert(!r.out.includes("Shortcut"), r.out);
      assertEquals(
        (await Deno.readTextFile(join(s.home, ".bashrc"))).split("# stolos shortcut").length - 1,
        1,
      );

      // A folder that is something else is never touched, even with --destroy-existing.
      const other = join(s.home, "other");
      await Deno.mkdir(other);
      await Deno.writeTextFile(join(other, "notes.txt"), "mine\n");
      r = await s.boot("--repo", s.src, "--in", other, "--destroy-existing");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "is not a checkout of");
      assertEquals(await Deno.readTextFile(join(other, "notes.txt")), "mine\n");
    } finally {
      await Deno.remove(s.home, { recursive: true });
    }
  },
);

Deno.test(
  "062: bootstrap.sh --destroy-existing clones fresh; work only there needs the folder's name typed",
  {
    ignore: !posix,
  },
  async () => {
    const s = await bootSandbox();
    try {
      assertEquals((await s.boot("--repo", s.src, "--no-shortcut")).code, 0);
      // Clean: removed and cloned again (a file inside .git marks the old checkout).
      await Deno.writeTextFile(join(s.fleet, ".git", "old-checkout"), "");
      let r = await s.boot("--repo", s.src, "--no-shortcut", "--destroy-existing");
      assertEquals(r.code, 0, r.out);
      assert(!(await exists(join(s.fleet, ".git", "old-checkout"))), "a fresh clone");

      // An edit and a commit not pushed: listed; with no terminal to confirm in, nothing is removed.
      await Deno.writeTextFile(join(s.fleet, "README.md"), "edited\n");
      await Deno.writeTextFile(join(s.fleet, "new.txt"), "x\n");
      await s.git(s.fleet, "add", "new.txt");
      await s.git(s.fleet, "commit", "-q", "--no-gpg-sign", "-m", "local only");
      r = await s.boot("--repo", s.src, "--no-shortcut", "--destroy-existing");
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "would be lost");
      assertStringIncludes(r.out, "README.md");
      assertStringIncludes(r.out, "local only");
      assertStringIncludes(r.out, "no terminal to confirm in");
      assertEquals(await Deno.readTextFile(join(s.fleet, "README.md")), "edited\n");
    } finally {
      await Deno.remove(s.home, { recursive: true });
    }
  },
);

async function exists(p: string) {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
