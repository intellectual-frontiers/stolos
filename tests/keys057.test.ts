/**
 * Spec 057: stolos keys, end to end in a sandbox: setup (twice: idempotent),
 * the checks, the pre-push check, the recovery check, rotate, and lost. Real
 * OpenSSH keys with real passphrases, supplied through SSH_ASKPASS (tests only).
 *
 * @module
 */
import { zipEntries } from "@intellectual-frontiers/formats";
import { fs, path, proc } from "@intellectual-frontiers/system";
import {
  assertExists,
  assert,
  assertEquals,
  assertStringIncludes,
  test,
  proves,
} from "@intellectual-frontiers/test";
import {
  keyChecks,
  type KeyFacts,
  opensshOk,
  parseOpenSshVersion,
  parseSignersSource,
} from "../src/archon/identity/keys.ts";
import { allowedSignersText, checkTip, signersSource } from "../src/archon/identity/signers.ts";
import { askpassHelper, sandbox, linkEngine } from "./sandbox.ts";

const PASS = "correct horse battery staple";

const sh = async (cwd: string, env: Record<string, string>, ...a: string[]) => {
  const r = await proc.output(a, { cwd, env, stdout: "piped", stderr: "piped", stdin: "null" });
  const out = new TextDecoder().decode(r.stdout).trim();
  if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return out;
};

async function keysSandbox() {
  const sb = await sandbox("archon-keys-test-");
  const home = sb.home;
  const repo = path.join(home, "fleet");
  // A fleet repository: the example fleet, without its signers.
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await sh(".", {}, "cp", "-r", "examples/fleets/lab", path.join(repo, "fleets", "demo"));
  await linkEngine(repo);
  await fs.writeTextFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await fs.remove(path.join(repo, "fleets", "demo", "signers.ts")).catch(() => {});
  const askpass = await askpassHelper(home, PASS);
  const gitconfig = path.join(home, "gitconfig");
  await fs.writeTextFile(gitconfig, "[user]\n\tname = test\n\temail = test@example.invalid\n");
  const env: Record<string, string> = {
    ARCHON_REPO: repo,
    ARCHON_FLEET: "demo",
    ARCHON_TEST_PASSPHRASE: PASS,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: ":0",
    SSH_AUTH_SOCK: path.join(home, "no-agent"),
  };
  const gitEnv = { ...proc.env.toObject(), ...env, HOME: home };
  const git = (...a: string[]) => sh(repo, gitEnv, "git", ...a);
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "--no-gpg-sign", "-m", "demo: the fleet");
  const archon = (args: string[], stdin = "", extra: Record<string, string> = {}) =>
    sb.run("src/stolos/main.ts", [...args, "--verbose"], stdin, { ...env, ...extra });
  const script = (file: string) => sb.run(file, [], "", env);
  return { home, repo, git, archon, script, daily: path.join(home, ".ssh", "fleet-signing") };
}

const mtime = (p: string) => fs.statSync(p).mtime?.getTime();

