// host add and retire commit and push by themselves (publishChange): the commit
// is signed with a passphrase-protected key, so Git must have the terminal
// (OpenSSH asks for the passphrase; here, SSH_ASKPASS answers it).

import { assert, assertEquals } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";

Deno.test("004: publishChange makes a signed commit with a passphrase-protected key, and pushes it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "stolos-publish-" });
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string) => {
    saved[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  };
  try {
    const sh = async (cwd: string, ...a: string[]) => {
      const r = await new Deno.Command(a[0], { args: a.slice(1), cwd, stdin: "null" }).output();
      if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
      return new TextDecoder().decode(r.stdout).trim();
    };
    const pass = "a long test passphrase";
    await sh(
      dir,
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      pass,
      "-C",
      "",
      "-f",
      join(dir, "key"),
    );
    const askpass = join(dir, "askpass.sh");
    await Deno.writeTextFile(askpass, `#!/bin/sh\necho '${pass}'\n`);
    await Deno.chmod(askpass, 0o755);
    set("SSH_ASKPASS", askpass);
    set("SSH_ASKPASS_REQUIRE", "force");
    set("DISPLAY", ":0");
    set("SSH_AUTH_SOCK", join(dir, "no-agent"));
    const origin = join(dir, "origin.git");
    const repo = join(dir, "repo");
    await sh(dir, "git", "init", "-q", "--bare", "-b", "main", origin);
    await sh(dir, "git", "clone", "-q", origin, repo);
    for (
      const [k, v] of [
        ["user.name", "t"],
        ["user.email", "t@example.invalid"],
        ["gpg.format", "ssh"],
        ["user.signingkey", join(dir, "key")],
        ["commit.gpgsign", "true"],
      ]
    ) await sh(repo, "git", "config", k, v);
    await Deno.writeTextFile(join(repo, "host.ts"), "export const host = {};\n");
    const { publishChange } = await import("../src/archon/install/publish.ts");
    const ok = await publishChange(["host.ts"], "004-install: add host t", { repo, build: false });
    assert(ok, "committed and pushed");
    assertEquals(
      await sh(origin, "git", "log", "-1", "--format=%s", "main"),
      "004-install: add host t",
    );
    const raw = await sh(origin, "git", "cat-file", "commit", "main");
    assert(raw.includes("-----BEGIN SSH SIGNATURE-----"), "signed with the SSH key");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
    await Deno.remove(dir, { recursive: true });
  }
});
