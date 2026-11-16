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
import { askpassHelper, sandbox, linkEngine } from "./sandbox.ts";

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
  [
    "060-stolos-apply FR-001",
    "060-stolos-apply FR-002",
    "060-stolos-apply FR-003",
    "060-stolos-apply FR-005",
    "060-stolos-apply FR-006",
  ],
  "060: apply commits once (signed), verifies, pushes; push is the same; again does nothing",
  async () => {
    const sb = await sandbox("archon-apply-");
    try {
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
        // With /: bun run's shell takes a \ for an escape (a Windows path).
        JSON.stringify({
          scripts: { stolos: `bun ${path.toPosix(proc.cwd())}/src/stolos/main.ts` },
        }) + "\n",
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
      // A new repository (no branch on GitHub before): the first push set the upstream.
      assertEquals(
        await sh(repo, "git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"),
        "origin/main",
      );

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

      // No passphrase is remembered: no file this left behind holds it (but the askpass helper
      // this test wrote), and no ssh-agent was started (the socket it was given is still absent).
      const left: string[] = [];
      for (const f of await fs.walkFiles(home)) {
        if (path.join(home, f) === askpass || f.split(/[\\/]/).includes("node_modules")) continue;
        const bytes = await fs.readFile(path.join(home, f)).catch(() => new Uint8Array());
        if (new TextDecoder().decode(bytes).includes(PASS)) left.push(f);
      }
      assertEquals(left, [], "the passphrase is in no file");
      assert(!(await fs.exists(env["SSH_AUTH_SOCK"] ?? "")), "no ssh-agent");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

/** The modules of the commands spec 060 FR-004 names, whose messages once said `git push`. */
const PUSHING = [
  "src/archon/identity/keys-commands.ts", // keys setup, rotate, lost
  "src/archon/update/operator.ts", // update
  "src/archon/fleet/upgrade.ts", // fleet upgrade
  "src/archon/fleet/decisions.ts", // decide
  "src/archon/install/host-add.ts", // host add
  "src/archon/install/publish.ts", // host add, boot retire
  "src/archon-boot/retire.ts", // boot retire
  "src/archon/install/workstation.ts", // workstation add
  "src/archon/guide/where.ts", // where
  "src/archon/doctor/doctor.ts", // doctor
  "src/archon-boot/doctor.ts", // boot doctor
];
/** `git push` as advice (not `git push --no-verify`, which skips the check once, nor a failure's own name). */
const GIT_PUSH = /\bgit push\b(?! --no-verify)(?!: )(?! failed)/;

proves(
  ["060-stolos-apply FR-004"],
  "060: no message of keys, update, fleet upgrade, decide, host add, retire, workstation add, where or doctor says git push; the README neither",
  async () => {
    const bad: string[] = [];
    for (const f of PUSHING) {
      (await fs.readTextFile(f)).split("\n").forEach((line, i) => {
        // Code, not its documentation comments.
        if (/^\s*(\*|\/\/|\/\*\*)/.test(line)) return;
        if (GIT_PUSH.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    const named =
      /^(keys( (setup|rotate|lost|rotate-recovery))?|update|fleet upgrade|decide|host add|boot retire|workstation add|where|doctor|boot doctor)$/;
    const commands = COMMANDS.filter((c) => named.test(c.name));
    assert(commands.length >= 9, commands.map((c) => c.name).join(", "));
    for (const c of commands) {
      for (const t of [c.summary, c.description, ...(c.examples ?? []).map((e) => e.text)]) {
        if (GIT_PUSH.test(t)) bad.push(`${c.name}: ${t}`);
      }
    }
    (await fs.readTextFile("README.md")).split("\n").forEach((line, i) => {
      if (GIT_PUSH.test(line)) bad.push(`README.md:${i + 1}: ${line.trim()}`);
    });
    assertEquals(bad, []);
    assertStringIncludes(await fs.readTextFile("README.md"), "bun run stolos apply");
  },
);