proves(
  ["057-keys FR-002"],
  "057: setup makes and lists both keys, signs, and running it again changes nothing",
  async () => {
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
      const recovery = path.join(s.home, "config", "stolos", "keys", "fleet-recovery");
      for (const f of [s.daily, s.daily + ".pub", recovery, recovery + ".pub"]) {
        assert(fs.statSync(f).isFile, f);
      }
      const signers = parseSignersSource(
        await fs.readTextFile(path.join(s.repo, "fleets", "demo", "signers.ts")),
      );
      assertEquals(signers.map((x) => x.role).sort(), ["daily", "recovery"]);
      assertEquals(await s.git("config", "--local", "commit.gpgsign"), "true");
      assertEquals(await s.git("config", "--local", "user.signingkey"), s.daily);
      assertStringIncludes(
        await fs.readTextFile(path.join(s.repo, ".git", "hooks", "pre-push")),
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
      await fs.remove(s.home, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

proves(
  ["057-keys FR-006"],
  "057: the pre-push check refuses an unsigned tip, as servers would",
  async () => {
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

      await fs.writeTextFile(path.join(s.repo, "note.txt"), "x\n");
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
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  ["057-keys FR-004", "057-keys FR-005"],
  "057: rotate and lost replace the daily key, approved by the old key and the recovery key",
  async () => {
    const s = await keysSandbox();
    try {
      assertEquals((await s.archon(["keys", "setup"])).code, 0);
      await s.git("add", "-A");
      await s.git("commit", "-q", "-m", "demo: signers");
      const signersPath = path.join(s.repo, "fleets", "demo", "signers.ts");
      const allowedFrom = async (text: string) => {
        const f = path.join(s.home, `allowed-${crypto.randomUUID()}`);
        await fs.writeTextFile(f, allowedSignersText(parseSignersSource(text)));
        return f;
      };

      // Rotate: the commit is signed by the old key (trusted by the list servers have).
      const before = await fs.readTextFile(signersPath);
      const base = await s.git("rev-parse", "HEAD");
      let r = await s.archon(["keys", "rotate"]);
      assertEquals(r.code, 0, r.out);
      const rotated = await s.git("rev-parse", "HEAD");
      assert(rotated !== base, "a commit was made");
      let t = await checkTip(s.repo, rotated, base, await allowedFrom(before));
      assert(t.ok, t.reason);
      assert(fs.statSync(s.daily).isFile && !(await exists(s.daily + ".next")));
      r = await s.archon(["keys", "rotate"]);
      assertStringIncludes(r.out, "already rotated today");
      assertEquals(await s.git("rev-parse", "HEAD"), rotated, "running it again commits nothing");

      // Lost: the daily key is gone; the recovery key approves its replacement.
      const listed = await fs.readTextFile(signersPath);
      for (const ext of ["", ".pub"]) await fs.remove(s.daily + ext);
      r = await s.archon(["keys"]);
      assertStringIncludes(r.out, "E057-NO-KEY");
      const recovery = path.join(s.home, "config", "stolos", "keys", "fleet-recovery");
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
      await fs.remove(s.home, { recursive: true });
    }
  },
);

async function exists(p: string) {
  return await fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

test("057: rotate-recovery: a new recovery key, tested, approved by the old one, in the key store; again does nothing", async () => {
  const s = await keysSandbox();
  try {
    assertEquals((await s.archon(["keys", "setup"])).code, 0);
    await s.git("add", "-A");
    await s.git("commit", "-q", "-m", "demo: signers");
    const signersPath = path.join(s.repo, "fleets", "demo", "signers.ts");
    const before = await fs.readTextFile(signersPath);
    const base = await s.git("rev-parse", "HEAD");
    const stored = path.join(s.home, "config", "stolos", "keys", "fleet-recovery");
    const oldPub = (await fs.readTextFile(stored + ".pub")).trim().split(" ").slice(0, 2).join(" ");

    // No arguments: the old key is the one in the key store.
    let r = await s.archon(["keys", "rotate-recovery"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "NEW recovery key's passphrase");
    const head = await s.git("rev-parse", "HEAD");
    assert(head !== base, "a commit was made");
    // Approved by the OLD recovery key, as servers holding the old list check it.
    const allowed = path.join(s.home, "allowed-before");
    await fs.writeTextFile(allowed, allowedSignersText(parseSignersSource(before)));
    const t = await checkTip(s.repo, head, base, allowed);
    assert(t.ok, t.reason);
    assertStringIncludes(t.signer ?? "", "recovery");
    const rec = parseSignersSource(await fs.readTextFile(signersPath)).filter(
      (x) => x.role === "recovery",
    );
    assertEquals(rec.length, 1);
    assert(rec[0]?.key !== oldPub, "the old recovery key is no longer listed");
    // The key store holds the new key; the old one is kept, retired.
    const storedNow = (await fs.readTextFile(stored + ".pub"))
      .trim()
      .split(" ")
      .slice(0, 2)
      .join(" ");
    assertEquals(storedNow, rec[0]?.key);
    const retired = [...fs.readDirSync(path.join(s.home, "config", "stolos", "keys"))]
      .map((e) => e.name)
      .filter((n) => n.startsWith("fleet-recovery.retired-"));
    assertEquals(retired.length, 2, "the old pair, retired");

    // Again: nothing to do.
    r = await s.archon(["keys", "rotate-recovery"]);
    assertStringIncludes(r.out, "already changed today");
    assertEquals(await s.git("rev-parse", "HEAD"), head, "no new commit");
  } finally {
    await fs.remove(s.home, { recursive: true });
  }
});

test("057: one backup holds everything: both keys; a loose recovery folder moves into the key store", async () => {
  const s = await keysSandbox();
  try {
    assertEquals((await s.archon(["keys", "setup"])).code, 0);
    const store = path.join(s.home, "config", "stolos", "keys");
    // As an earlier version left it: the recovery key in a loose folder in the home folder.
    const loose = path.join(s.home, "fleet-recovery");
    await fs.mkdir(loose, { recursive: true });
    for (const f of ["fleet-recovery", "fleet-recovery.pub"]) {
      await fs.rename(path.join(store, f), path.join(loose, f));
    }
    let r = await s.archon(["keys"]);
    assertStringIncludes(r.out, "E057-RECOVERY-LOOSE");

    r = await s.archon(["vault", "backup"]);
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "both signing keys");
    const dir = path.join(s.home, "data", "stolos", "backup");
    const zip = [...fs.readDirSync(dir)].map((e) => e.name).find((n) => n.endsWith(".zip"));
    assertExists(zip);
    // The names of a ZIP's entries (kernel archives).
    const names = (file: string): string[] => {
      const e = zipEntries(fs.readFileSync(path.join(dir, file)));
      assert(e.kind === "ok", file);
      return e.value.map((x) => x.name);
    };
    const files = names(zip);
    for (const n of [
      "signing/fleet-signing",
      "signing/fleet-signing.pub",
      "signing/recovery/fleet-recovery",
      "signing/recovery/fleet-recovery.pub",
    ])
      assert(files.includes(n), `${n} in ${files.join(", ")}`);
    // Backed up: moved into the key store, the loose folder gone; the checks are quiet about it.
    assert(await exists(path.join(store, "fleet-recovery")), "in the key store");
    assert(!(await exists(loose)), "the loose folder is gone");
    r = await s.archon(["keys"]);
    assert(!/E057-RECOVERY-(LOOSE|MISSING)/.test(r.out), r.out);
    // The next backup holds it too.
    await new Promise((x) => setTimeout(x, 1100));
    r = await s.archon(["vault", "backup"]);
    const zips = [...fs.readDirSync(dir)]
      .map((e) => e.name)
      .filter((n) => n.endsWith(".zip"))
      .sort();
    const again = names(zips.at(-1) ?? "");
    assert(
      again.includes("signing/recovery/fleet-recovery"),
      "every backup holds the recovery key",
    );
  } finally {
    await fs.remove(s.home, { recursive: true });
  }
});

proves(
  ["061-vault-restore FR-001", "061-vault-restore FR-003", "061-vault-restore FR-006"],
  "061: a fresh PC from one backup ZIP: vault restore puts back both keys and signs",
  async () => {
    const s = await keysSandbox();
    try {
      assertEquals((await s.archon(["keys", "setup"])).code, 0);
      await s.git("add", "-A");
      await s.git("commit", "-q", "-m", "demo: signers");
      let r = await s.archon(["vault", "backup"]);
      assertEquals(r.code, 0, r.out);
      const dir = path.join(s.home, "data", "stolos", "backup");
      const name = [...fs.readDirSync(dir)].map((e) => e.name).find((n) => n.endsWith(".zip"));
      assertExists(name);
      const zip = path.join(s.home, name);
      await fs.rename(path.join(dir, name), zip);
      const pub = await fs.readTextFile(s.daily + ".pub");

      // The disaster: this PC's stolos folders and keys are gone; a fresh clone.
      for (const d of ["config", "data", ".ssh"]) {
        await fs.remove(path.join(s.home, d), { recursive: true });
      }
      await fs.mkdir(path.join(s.home, "config"));
      await fs.mkdir(path.join(s.home, "data"));
      const fresh = path.join(s.home, "fresh");
      await s.git("clone", "-q", s.repo, fresh);
      const there = { ARCHON_REPO: fresh };

      r = await s.archon(["vault", "restore", zip], "", there);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "put back");
      assertStringIncludes(r.out, "Signers          fleets/demo/signers.ts: 2 signer(s)");
      assertStringIncludes(r.out, "signed and verified");
      assert(!r.out.includes("back up:"), "nothing new to back up");
      assertEquals(await fs.readTextFile(s.daily + ".pub"), pub);
      assert(await exists(path.join(s.home, "config", "stolos", "keys", "fleet-recovery")));
      r = await s.archon(["keys"], "", there);
      assertEquals(r.code, 0, r.out);
      assert(!/E057-RECOVERY-(LOOSE|MISSING)/.test(r.out), r.out);

      // Again: nothing changes, nothing asked.
      r = await s.archon(["vault", "restore", zip], "", there);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "already here");
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  ["063-runnable-before-arm FR-001", "063-runnable-before-arm FR-002"],
  "063: boot arm refuses until GitHub's tip is signed by a fleet signer and holds the host",
  async () => {
    const s = await keysSandbox();
    try {
      // The example fleet, copied as demo: its id too.
      const ft = path.join(s.repo, "fleets", "demo", "fleet.ts");
      await fs.writeTextFile(ft, (await fs.readTextFile(ft)).replace('id: "lab"', 'id: "demo"'));
      assertEquals((await s.archon(["keys", "setup"])).code, 0);
      await s.git("add", "-A");
      await s.git("commit", "-q", "-m", "demo: signers");
      // GitHub, as a bare repository: origin.
      const bare = path.join(s.home, "github.git");
      await s.git("init", "-q", "--bare", bare);
      await s.git("remote", "add", "origin", bare);
      await s.git("push", "-q", "--no-verify", "origin", "main");

      // Someone pushed a commit not signed by a fleet signer on top.
      await fs.writeTextFile(path.join(s.repo, "README.md"), "edited elsewhere\n");
      await s.git("add", "-A");
      await s.git("commit", "-q", "--no-gpg-sign", "-m", "an unsigned edit");
      await s.git("push", "-q", "--no-verify", "origin", "main");
      let r = await s.archon(["boot", "arm", "alpha", "--claim"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "E063-TIP-UNSIGNED");
      assertStringIncludes(r.out, "alpha is not armed");

      // Fixed by one signed commit on top; but beta's model is only on this PC.
      const beta = "fleets/demo/hosts/beta";
      await s.git("rm", "-q", "-r", beta);
      await s.git("commit", "-q", "-m", "demo: beta, not on GitHub");
      await s.git("push", "-q", "--no-verify", "origin", "main");
      await s.git("checkout", "HEAD~1", "--", beta);
      r = await s.archon(["boot", "arm", "beta", "--claim"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "E063-HOST-NOT-PUSHED");
      assert(!r.out.includes("E063-TIP-UNSIGNED"), "the tip is signed now");

      // Both in order: armed.
      await s.git("add", "-A");
      await s.git("commit", "-q", "-m", "004-install: add host beta");
      await s.git("push", "-q", "--no-verify", "origin", "main");
      r = await s.archon(["boot", "arm", "beta", "--claim"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "beta is armed for one install");

      // Spec 063 FR-002: boot serve makes the same check for every armed host at start, as a
      // warning. Here GitHub's tip is unsigned again. The Ubuntu files' cache that comes next is a
      // file, not a folder, so the server stops right after its Fleet phase, downloading nothing.
      await fs.writeTextFile(path.join(s.repo, "README.md"), "edited elsewhere again\n");
      await s.git("add", "-A");
      await s.git("commit", "-q", "--no-gpg-sign", "-m", "another unsigned edit");
      await s.git("push", "-q", "--no-verify", "origin", "main");
      const { UBUNTU_POINT } = await import("../src/archon/install/ubuntu.ts");
      const cache = path.join(s.home, "data", "stolos", "boot");
      await fs.mkdir(cache, { recursive: true });
      await fs.writeTextFile(path.join(cache, UBUNTU_POINT), "not a folder\n");
      r = await s.archon(["boot", "serve", "--port", "0"]);
      assertEquals(r.code === 0, false, r.out);
      assert(!r.out.includes("[ok] Ubuntu files"), r.out);
      assertStringIncludes(r.out, "[warn] GitHub's main (");
      assertStringIncludes(r.out, "a server installed now would refuse to run it");
      assertStringIncludes(r.out, "[warn] Fleet            example/fleet · alpha, beta (armed)");
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

proves(
  ["057-keys FR-009"],
  "057: a fresh clone has no Git identity: keys setup takes it from GitHub (gh)",
  async () => {
    const s = await keysSandbox();
    try {
      // No identity anywhere (a new PC): the global config loses it.
      await fs.writeTextFile(path.join(s.home, "gitconfig"), "");
      let r = await s.archon(["keys"]);
      assertStringIncludes(r.out, "E057-IDENTITY");
      // The stand-in gh is a POSIX shell script, which Windows does not run as a program.
      if (proc.build.os === "windows") return;
      // gh, as GitHub answers `gh api user --jq ...` (name, login, id).
      const bin = path.join(s.home, "bin");
      await fs.mkdir(bin);
      await fs.writeTextFile(
        path.join(bin, "gh"),
        `#!/bin/sh\nprintf 'Test Person\\ttester\\t42\\n'\n`,
      );
      await fs.chmod(path.join(bin, "gh"), 0o755);
      const withGh = { PATH: `${bin}:${proc.env.get("PATH")}` };
      r = await s.archon(["keys", "setup"], "", withGh);
      assertEquals(r.code, 0, r.out);
      assertEquals(await s.git("config", "--local", "user.name"), "Test Person");
      assertEquals(
        await s.git("config", "--local", "user.email"),
        "42+tester@users.noreply.github.com",
      );
      r = await s.archon(["keys"], "", withGh);
      assert(!r.out.includes("E057-IDENTITY"), r.out);
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
);

test(
  "057: a second PC's key: setup prints the exact command that approves it",
  async () => {
    const s = await keysSandbox();
    try {
      assertEquals((await s.archon(["keys", "setup"])).code, 0);
      await s.git("add", "-A");
      await s.git("commit", "-q", "-m", "demo: signers");
      // Another PC: no daily key here yet (this one's moved aside).
      for (const ext of ["", ".pub"]) await fs.rename(s.daily + ext, `${s.daily}.first${ext}`);
      const r = await s.archon(["keys", "setup"]);
      const pub = (await fs.readTextFile(s.daily + ".pub")).trim().split(" ").slice(0, 2).join(" ");
      assertStringIncludes(r.out, "must be approved by a key already listed");
      assertStringIncludes(r.out, `--role daily --key "${pub}"`);
      assertStringIncludes(
        r.out,
        "git checkout -- fleets/demo/signers.ts && bun run stolos update",
      );
      // Running it again still shows the commands (the approval is still missing).
      const again = await s.archon(["keys", "setup"]);
      assertStringIncludes(again.out, `--key "${pub}"`);
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

test("057: the approval steps, on WSL (Windows PowerShell) and elsewhere", async () => {
  const { approvalSteps } = await import("../src/archon/identity/keys-commands.ts");
  const wsl = approvalSteps(
    "fcr",
    "fleets/fcr/signers.ts",
    "owner-pc-daily",
    "ssh-ed25519 AAAA",
    true,
  );
  assertStringIncludes(wsl[0] ?? "", "PowerShell, cd $HOME\\fleet");
  assertEquals(
    wsl[1],
    '    bun run stolos signers add owner-pc-daily --role daily --key "ssh-ed25519 AAAA"',
  );
  assertStringIncludes(wsl[2] ?? "", 'bun run stolos apply -m "fcr: signers: add owner-pc-daily"');
  const other = approvalSteps("fcr", "fleets/fcr/signers.ts", "x", "ssh-ed25519 AAAA", false);
  assertStringIncludes(other[0] ?? "", "a PC whose key is already listed");
  assertStringIncludes(other[2] ?? "", "bun run stolos apply");
});

proves(["057-keys FR-001"], "057: the checks, from facts (no files, no prompts)", () => {
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
  const [dailyDef] = list;
  assertExists(dailyDef);
  const good: KeyFacts = {
    paths,
    repo: true,
    fleetId: "demo",
    ssh: { found: true, version: "9.6", ok: true },
    daily: { exists: true, pub: "ssh-ed25519 AAAA", passphrase: true, inAgent: false },
    identity: "A Person <1+a@users.noreply.github.com>",
    git: {
      format: "ssh",
      signingKey: paths.daily,
      gpgsign: "true",
      allowedSignersFile: paths.allowedSigners,
    },
    allowedSignersCurrent: true,
    signers: list,
    dailySigner: dailyDef,
    recoveryLoose: [],
    recoveryInStore: true,
    hook: true,
    state: { recoveryCheckedAt: "2026-11-01T00:00:00Z" },
  };
  const now = Date.parse("2026-11-14T00:00:00Z");
  assertEquals(
    keyChecks(good, now).filter((c) => !c.ok),
    [],
    "all well",
  );
  const codes = (f: KeyFacts) =>
    keyChecks(f, now)
      .filter((c) => !c.ok)
      .map((c) => `${c.code}:${c.level}`);
  assertEquals(codes({ ...good, daily: { ...good.daily, passphrase: false } }), [
    "E057-NO-PASSPHRASE:fail",
  ]);
  assertEquals(codes({ ...good, daily: { ...good.daily, inAgent: true } }), ["E057-AGENT:fail"]);
  assertEquals(codes({ ...good, git: { ...good.git, gpgsign: "" } }), ["E057-GIT:fail"]);
  const { dailySigner: _listed, ...unlisted } = good;
  assertEquals(codes(unlisted), ["E057-NOT-LISTED:fail"]);
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
    ...unlisted,
    signers: [],
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

proves(
  ["057-keys FR-003", "057-keys FR-008"],
  "057: check-recovery records the date; after six months keys, boot doctor, and a weekly email remind",
  async () => {
    const s = await keysSandbox();
    try {
      const ft = path.join(s.repo, "fleets", "demo", "fleet.ts");
      await fs.writeTextFile(ft, (await fs.readTextFile(ft)).replace('id: "lab"', 'id: "demo"'));
      assertEquals((await s.archon(["keys", "setup"])).code, 0);
      const state = path.join(s.home, "data", "stolos", "keys", "state.json");
      const recovery = path.join(s.home, "config", "stolos", "keys", "fleet-recovery");
      // Last checked over six months ago: every place says so.
      await fs.writeTextFile(state, JSON.stringify({ recoveryCheckedAt: "2025-01-01T00:00:00Z" }));
      let r = await s.archon(["keys"]);
      assertStringIncludes(r.out, "E057-RECOVERY-CHECK");
      assertStringIncludes(r.out, "last checked on 2025-01-01 (over six months ago)");
      assertStringIncludes(r.out, "bun run stolos keys check-recovery");
      r = await s.archon(["boot", "doctor"]);
      assertStringIncludes(r.out, "E057-RECOVERY-CHECK");
      // FR-008: signers shows the same checks; the backup's restore steps use these commands.
      r = await s.archon(["signers"]);
      assertStringIncludes(r.out, "[E057-RECOVERY-CHECK]");
      const { restoreText } = await import("../src/archon/vault/zip.ts");
      assertStringIncludes(restoreText(), "bun run stolos keys setup");
      // The weekly email, through the mailbox (a relay that does not answer keeps it in the spool).
      const secrets = path.join(s.home, "config", "stolos", "secrets", "demo");
      await fs.mkdir(secrets, { recursive: true });
      await fs.writeTextFile(
        path.join(secrets, "mail.json"),
        JSON.stringify({ token: "cfat_test", created: "2026-11-01T00:00:00Z" }),
      );
      const src = (rel: string) => JSON.stringify(new URL(`../src/${rel}`, import.meta.url).href);
      const script = path.join(s.home, "remind.ts");
      await fs.writeTextFile(
        script,
        `import { sendDeps } from ${src("archon/notify/notify.ts")};
import { remind } from ${src("archon/vault/reminder.ts")};
sendDeps.smtp = () => Promise.reject(new Error("no relay in tests"));
await remind();
`,
      );
      const spool = path.join(s.home, "data", "stolos", "notify");
      const reminders = async (): Promise<number> => {
        let n = 0;
        // The queued messages (status.json, beside them, names the last one sent).
        for await (const e of fs.readDir(spool)) {
          if (!/^\d+-[0-9a-f]+\.json$/.test(e.name)) continue;
          const t = await fs.readTextFile(path.join(spool, e.name));
          if (t.includes("check the fleet's recovery key")) n++;
        }
        return n;
      };
      assertEquals((await s.script(script)).code, 0);
      assertEquals(await reminders(), 1, "one email");
      assertEquals((await s.script(script)).code, 0);
      assertEquals(await reminders(), 1, "not again within the week");
      // Checked now: the date is recorded, and the reminders stop.
      r = await s.archon(["keys", "check-recovery", "--key", recovery]);
      assertEquals(r.code, 0, r.out);
      const st: unknown = JSON.parse(await fs.readTextFile(state));
      const at = (st as { recoveryCheckedAt?: string }).recoveryCheckedAt ?? "";
      assertEquals(at.slice(0, 10), new Date().toISOString().slice(0, 10));
      r = await s.archon(["keys"]);
      assert(!r.out.includes("over six months ago"), r.out);
      r = await s.archon(["boot", "doctor"]);
      assert(!r.out.includes("E057-RECOVERY-CHECK"), r.out);
      // Where am I: a check that stops signing is its next step, with that check's fix.
      for (const ext of ["", ".pub"]) await fs.rename(s.daily + ext, `${s.daily}.away${ext}`);
      r = await s.archon(["--json"]);
      const where: unknown = JSON.parse(r.out.slice(r.out.indexOf("{")));
      const problems = (where as { facts: { signingProblems: Array<{ fix: string }> } }).facts
        .signingProblems;
      assert(
        problems.some((p) => p.fix.includes("bun run stolos keys setup")),
        r.out,
      );
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

proves(
  ["057-keys FR-007"],
  "057: passphrases go to OpenSSH only: never stored or printed, no ssh-agent, no keys command over MCP",
  async () => {
    const s = await keysSandbox();
    try {
      const r = await s.archon(["keys", "setup"]);
      assertEquals(r.code, 0, r.out);
      assert(!r.out.includes(PASS), "never printed");
      // Nothing archon wrote holds it (the stand-in for a person typing it is the one file that does).
      const askpass = path.join(s.home, proc.build.os === "windows" ? "askpass.cmd" : "askpass.sh");
      const hits: string[] = [];
      for (const f of await fs.walkFiles(s.home)) {
        const p = path.join(s.home, f);
        if (p === askpass || f.includes("node_modules")) continue;
        const bytes = await fs.readFile(p).catch(() => new Uint8Array());
        if (new TextDecoder().decode(bytes).includes(PASS)) hits.push(f);
      }
      assertEquals(hits, [], "never stored");
      // The keys are locked: OpenSSH refuses them without the passphrase.
      const locked = await proc.output(["ssh-keygen", "-y", "-P", "", "-f", s.daily], {
        stdout: "null",
        stderr: "null",
        stdin: "null",
      });
      assert(!locked.success, "the daily key needs its passphrase");
    } finally {
      await fs.remove(s.home, { recursive: true });
    }
    // Never loaded into an ssh-agent: the engine only lists the agent's keys (ssh-add -L).
    const root = path.fromFileUrl(new URL("../src/", import.meta.url));
    for (const f of await fs.walkFiles(root)) {
      if (!f.endsWith(".ts") || f.endsWith(".auto.ts")) continue;
      const t = await fs.readTextFile(path.join(root, f));
      for (const m of t.matchAll(/\["ssh-add"((?:, "[^"]*")*)\]/g)) {
        assertEquals(m[1], ', "-L"', `${f} runs ssh-add${m[1] ?? ""}`);
      }
    }
    // No keys command is offered over MCP.
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    const { listed } = await import("../src/archon/mcp/server.ts");
    const keys = COMMANDS.filter((c) => c.name === "keys" || c.name.startsWith("keys "));
    assert(keys.length >= 5, keys.map((c) => c.name).join(", "));
    for (const c of keys) assert(!listed(c, "mutate"), `${c.name} is offered over MCP`);
  },
);
