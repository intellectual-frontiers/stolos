/**
 * Spec 058: `archon update` on your PC: pull (fast-forward only), the approval
 * check servers make, the engine's newest release, key repairs; idempotent.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { atLeast, newestTag } from "../src/archon/update/operator.ts";
import { sandbox, linkEngine } from "./sandbox.ts";

proves(
  ["058-operator-update FR-001"],
  "058: the newest release tag, and the runtime version check",
  () => {
    const ls = [
      "aaa\trefs/tags/v0.9.0",
      "bbb\trefs/tags/v0.37.0",
      "ccc\trefs/tags/v0.4.12",
      "ddd\trefs/tags/e2e-dev",
    ].join("\n");
    assertEquals(newestTag(ls), "v0.37.0");
    assertEquals(newestTag("nothing"), undefined);
    assert(atLeast("2.9.6", "2.9.6") && atLeast("2.10.0", "2.9.6") && atLeast("3.0.0", "2.9.6"));
    assert(!atLeast("2.9.5", "2.9.6") && !atLeast("1.46.3", "2.9.6"));
  },
);

proves(
  ["058-operator-update FR-001"],
  "058: update pulls, warns about an unsigned tip, and is safe to run again",
  async () => {
    const sb = await sandbox("archon-update-");
    try {
      const gitconfig = path.join(sb.home, "gitconfig");
      await fs.writeTextFile(gitconfig, "[user]\n\tname = t\n\temail = t@example.invalid\n");
      const env = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", HOME: sb.home };
      const sh = async (cwd: string, ...a: string[]): Promise<string> => {
        const r = await proc.output(a, { cwd, env: { ...proc.env.toObject(), ...env } });
        if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
        return new TextDecoder().decode(r.stdout).trim();
      };
      // "GitHub" (a bare repository), your PC's checkout, and someone else's.
      const origin = path.join(sb.home, "origin.git");
      const mine = path.join(sb.home, "fleet");
      const theirs = path.join(sb.home, "theirs");
      await sh(sb.home, "git", "init", "-q", "--bare", "-b", "main", origin);
      await sh(sb.home, "git", "clone", "-q", origin, theirs);
      await fs.mkdir(path.join(theirs, "fleets"), { recursive: true });
      await sh(".", "cp", "-r", "examples/fleets/lab", path.join(theirs, "fleets", "lab"));
      await fs.writeTextFile(path.join(theirs, ".gitignore"), "node_modules/\n");
      // A signer, so an unsigned commit is one servers refuse.
      await fs.writeTextFile(
        path.join(theirs, "fleets", "lab", "signers.ts"),
        `export default [\n  {\n    name: "a-daily",\n    role: "daily",\n    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",\n    added: "2026-11-14",\n  },\n] satisfies SignerDef[];\n`,
      );
      await sh(theirs, "git", "add", "-A");
      await sh(theirs, "git", "commit", "-q", "--no-gpg-sign", "-m", "lab: the fleet");
      await sh(theirs, "git", "push", "-q", "origin", "main");
      await sh(sb.home, "git", "clone", "-q", origin, mine);
      await linkEngine(mine);

      const archon = (args: string[]): ReturnType<typeof sb.run> =>
        sb.run("src/stolos/main.ts", args, "", { ...env, ARCHON_REPO: mine, ARCHON_FLEET: "lab" });
      let r = await archon(["update", "--no-doctor", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "up to date");

      // Someone pushes an unsigned commit: update pulls it and says servers will refuse it.
      await fs.writeTextFile(path.join(theirs, "note.txt"), "x\n");
      await sh(theirs, "git", "add", "-A");
      await sh(theirs, "git", "commit", "-q", "--no-gpg-sign", "-m", "unsigned change");
      await sh(theirs, "git", "push", "-q", "origin", "main");
      r = await archon(["update", "--no-doctor", "--verbose"]);
      assertStringIncludes(r.out, "1 new commit(s)");
      assertStringIncludes(r.out, "servers wait for your approval");
      assertStringIncludes(r.out, "fix: bun run stolos apply");
      assertEquals(await sh(mine, "git", "log", "-1", "--format=%s"), "unsigned change");

      // Again: nothing new; nothing changes.
      r = await archon(["update", "--no-doctor", "--verbose"]);
      assertStringIncludes(r.out, "up to date");
      assert(!r.out.includes("servers will refuse"), r.out);

      // Local changes are never merged over: named, with what to do.
      await fs.writeTextFile(path.join(theirs, "note.txt"), "y\n");
      await sh(theirs, "git", "commit", "-q", "-a", "--no-gpg-sign", "-m", "another");
      await sh(theirs, "git", "push", "-q", "origin", "main");
      await fs.writeTextFile(path.join(mine, "note.txt"), "mine\n");
      r = await archon(["update", "--no-doctor", "--verbose"]);
      assertStringIncludes(r.out, "you have changes not committed");
      assertEquals(await fs.readTextFile(path.join(mine, "note.txt")), "mine\n");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["058-operator-update FR-002"],
  "058: on a machine, archon update is spec 015's: elevated and locked; the PC's is another command",
  async () => {
    const { COMMANDS, offeredOn } = await import("../src/archon/commands/registry.ts");
    const { effectiveTier, parseArgs } = await import("../src/archon/core/registry-types.ts");
    const machine = COMMANDS.filter((c) => c.name === "update" && offeredOn(c, "machine"));
    const pc = COMMANDS.filter((c) => c.name === "update" && offeredOn(c, "pc"));
    assertEquals([machine.length, pc.length], [1, 1]);
    const [m] = machine;
    assert(m !== undefined && m !== pc[0], "two commands, one each");
    // Mutate: main elevates it through sudo, and as root takes the host lock (it is not unlocked).
    assertEquals(effectiveTier(m, parseArgs(m, [])), "mutate");
    assert(!m.unlocked, "locked: one host-changing run at a time");
    assertEquals(effectiveTier(m, parseArgs(m, ["--check"])), "read", "--check changes nothing");
    assertStringIncludes(m.description, "(spec 015)");
    // It runs spec 015's update (pull, validate, apply, tools, verify).
    const src = await fs.readTextFile(
      path.fromFileUrl(new URL("../src/archon/commands/registry.ts", import.meta.url)),
    );
    const body = src.slice(src.indexOf('summary: "Bring this machine up to date'));
    assertStringIncludes(body.slice(0, 1500), 'await import("../update/update.ts")');
  },
);

proves(
  ["058-operator-update FR-003"],
  "058: the READMEs say bun run stolos update, never git pull",
  async () => {
    const root = path.fromFileUrl(new URL("../", import.meta.url));
    const readmes = ["README.md", "home/README.md", "tests/e2e/README.md"];
    for (const f of readmes) {
      const t = await fs.readTextFile(path.join(root, f));
      for (const line of t.split("\n")) {
        if (/\bgit pull\b/.test(line)) {
          assert(/instead of git pull/.test(line), `${f}: ${line}`);
        }
      }
    }
    assertStringIncludes(
      await fs.readTextFile(path.join(root, "README.md")),
      "bun run stolos update",
    );
  },
);
