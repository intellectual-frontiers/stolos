/**
 * Spec 060: `stolos apply` (or `stolos push`): check, catch up, build, one
 * signed commit, verify, push; with nothing new, it does nothing.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { describeChanges } from "../src/archon/fleet/apply.ts";
import { allowedSignersText, checkTip } from "../src/archon/identity/signers.ts";
import { parseSignersSource } from "../src/archon/identity/keys.ts";
import { sandbox, linkEngine } from "./sandbox.ts";

const PASS = "correct horse battery staple";

proves(["060-stolos-apply FR-001"], "060: what changed, by fleet and host", () => {
  assertEquals(
    describeChanges(
      [
        " M fleets/fcr/hosts/olympia/host.ts",
        "?? fleets/fcr/hosts/olympia/registration.ts",
        " M fleets/fcr/fleet.ts",
        "A  fleets/fcr/signers.ts",
        " M README.md",
      ].join("\n"),
    ),
    "olympia: host.ts, registration.ts; fcr: fleet.ts, signers.ts; README.md",
  );
  assertEquals(describeChanges(""), "");
});

proves(
  ["060-stolos-apply FR-001", "060-stolos-apply FR-002"],
  "060: apply commits once (signed), verifies, pushes; push is the same; again does nothing",
  async () => {
    const sb = await sandbox("archon-apply-");
    try {
      const home = sb.home;
      const askpass = path.join(home, "askpass.sh");
      await fs.writeTextFile(askpass, `#!/bin/sh\necho '${PASS}'\n`);
      await fs.chmod(askpass, 0o755);
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
      const sh = async (cwd: string, ...a: string[]) => {
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
      // As a fleet repository has them: out/ ignored, and the stolos script (the pre-push check
      // runs it with bun run).
      await fs.writeTextFile(path.join(repo, ".gitignore"), "out/\nnode_modules/\n");
      await fs.writeTextFile(
        path.join(repo, "package.json"),
        JSON.stringify({ scripts: { stolos: `bun ${proc.cwd()}/src/stolos/main.ts` } }) + "\n",
      );
      const stolos = (args: string[]) =>
        sb.run("src/stolos/main.ts", args, "", { ...env, ARCHON_REPO: repo, ARCHON_FLEET: "lab" });

      assertEquals((await stolos(["keys", "setup"])).code, 0);
      // --check: shows, changes nothing.
      let r = await stolos(["apply", "--check"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "lab: ");
      assertEquals(await sh(repo, "git", "rev-list", "--all", "--count"), "0");

      // The first apply: one signed commit, verified, pushed.
      r = await stolos(["apply", "-m", "lab: the fleet and its signers"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "signed by a key the servers trust");
      const head = await sh(origin, "git", "rev-parse", "main");
      assertEquals(
        await sh(origin, "git", "log", "-1", "--format=%s", "main"),
        "lab: the fleet and its signers",
      );
      const allowed = path.join(home, "allowed");
      await fs.writeTextFile(
        allowed,
        allowedSignersText(
          parseSignersSource(await fs.readTextFile(path.join(repo, "fleets/lab/signers.ts"))),
        ),
      );
      const t = await checkTip(origin, head, "", allowed);
      assert(t.ok, t.reason);

      // Again: nothing to do.
      r = await stolos(["apply"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "up to date");

      // A change, through the other name; the message is written from what changed.
      const hostFile = path.join(repo, "fleets/lab/hosts/alpha/host.ts");
      await fs.writeTextFile(hostFile, (await fs.readTextFile(hostFile)) + "\n// a change\n");
      r = await stolos(["push"]);
      assertEquals(r.code, 0, r.out);
      assertEquals(
        await sh(origin, "git", "log", "-1", "--format=%s", "main"),
        "lab: alpha: host.ts",
      );
      assertEquals(await sh(repo, "git", "status", "--porcelain"), "");

      // A commit made elsewhere, not signed by a fleet signer (a tool, the website), on GitHub:
      // apply lists it and approves it with one signed commit on top.
      await fs.writeTextFile(path.join(repo, "NOTES.md"), "made elsewhere\n");
      await sh(repo, "git", "add", "-A");
      await sh(repo, "git", "commit", "-q", "--no-gpg-sign", "-m", "notes, unsigned");
      await sh(repo, "git", "push", "-q", "--no-verify", "origin", "main");
      r = await stolos(["apply"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "notes, unsigned (t)");
      assertStringIncludes(r.out, "1 commit(s) here are not signed by a fleet signer");
      const tip = await sh(origin, "git", "rev-parse", "main");
      assert((await checkTip(origin, tip, "", allowed)).ok, "servers accept GitHub's tip again");
      assertStringIncludes(
        await sh(origin, "git", "log", "-1", "--format=%s", "main"),
        "lab: approve 1 commit(s)",
      );
      r = await stolos(["apply"]);
      assertStringIncludes(r.out, "up to date");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);
