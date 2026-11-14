// Spec 058: `archon update` on your PC: pull (fast-forward only), the approval
// check servers make, the engine's newest release, key repairs; idempotent.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";
import { atLeast, newestTag } from "../src/archon/update/operator.ts";
import { sandbox } from "./sandbox.ts";

Deno.test("058: the newest release tag, and the Deno version check", () => {
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
});

Deno.test("058: update pulls, warns about an unsigned tip, and is safe to run again", async () => {
  const sb = await sandbox("archon-update-");
  try {
    const gitconfig = join(sb.home, "gitconfig");
    await Deno.writeTextFile(gitconfig, "[user]\n\tname = t\n\temail = t@example.invalid\n");
    const env = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", HOME: sb.home };
    const sh = async (cwd: string, ...a: string[]) => {
      const r = await new Deno.Command(a[0], {
        args: a.slice(1),
        cwd,
        env: { ...Deno.env.toObject(), ...env },
      })
        .output();
      if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
      return new TextDecoder().decode(r.stdout).trim();
    };
    // "GitHub" (a bare repository), your PC's checkout, and someone else's.
    const origin = join(sb.home, "origin.git");
    const mine = join(sb.home, "fleet");
    const theirs = join(sb.home, "theirs");
    await sh(sb.home, "git", "init", "-q", "--bare", "-b", "main", origin);
    await sh(sb.home, "git", "clone", "-q", origin, theirs);
    await Deno.mkdir(join(theirs, "fleets"), { recursive: true });
    await sh(".", "cp", "-r", "examples/fleets/lab", join(theirs, "fleets", "lab"));
    // A signer, so an unsigned commit is one servers refuse.
    await Deno.writeTextFile(
      join(theirs, "fleets", "lab", "signers.ts"),
      `export default [\n  {\n    name: "a-daily",\n    role: "daily",\n    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",\n    added: "2026-11-14",\n  },\n] satisfies SignerDef[];\n`,
    );
    await sh(theirs, "git", "add", "-A");
    await sh(theirs, "git", "commit", "-q", "--no-gpg-sign", "-m", "lab: the fleet");
    await sh(theirs, "git", "push", "-q", "origin", "main");
    await sh(sb.home, "git", "clone", "-q", origin, mine);

    const archon = (args: string[]) =>
      sb.run("src/stolos/main.ts", args, "", { ...env, ARCHON_REPO: mine, ARCHON_FLEET: "lab" });
    let r = await archon(["update", "--no-doctor"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "up to date");

    // Someone pushes an unsigned commit: update pulls it and says servers will refuse it.
    await Deno.writeTextFile(join(theirs, "note.txt"), "x\n");
    await sh(theirs, "git", "add", "-A");
    await sh(theirs, "git", "commit", "-q", "--no-gpg-sign", "-m", "unsigned change");
    await sh(theirs, "git", "push", "-q", "origin", "main");
    r = await archon(["update", "--no-doctor"]);
    assertStringIncludes(r.out, "1 new commit(s)");
    assertStringIncludes(r.out, "servers wait for your approval");
    assertStringIncludes(r.out, "deno task stolos apply (it lists those commits");
    assertEquals(await sh(mine, "git", "log", "-1", "--format=%s"), "unsigned change");

    // Again: nothing new; nothing changes.
    r = await archon(["update", "--no-doctor"]);
    assertStringIncludes(r.out, "up to date");
    assert(!r.out.includes("servers will refuse"), r.out);

    // Local changes are never merged over: named, with what to do.
    await Deno.writeTextFile(join(theirs, "note.txt"), "y\n");
    await sh(theirs, "git", "commit", "-q", "-a", "--no-gpg-sign", "-m", "another");
    await sh(theirs, "git", "push", "-q", "origin", "main");
    await Deno.writeTextFile(join(mine, "note.txt"), "mine\n");
    r = await archon(["update", "--no-doctor"]);
    assertStringIncludes(r.out, "you have changes not committed");
    assertEquals(await Deno.readTextFile(join(mine, "note.txt")), "mine\n");
  } finally {
    await Deno.remove(sb.home, { recursive: true });
  }
});
