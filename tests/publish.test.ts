/**
 * host add and retire commit and push by themselves (publishChange): the commit
 * is signed with a passphrase-protected key, so Git must have the terminal
 * (OpenSSH asks for the passphrase; here, SSH_ASKPASS answers it).
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { assert, assertEquals, test } from "@intellectual-frontiers/commons/ts/runtime/test";
import { askpassHelper } from "./sandbox.ts";

test("004: publishChange makes a signed commit with a passphrase-protected key, and pushes it", async () => {
  const dir = await fs.makeTempDir({ prefix: "stolos-publish-" });
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string): void => {
    saved[k] = proc.env.get(k);
    proc.env.set(k, v);
  };
  try {
    const sh = async (cwd: string, ...a: string[]): Promise<string> => {
      const r = await proc.run(a, { cwd, stdin: "null" });
      if (!r.success) throw new Error(`${a.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
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
      path.join(dir, "key"),
    );
    const askpass = await askpassHelper(dir, pass);
    set("SSH_ASKPASS", askpass);
    set("SSH_ASKPASS_REQUIRE", "force");
    set("DISPLAY", ":0");
    set("SSH_AUTH_SOCK", path.join(dir, "no-agent"));
    const origin = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    await sh(dir, "git", "init", "-q", "--bare", "-b", "main", origin);
    await sh(dir, "git", "clone", "-q", origin, repo);
    for (const [k, v] of [
      ["user.name", "t"],
      ["user.email", "t@example.invalid"],
      ["gpg.format", "ssh"],
      ["user.signingkey", path.join(dir, "key")],
      ["commit.gpgsign", "true"],
    ] as const)
      await sh(repo, "git", "config", k, v);
    await fs.writeTextFile(path.join(repo, "host.ts"), "export const host = {};\n");
    const { publishChange } = await import("../src/archon/install/publish.ts");
    const ok = await publishChange(["host.ts"], "004-install: add host t", {
      repo,
      build: false,
    });
    assert(ok, "committed and pushed");
    assertEquals(
      await sh(origin, "git", "log", "-1", "--format=%s", "main"),
      "004-install: add host t",
    );
    const raw = await sh(origin, "git", "cat-file", "commit", "main");
    assert(raw.includes("-----BEGIN SSH SIGNATURE-----"), "signed with the SSH key");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) proc.env.delete(k);
      else proc.env.set(k, v);
    }
    await fs.remove(dir, { recursive: true });
  }
});
