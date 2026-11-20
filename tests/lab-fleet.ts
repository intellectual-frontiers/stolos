/**
 * A sandbox fleet for tests that run the real `stolos` command (specs 105-calm-output and
 * 106-one-passphrase-speed): a real temporary Git repository with an origin, the example lab, a
 * daily key (passphrase `PASS`) made by `keys setup`, and OpenSSH's own askpass answering for the
 * person (a counting one where a test wants to know how often it was asked).
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals } from "@intellectual-frontiers/commons/ts/runtime/test";
import { VERSION } from "../src/archon/version.ts";
import { askpassHelper, ENGINE_ROOT, linkEngine, sandbox, type Sandbox } from "./sandbox.ts";

/** The daily key's passphrase in every sandbox fleet (a made-up one). */
export const PASS = "correct horse battery staple";

/** A fleet repository in a sandbox, as a PC has it, with a daily key (passphrase `PASS`). */
export async function fleet(): Promise<{
  sb: Sandbox;
  repo: string;
  origin: string;
  env: Record<string, string>;
  sh: (cwd: string, ...a: string[]) => Promise<string>;
  stolos: (args: string[], extra?: Record<string, string>) => ReturnType<Sandbox["run"]>;
}> {
  const sb = await sandbox("archon-calm-");
  const home = sb.home;
  const askpass = await askpassHelper(home, PASS);
  const gitconfig = path.join(home, "gitconfig");
  await fs.writeTextFile(gitconfig, "[user]\n\tname = t\n\temail = t@example.invalid\n");
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    ARCHON_TEST_PASSPHRASE: PASS,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: ":0",
    SSH_AUTH_SOCK: path.join(home, "no-agent"),
  };
  const sh = async (cwd: string, ...a: string[]): Promise<string> => {
    const r = await proc.output(a, {
      cwd,
      env: { ...proc.env.toObject(), ...env, HOME: home },
      stdin: "null",
    });
    if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
    return new TextDecoder().decode(r.stdout).trim();
  };
  const origin = path.join(home, "origin.git");
  const repo = path.join(home, "fleet");
  await sh(home, "git", "init", "-q", "--bare", "-b", "main", origin);
  await sh(home, "git", "clone", "-q", origin, repo);
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await sh(".", "cp", "-r", "examples/fleets/lab", path.join(repo, "fleets", "lab"));
  await linkEngine(repo);
  await fs.remove(path.join(repo, "fleets", "lab", "signers.ts")).catch(() => {});
  await fs.writeTextFile(path.join(repo, ".gitignore"), "out/\nnode_modules/\n");
  await fs.writeTextFile(
    path.join(repo, "package.json"),
    JSON.stringify({ scripts: { stolos: `bun ${path.toPosix(proc.cwd())}/src/stolos/main.ts` } }) +
      "\n",
  );
  await fs.writeTextFile(
    path.join(repo, "stolos.ts"),
    `import { run } from ${JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, "src/stolos/main.ts")).href)};\nawait run();\n`,
  );
  const stolos = (args: string[], extra: Record<string, string> = {}) =>
    sb.run("src/stolos/main.ts", args, "", {
      ...env,
      ARCHON_REPO: repo,
      ARCHON_FLEET: "lab",
      ...extra,
    });
  assertEquals((await stolos(["keys", "setup"])).code, 0);
  const first = await stolos(["apply", "-m", "lab: the fleet and its signers"]);
  assertEquals(first.code, 0, first.out);
  return { sb, repo, origin, env, sh, stolos };
}

/** An askpass helper that answers wrong for its first `wrong` calls, then right; it counts them in `count`. */
export async function countingAskpass(dir: string, count: string, wrong: number): Promise<string> {
  if (proc.build.os === "windows") {
    const file = path.join(dir, "askpass-count.cmd");
    await fs.writeTextFile(
      file,
      `@echo off\r\nsetlocal enabledelayedexpansion\r\nset n=0\r\nif exist "${count}" set /p n=<"${count}"\r\nset /a n=n+1\r\necho !n!>"${count}"\r\nif !n! LEQ ${wrong} (echo wrong) else (echo ${PASS})\r\n`,
    );
    return file;
  }
  const file = path.join(dir, "askpass-count.sh");
  await fs.writeTextFile(
    file,
    `#!/bin/sh\nn=$(cat '${count}' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '${count}'\nif [ "$n" -le ${wrong} ]; then echo wrong; else echo '${PASS}'; fi\n`,
  );
  await fs.chmod(file, 0o755);
  return file;
}

/** The engine as a fleet fetches it: a local Git repository of this checkout's sources, its package saying `says`, tagged. */
export async function engineRepo(
  sh: (cwd: string, ...a: string[]) => Promise<string>,
  dir: string,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const own: unknown = JSON.parse(await fs.readTextFile(path.join(ENGINE_ROOT, "package.json")));
  assert(typeof own === "object" && own !== null);
  await fs.writeTextFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "@intellectual-frontiers/stolos",
      version: VERSION,
      type: "module",
      exports: { "./package.json": "./package.json", "./*": "./src/*.ts" },
      dependencies: Reflect.get(own, "dependencies") as unknown,
    }),
  );
  await sh(ENGINE_ROOT, "cp", "-r", "src", path.join(dir, "src"));
  await sh(dir, "git", "init", "-q", "-b", "main");
  await sh(dir, "git", "add", "-A");
  await sh(
    dir,
    "git",
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    "engine",
  );
  await sh(dir, "git", "tag", `stolos-v${VERSION}`);
}
