// Spec 057: stolos keys, end to end in a sandbox: setup (twice: idempotent),
// the checks, the pre-push check, the recovery check, rotate, and lost. Real
// OpenSSH keys with real passphrases, supplied through SSH_ASKPASS (tests only).

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";
import {
  keyChecks,
  type KeyFacts,
  opensshOk,
  parseOpenSshVersion,
  parseSignersSource,
} from "../src/archon/identity/keys.ts";
import { allowedSignersText, checkTip, signersSource } from "../src/archon/identity/signers.ts";
import { sandbox } from "./sandbox.ts";

const PASS = "correct horse battery staple";

const sh = async (cwd: string, env: Record<string, string>, ...a: string[]) => {
  const r = await new Deno.Command(a[0], {
    args: a.slice(1),
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  const out = new TextDecoder().decode(r.stdout).trim();
  if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return out;
};

async function keysSandbox() {
  const sb = await sandbox("archon-keys-test-");
  const home = sb.home;
  const repo = join(home, "fleet");
  // A fleet repository: the example fleet, without its signers.
  await Deno.mkdir(join(repo, "fleets"), { recursive: true });
  await sh(".", {}, "cp", "-r", "examples/fleets/lab", join(repo, "fleets", "demo"));
  await Deno.remove(join(repo, "fleets", "demo", "signers.ts")).catch(() => {});
  const askpass = join(home, "askpass.sh");
  await Deno.writeTextFile(askpass, `#!/bin/sh\necho '${PASS}'\n`);
  await Deno.chmod(askpass, 0o755);
  const gitconfig = join(home, "gitconfig");
  await Deno.writeTextFile(gitconfig, "[user]\n\tname = test\n\temail = test@example.invalid\n");
  const env: Record<string, string> = {
    ARCHON_REPO: repo,
    ARCHON_FLEET: "demo",
    ARCHON_TEST_PASSPHRASE: PASS,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: ":0",
    SSH_AUTH_SOCK: join(home, "no-agent"),
  };
  const gitEnv = { ...Deno.env.toObject(), ...env, HOME: home };
  const git = (...a: string[]) => sh(repo, gitEnv, "git", ...a);
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "--no-gpg-sign", "-m", "demo: the fleet");
  const archon = (args: string[], stdin = "", extra: Record<string, string> = {}) =>
    sb.run("src/stolos/main.ts", args, stdin, { ...env, ...extra });
  return { home, repo, git, archon, daily: join(home, ".ssh", "fleet-signing") };
}

const mtime = (p: string) => Deno.statSync(p).mtime?.getTime();

Deno.test("057: setup makes and lists both keys, signs, and running it again changes nothing", async () => {
  const s = await keysSandbox();
  try {
    let r = await s.archon(["keys"]);
    assertEquals(r.code, 1, r.out);
    assertStringIncludes(r.out, "E057-NO-KEY");

    r = await s.archon(["keys", "setup"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "signed and verified as");
    assertStringIncludes(r.out, "RECOVERY key's passphrase");
    assert(!r.out.includes(PASS), "a passphrase is never printed");
    const recovery = join(s.home, "config", "stolos", "keys", "fleet-recovery");
    for (const f of [s.daily, s.daily + ".pub", recovery, recovery + ".pub"]) {
      assert(Deno.statSync(f).isFile, f);
    }
    const signers = parseSignersSource(
      await Deno.readTextFile(join(s.repo, "fleets", "demo", "signers.ts")),
    );
    assertEquals(signers.map((x) => x.role).sort(), ["daily", "recovery"]);
    assertEquals(await s.git("config", "--local", "commit.gpgsign"), "true");
    assertEquals(await s.git("config", "--local", "user.signingkey"), s.daily);
    assertStringIncludes(
      await Deno.readTextFile(join(s.repo, ".git", "hooks", "pre-push")),
      "keys check-push",
    );

    // Again: nothing to do, no key touched, no signature asked.
    const before = [mtime(s.daily), mtime(recovery)];
    r = await s.archon(["keys", "setup"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "nothing changed");
    assertEquals([mtime(s.daily), mtime(recovery)], before, "no key is ever overwritten");

    // The checks: signing works; the recovery key, tested at setup, is still here (a warning).
    r = await s.archon(["keys"]);
    assertEquals(r.code, 0, r.out);
    assert(!r.out.includes("E057-RECOVERY-LOOSE"), "the recovery key is in the key store");
    assert(!r.out.includes("E057-RECOVERY-CHECK"), "setup tested the recovery key: " + r.out);

    // The recovery check works on its own too.
    r = await s.archon(["keys", "check-recovery", "--key", recovery]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "works");

    // A wrong key is refused.
    r = await s.archon(["keys", "check-recovery", "--key", s.daily]);
    assertEquals(r.code, 1, r.out);
    assertStringIncludes(r.out, "not this fleet's recovery key");
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("057: the pre-push check refuses an unsigned tip, as servers would", async () => {
  const s = await keysSandbox();
  try {
    assertEquals((await s.archon(["keys", "setup"])).code, 0);
    await s.git("add", "-A");
    await s.git("commit", "-q", "-m", "demo: signers"); // signed: Git's settings here
    const signed = await s.git("rev-parse", "HEAD");
    const zero = "0".repeat(40);
    let r = await s.archon(
      ["keys", "check-push"],
      `refs/heads/main ${signed} refs/heads/main ${zero}\n`,
    );
    assertEquals(r.code, 0, r.out);

    await Deno.writeTextFile(join(s.repo, "note.txt"), "x\n");
    await s.git("add", "-A");
    await s.git("commit", "-q", "--no-gpg-sign", "-m", "unsigned");
    const unsigned = await s.git("rev-parse", "HEAD");
    r = await s.archon(
      ["keys", "check-push"],
      `refs/heads/main ${unsigned} refs/heads/main ${signed}\n`,
    );
    assertEquals(r.code, 1, r.out);
    assertStringIncludes(r.out, "is not signed");
    assertStringIncludes(r.out, "git commit --amend --no-edit -S");
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("057: rotate and lost replace the daily key, approved by the old key and the recovery key", async () => {
  const s = await keysSandbox();
  try {
    assertEquals((await s.archon(["keys", "setup"])).code, 0);
    await s.git("add", "-A");
    await s.git("commit", "-q", "-m", "demo: signers");
    const signersPath = join(s.repo, "fleets", "demo", "signers.ts");
    const allowedFrom = async (text: string) => {
      const f = join(s.home, `allowed-${crypto.randomUUID()}`);
      await Deno.writeTextFile(f, allowedSignersText(parseSignersSource(text)));
      return f;
    };

    // Rotate: the commit is signed by the old key (trusted by the list servers have).
    const before = await Deno.readTextFile(signersPath);
    const base = await s.git("rev-parse", "HEAD");
    let r = await s.archon(["keys", "rotate"]);
    assertEquals(r.code, 0, r.out);
    const rotated = await s.git("rev-parse", "HEAD");
    assert(rotated !== base, "a commit was made");
    let t = await checkTip(s.repo, rotated, base, await allowedFrom(before));
    assert(t.ok, t.reason);
    assert(Deno.statSync(s.daily).isFile && !(await exists(s.daily + ".next")));
    r = await s.archon(["keys", "rotate"]);
    assertStringIncludes(r.out, "already rotated today");
    assertEquals(await s.git("rev-parse", "HEAD"), rotated, "running it again commits nothing");

    // Lost: the daily key is gone; the recovery key approves its replacement.
    const listed = await Deno.readTextFile(signersPath);
    for (const ext of ["", ".pub"]) await Deno.remove(s.daily + ext);
    r = await s.archon(["keys"]);
    assertStringIncludes(r.out, "E057-NO-KEY");
    const recovery = join(s.home, "config", "stolos", "keys", "fleet-recovery");
    r = await s.archon(["keys", "lost", "--recovery", recovery]);
    assertEquals(r.code, 0, r.out);
    const replaced = await s.git("rev-parse", "HEAD");
    t = await checkTip(s.repo, replaced, rotated, await allowedFrom(listed));
    assert(t.ok, t.reason);
    assertStringIncludes(t.signer ?? "", "recovery", "signed by the recovery key");
    r = await s.archon(["keys", "lost", "--recovery", recovery]);
    assertStringIncludes(r.out, "nothing is lost");
    assertEquals(await s.git("rev-parse", "HEAD"), replaced, "running it again commits nothing");
    r = await s.archon(["keys"]);
    assert(!/E057-(NO-KEY|NOT-LISTED|GIT)/.test(r.out), r.out);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

async function exists(p: string) {
  return await Deno.stat(p).then(() => true).catch(() => false);
}

Deno.test("057: rotate-recovery: a new recovery key, tested, approved by the old one, in the key store; again does nothing", async () => {
  const s = await keysSandbox();
  try {
    assertEquals((await s.archon(["keys", "setup"])).code, 0);
    await s.git("add", "-A");
    await s.git("commit", "-q", "-m", "demo: signers");
    const signersPath = join(s.repo, "fleets", "demo", "signers.ts");
    const before = await Deno.readTextFile(signersPath);
    const base = await s.git("rev-parse", "HEAD");
    const stored = join(s.home, "config", "stolos", "keys", "fleet-recovery");
    const oldPub = (await Deno.readTextFile(stored + ".pub")).trim().split(" ").slice(0, 2).join(
      " ",
    );

    // No arguments: the old key is the one in the key store.
    let r = await s.archon(["keys", "rotate-recovery"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "NEW recovery key's passphrase");
    const head = await s.git("rev-parse", "HEAD");
    assert(head !== base, "a commit was made");
    // Approved by the OLD recovery key, as servers holding the old list check it.
    const allowed = join(s.home, "allowed-before");
    await Deno.writeTextFile(allowed, allowedSignersText(parseSignersSource(before)));
    const t = await checkTip(s.repo, head, base, allowed);
    assert(t.ok, t.reason);
    assertStringIncludes(t.signer ?? "", "recovery");
    const rec = parseSignersSource(await Deno.readTextFile(signersPath)).filter((x) =>
      x.role === "recovery"
    );
    assertEquals(rec.length, 1);
    assert(rec[0].key !== oldPub, "the old recovery key is no longer listed");
    // The key store holds the new key; the old one is kept, retired.
    const storedNow = (await Deno.readTextFile(stored + ".pub")).trim().split(" ").slice(0, 2).join(
      " ",
    );
    assertEquals(storedNow, rec[0].key);
    const retired = [...Deno.readDirSync(join(s.home, "config", "stolos", "keys"))]
      .map((e) => e.name).filter((n) => n.startsWith("fleet-recovery.retired-"));
    assertEquals(retired.length, 2, "the old pair, retired");

    // Again: nothing to do.
    r = await s.archon(["keys", "rotate-recovery"]);
    assertStringIncludes(r.out, "already changed today");
    assertEquals(await s.git("rev-parse", "HEAD"), head, "no new commit");
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("057: one backup holds everything: both keys; a loose recovery folder moves into the key store", async () => {
  const s = await keysSandbox();
  try {
    assertEquals((await s.archon(["keys", "setup"])).code, 0);
    const store = join(s.home, "config", "stolos", "keys");
    // As an earlier version left it: the recovery key in a loose folder in the home folder.
    const loose = join(s.home, "fleet-recovery");
    await Deno.mkdir(loose, { recursive: true });
    for (const f of ["fleet-recovery", "fleet-recovery.pub"]) {
      await Deno.rename(join(store, f), join(loose, f));
    }
    let r = await s.archon(["keys"]);
    assertStringIncludes(r.out, "E057-RECOVERY-LOOSE");

    r = await s.archon(["vault", "backup"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "both signing keys");
    const dir = join(s.home, "data", "stolos", "backup");
    const zip = [...Deno.readDirSync(dir)].map((e) => e.name).find((n) => n.endsWith(".zip"))!;
    const { unzipSync } = await import("npm:fflate@0.8.2");
    const files = Object.keys(unzipSync(Deno.readFileSync(join(dir, zip))));
    for (
      const n of [
        "signing/fleet-signing",
        "signing/fleet-signing.pub",
        "signing/recovery/fleet-recovery",
        "signing/recovery/fleet-recovery.pub",
      ]
    ) assert(files.includes(n), `${n} in ${files.join(", ")}`);
    // Backed up: moved into the key store, the loose folder gone; the checks are quiet about it.
    assert(await exists(join(store, "fleet-recovery")), "in the key store");
    assert(!(await exists(loose)), "the loose folder is gone");
    r = await s.archon(["keys"]);
    assert(!/E057-RECOVERY-(LOOSE|MISSING)/.test(r.out), r.out);
    // The next backup holds it too.
    await new Promise((x) => setTimeout(x, 1100));
    r = await s.archon(["vault", "backup"]);
    const zips = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".zip"))
      .sort();
    const again = Object.keys(unzipSync(Deno.readFileSync(join(dir, zips.at(-1)!))));
    assert(
      again.includes("signing/recovery/fleet-recovery"),
      "every backup holds the recovery key",
    );
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("061: a fresh PC from one backup ZIP: vault restore puts back both keys and signs", async () => {
  const s = await keysSandbox();
  try {
    assertEquals((await s.archon(["keys", "setup"])).code, 0);
    await s.git("add", "-A");
    await s.git("commit", "-q", "-m", "demo: signers");
    let r = await s.archon(["vault", "backup"]);
    assertEquals(r.code, 0, r.out);
    const dir = join(s.home, "data", "stolos", "backup");
    const name = [...Deno.readDirSync(dir)].map((e) => e.name).find((n) => n.endsWith(".zip"))!;
    const zip = join(s.home, name);
    await Deno.rename(join(dir, name), zip);
    const pub = await Deno.readTextFile(s.daily + ".pub");

    // The disaster: this PC's stolos folders and keys are gone; a fresh clone.
    for (const d of ["config", "data", ".ssh"]) {
      await Deno.remove(join(s.home, d), { recursive: true });
    }
    await Deno.mkdir(join(s.home, "config"));
    await Deno.mkdir(join(s.home, "data"));
    const fresh = join(s.home, "fresh");
    await s.git("clone", "-q", s.repo, fresh);
    const there = { ARCHON_REPO: fresh };

    r = await s.archon(["vault", "restore", zip], "", there);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "put back");
    assertStringIncludes(r.out, "Signers          fleets/demo/signers.ts: 2 signer(s)");
    assertStringIncludes(r.out, "signed and verified");
    assert(!r.out.includes("back up:"), "nothing new to back up");
    assertEquals(await Deno.readTextFile(s.daily + ".pub"), pub);
    assert(await exists(join(s.home, "config", "stolos", "keys", "fleet-recovery")));
    r = await s.archon(["keys"], "", there);
    assertEquals(r.code, 0, r.out);
    assert(!/E057-RECOVERY-(LOOSE|MISSING)/.test(r.out), r.out);

    // Again: nothing changes, nothing asked.
    r = await s.archon(["vault", "restore", zip], "", there);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "already here");
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("057: a second PC's key: setup prints the exact command that approves it", async () => {
  const s = await keysSandbox();
  try {
    assertEquals((await s.archon(["keys", "setup"])).code, 0);
    await s.git("add", "-A");
    await s.git("commit", "-q", "-m", "demo: signers");
    // Another PC: no daily key here yet (this one's moved aside).
    for (const ext of ["", ".pub"]) await Deno.rename(s.daily + ext, `${s.daily}.first${ext}`);
    const r = await s.archon(["keys", "setup"]);
    const pub = (await Deno.readTextFile(s.daily + ".pub")).trim().split(" ").slice(0, 2).join(" ");
    assertStringIncludes(r.out, "must be approved by a key already listed");
    assertStringIncludes(r.out, `--role daily --key "${pub}"`);
    assertStringIncludes(
      r.out,
      "git checkout -- fleets/demo/signers.ts && deno task stolos update",
    );
    // Running it again still shows the commands (the approval is still missing).
    const again = await s.archon(["keys", "setup"]);
    assertStringIncludes(again.out, `--key "${pub}"`);
  } finally {
    await Deno.remove(s.home, { recursive: true });
  }
});

Deno.test("057: the approval steps, on WSL (Windows PowerShell) and elsewhere", async () => {
  const { approvalSteps } = await import("../src/archon/identity/keys-commands.ts");
  const wsl = approvalSteps(
    "fcr",
    "fleets/fcr/signers.ts",
    "owner-pc-daily",
    "ssh-ed25519 AAAA",
    true,
  );
  assertStringIncludes(wsl[0], "PowerShell, cd C:\\fleet");
  assertEquals(
    wsl[1],
    '    deno task stolos signers add owner-pc-daily --role daily --key "ssh-ed25519 AAAA"',
  );
  assertStringIncludes(
    wsl[2],
    'deno task stolos apply -m "fcr: signers: add owner-pc-daily"',
  );
  const other = approvalSteps("fcr", "fleets/fcr/signers.ts", "x", "ssh-ed25519 AAAA", false);
  assertStringIncludes(other[0], "a PC whose key is already listed");
  assertStringIncludes(other[2], "deno task stolos apply");
});

Deno.test("057: the checks, from facts (no files, no prompts)", () => {
  assertEquals(parseOpenSshVersion("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2"), [9, 5]);
  assertEquals(parseOpenSshVersion("OpenSSH_7.4p1"), [7, 4]);
  assert(opensshOk([8, 2]) && opensshOk([9, 0]) && !opensshOk([8, 1]) && !opensshOk(undefined));
  const list = [
    { name: "a-daily", role: "daily" as const, key: "ssh-ed25519 AAAA", added: "2026-11-14" },
    { name: "a-recovery", role: "recovery" as const, key: "ssh-ed25519 BBBB", added: "2026-11-14" },
  ];
  assertEquals(parseSignersSource(signersSource(list)), list, "the fixed form reads back");
  const paths = {
    home: "/h",
    daily: "/h/.ssh/fleet-signing",
    recoveryDir: "/c/stolos/keys",
    recovery: "/c/stolos/keys/fleet-recovery",
    looseRecoveryDir: "/h/Desktop/fleet-recovery",
    allowedSigners: "/r/.git/stolos/allowed_signers",
    state: "/s",
    hook: "/r/.git/hooks/pre-push",
  };
  const good: KeyFacts = {
    paths,
    repo: true,
    fleetId: "demo",
    ssh: { found: true, version: "9.6", ok: true },
    daily: { exists: true, pub: "ssh-ed25519 AAAA", passphrase: true, inAgent: false },
    git: {
      format: "ssh",
      signingKey: paths.daily,
      gpgsign: "true",
      allowedSignersFile: paths.allowedSigners,
    },
    allowedSignersCurrent: true,
    signers: list,
    dailySigner: list[0],
    recoveryLoose: [],
    recoveryInStore: true,
    hook: true,
    state: { recoveryCheckedAt: "2026-11-01T00:00:00Z" },
  };
  const now = Date.parse("2026-11-14T00:00:00Z");
  assertEquals(keyChecks(good, now).filter((c) => !c.ok), [], "all well");
  const codes = (f: KeyFacts) =>
    keyChecks(f, now).filter((c) => !c.ok).map((c) => `${c.code}:${c.level}`);
  assertEquals(codes({ ...good, daily: { ...good.daily, passphrase: false } }), [
    "E057-NO-PASSPHRASE:fail",
  ]);
  assertEquals(codes({ ...good, daily: { ...good.daily, inAgent: true } }), ["E057-AGENT:fail"]);
  assertEquals(codes({ ...good, git: { ...good.git, gpgsign: "" } }), ["E057-GIT:fail"]);
  assertEquals(codes({ ...good, dailySigner: undefined }), ["E057-NOT-LISTED:fail"]);
  assertEquals(codes({ ...good, recoveryLoose: ["/h/Desktop/fleet-recovery/fleet-recovery"] }), [
    "E057-RECOVERY-LOOSE:warn",
  ]);
  assertEquals(codes({ ...good, recoveryInStore: false }), ["E057-RECOVERY-MISSING:warn"]);
  assertEquals(codes({ ...good, state: { recoveryCheckedAt: "2026-01-01T00:00:00Z" } }), [
    "E057-RECOVERY-CHECK:warn",
  ]);
  assertEquals(codes({ ...good, ssh: { found: true, version: "7.4", ok: false } }), [
    "E057-SSH:fail",
  ]);
  const bare = codes({
    ...good,
    signers: [],
    dailySigner: undefined,
    daily: { exists: false },
    hook: false,
  });
  assertEquals(bare, [
    "E057-NO-KEY:fail",
    "E057-NOT-LISTED:fail",
    "E057-NO-RECOVERY:warn",
    "E057-HOOK:warn",
  ]);
});
