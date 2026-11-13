// Spec 047-intent-and-identity (Article 9): a host applies only a tip of main
// signed by a signer it already trusts, and newer than what it applied.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  allowedSignersText,
  checkTip,
  signerProblems,
  signersSource,
} from "../src/archon/identity/signers.ts";
import type { SignerDef } from "../src/archon/model/types.ts";

const sh = async (cwd: string, ...a: string[]) => {
  const r = await new Deno.Command(a[0], {
    args: a.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
};

async function key(dir: string, name: string): Promise<{ file: string; pub: string }> {
  const file = `${dir}/${name}`;
  await sh(dir, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file);
  const pub = (await Deno.readTextFile(file + ".pub")).trim().split(" ").slice(0, 2).join(" ");
  return { file, pub };
}

/** A repository with one commit per call, signed with `signer` (or not). */
async function repo(dir: string) {
  await sh(dir, "git", "init", "-q", "-b", "main");
  await sh(dir, "git", "config", "user.email", "test@example.invalid");
  await sh(dir, "git", "config", "user.name", "test");
  let n = 0;
  return async (signer?: string): Promise<string> => {
    await Deno.writeTextFile(`${dir}/f${n++}.txt`, String(n));
    await sh(dir, "git", "add", "-A");
    const sign = signer
      ? [
        "-c",
        "gpg.format=ssh",
        "-c",
        "gpg.ssh.program=ssh-keygen",
        "-c",
        `user.signingkey=${signer}`,
        "commit",
        "-S",
      ]
      : ["commit", "--no-gpg-sign"];
    await sh(dir, "git", ...sign, "-q", "-m", `c${n}`);
    return await sh(dir, "git", "rev-parse", "HEAD");
  };
}

const signer = (name: string, key: string, role: "daily" | "recovery" = "daily"): SignerDef => ({
  name,
  role,
  key,
  added: "2026-11-13",
});

Deno.test("047: signers.ts has one fixed form; problems are named", () => {
  const list = [
    signer("b-recovery", "ssh-ed25519 AAAAB", "recovery"),
    signer("a-daily", "ssh-ed25519 AAAAA"),
  ];
  const src = signersSource(list);
  assert(src.indexOf("a-daily") < src.indexOf("b-recovery"), "sorted by name");
  assertStringIncludes(src, "] satisfies SignerDef[];");
  assertEquals(signersSource([...list].reverse()), src, "the same list, the same text");
  assertEquals(signerProblems(list), []);
  assert(signerProblems([]).some((p) => /no daily signer/.test(p.message)));
  assert(signerProblems([signer("x", "ssh-rsa AAAA")]).some((p) => /ed25519/.test(p.message)));
  assertStringIncludes(
    allowedSignersText(list, '# local\nhelper namespaces="git" ssh-ed25519 AAAAC\n'),
    'a-daily namespaces="git" ssh-ed25519 AAAAA\nb-recovery namespaces="git" ssh-ed25519 AAAAB\nhelper',
  );
});

Deno.test("047: only a signed, newer tip by a trusted key is accepted", async () => {
  const dir = await Deno.makeTempDir({ prefix: "archon-signers-" });
  try {
    const daily = await key(dir, "daily");
    const stranger = await key(dir, "stranger");
    const allowed = `${dir}/allowed_signers`;
    await Deno.writeTextFile(allowed, allowedSignersText([signer("alice-daily", daily.pub)]));
    const commit = await repo(`${dir}`);
    const c1 = await commit(daily.file);
    let t = await checkTip(dir, c1, "", allowed);
    assert(t.ok, t.reason);
    assertEquals(t.signer, "alice-daily");

    const c2 = await commit();
    t = await checkTip(dir, c2, c1, allowed);
    assert(!t.ok && /not signed/.test(t.reason!), t.reason);

    const c3 = await commit(stranger.file);
    t = await checkTip(dir, c3, c1, allowed);
    assert(!t.ok && /not signed by a key this host trusts/.test(t.reason!), t.reason);

    const c4 = await commit(daily.file);
    t = await checkTip(dir, c4, c1, allowed);
    assert(t.ok, "a signed tip vouches for the unsigned commits below it");
    t = await checkTip(dir, c1, c4, allowed);
    assert(!t.ok && /rollback/.test(t.reason!), "never back to an older commit");

    // A stranger who adds their own key and signs that commit with it is refused:
    // the host checks with the list it already trusts.
    await Deno.writeTextFile(
      `${dir}/signers.txt`,
      allowedSignersText([signer("alice-daily", daily.pub), signer("mallory", stranger.pub)]),
    );
    const c5 = await commit(stranger.file);
    t = await checkTip(dir, c5, c4, allowed);
    assert(!t.ok, "a signer cannot add itself");

    await Deno.writeTextFile(allowed, "# nobody\n");
    t = await checkTip(dir, c4, c1, allowed);
    assert(!t.ok && /lists no signer/.test(t.reason!), t.reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("047: the install trusts the fleet's signers and runs nothing unsigned", async () => {
  const { fleet, host } = await import("./fixtures.ts");
  const { firstBootScript, userData } = await import("../src/archon/render/autoinstall.ts");
  const f = { ...fleet(), signers: [signer("alice-daily", "ssh-ed25519 AAAAA")] };
  const script = firstBootScript(f, host());
  assert(
    script.indexOf("verify-commit HEAD") < script.indexOf("exec /usr/local/bin/deno"),
    "the signature is checked before anything from the repository runs",
  );
  assertStringIncludes(script, "gpg.ssh.allowedSignersFile=/etc/archon/allowed_signers");
  const ud = userData(
    { fleet: f, host: host(), base: "http://10.0.1.157:8080/" } as never,
    {} as never,
  );
  assertStringIncludes(ud, "/etc/archon/allowed_signers");
  assertStringIncludes(ud, 'alice-daily namespaces=\\"git\\" ssh-ed25519 AAAAA');
});
