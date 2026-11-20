/**
 * Spec 099: updating the engine is one command or one button; both consoles show the engine; a
 * passphrase is asked on the page that ran the command (with a warning on HTTP).
 *
 * @module
 */
import { fs, path, proc, serve } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { isNewer, newestRelease, newestTag } from "../src/archon/fleet/releases.ts";
import { page } from "../src/archon/console/layout.ts";
import { html } from "../src/archon/console/html.ts";
import { stolosOverview } from "../src/archon/console/stolos-pages.ts";
import { Askpass, askpassEnv } from "../src/archon/console/askpass.ts";
import { askpassForm } from "../src/archon/console/stolos-server.ts";
import { FACTS, fakeConsole } from "./console/serve-stolos.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

proves(
  ["099-engine-update FR-002"],
  "099: the newest release, newer or not, and the cache (no network when fresh)",
  async () => {
    assertEquals(
      newestTag(
        "a\trefs/tags/stolos-v0.9.0\nb\trefs/tags/stolos-v0.126.0\nc\trefs/tags/stolos-v0.99.1",
      ),
      "stolos-v0.126.0",
    );
    assert(
      isNewer("stolos-v0.126.0", "stolos-v0.124.0") && !isNewer("stolos-v0.126.0", "0.124.0"),
      "a bare version is not a tag",
    );
    assert(!isNewer("stolos-v0.124.0", "stolos-v0.124.0") && !isNewer(undefined, "stolos-v1.0.0"));
    const dir = await fs.makeTempDir();
    const cacheFile = path.join(dir, "newest.json");
    const now = 1_000_000;
    await fs.writeTextFile(
      cacheFile,
      JSON.stringify({ repo: "example/none", tag: "stolos-v9.9.9", at: now }),
    );
    // Fresh: from the cache (example/none does not exist, so a lookup would find nothing).
    assertEquals(
      await newestRelease("example/none", { cacheFile, now: now + 1000 }),
      "stolos-v9.9.9",
    );
    await fs.remove(dir, { recursive: true });
  },
);

const frame = (engine?: { running: string; newer?: string; href: string }) =>
  page(
    {
      product: "stolos",
      title: "Overview",
      subtitle: "this PC · alice",
      fleet: { id: "lab", repo: "example/fleet" },
      user: { name: "Alice", user: "alice", role: "fleet operator" },
      nav: [],
      current: "/",
      ...(engine ? { engine } : {}),
    },
    html`<p>body</p>`,
  );

proves(
  ["099-engine-update FR-002", "099-engine-update FR-003"],
  "099: the header shows the engine; a newer release is a link to update; Overview offers it",
  () => {
    const now = frame({ running: "stolos-v0.126.0", href: "/actions/fleet?cmd=update" });
    assertStringIncludes(now, "stolos-v0.126.0");
    assert(!now.includes("is out"), "no newer release: no link");
    const old = frame({
      running: "stolos-v0.124.0",
      newer: "stolos-v0.126.0",
      href: "/actions/fleet?cmd=update",
    });
    assertStringIncludes(old, 'href="/actions/fleet?cmd=update"');
    assertStringIncludes(old, "stolos-v0.126.0 is out · Update");
    const o = String(
      stolosOverview(structuredClone(FACTS), Date.now(), {
        running: "stolos-v0.124.0",
        newer: "stolos-v0.126.0",
      }),
    );
    assertStringIncludes(o, "Update to stolos-v0.126.0");
    assertStringIncludes(o, "Your passphrase is asked");
    assert(!String(stolosOverview(structuredClone(FACTS))).includes("is out"));
  },
);

proves(
  ["099-engine-update FR-003"],
  "099: the Archon Console's Engine card explains the update and offers Update now to an operator",
  async () => {
    const { engineCard } = await import("../src/archon/console/pages.ts");
    const e = { running: "stolos-v0.124.0", newer: "stolos-v0.126.0" };
    const a = String(engineCard({ engine: "stolos-v0.124.0" }, undefined, { role: "operator" }, e));
    assertStringIncludes(a, 'id="engine"');
    assertStringIncludes(a, "stolos-v0.126.0 is out");
    assertStringIncludes(a, "bun run stolos update");
    assertStringIncludes(a, 'href="/actions/server?cmd=update"');
    const v = String(engineCard({ engine: "stolos-v0.124.0" }, undefined, { role: "viewer" }, e));
    assert(!v.includes("cmd=update"), "only an operator");
  },
);

proves(
  ["099-engine-update FR-005"],
  "099: on HTTP the passphrase field warns first, with the command for the terminal",
  () => {
    const q = { id: "abc", prompt: "Enter passphrase for /home/alice/.ssh/fleet-signing:" };
    const http = String(askpassForm(q, "bun run stolos update", true));
    assertStringIncludes(
      http,
      "⚠️ Warning, you're about to type in your passphrase on an unencrypted channel",
    );
    assertStringIncludes(http, "Only do this on a trusted network, or do this at the command line");
    assertStringIncludes(http, "<code>bun run stolos update</code>");
    assertStringIncludes(http, 'type="password"');
    assert(!String(askpassForm(q, "bun run stolos update", false)).includes("Warning"));
  },
);

proves(
  ["099-engine-update FR-005"],
  "099: OpenSSH's askpass asks the console; the browser's answer signs; a wrong token is refused",
  async () => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const B = `http://127.0.0.1:${port}`;
    const askpass = new Askpass();
    const { handler, launch } = await fakeConsole(port, { askpass });
    const server = await serve({ hostname: "127.0.0.1", port }, handler);
    const dir = await fs.makeTempDir();
    try {
      // Refused without the console's token.
      const bad = await fetch(`${B}/askpass`, {
        method: "POST",
        headers: { "x-stolos-askpass": "0".repeat(64) },
        body: "Enter passphrase:",
      });
      assertEquals(bad.status, 403);
      await bad.text();

      // A key with a passphrase, signed through the helper; the browser answers.
      const key = path.join(dir, "k");
      const kg = await proc.run([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "pass phrase",
        "-f",
        key,
      ]);
      assert(kg.code === 0, kg.stderr);
      const msg = path.join(dir, "msg");
      await fs.writeTextFile(msg, "hello\n");
      const env = await askpassEnv(path.join(dir, "helper"), B, askpass);
      const r0 = await handler(
        new Request(`${B}/launch?t=${launch.issue()}`, { headers: { host: `127.0.0.1:${port}` } }),
      );
      const cookie = (r0.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const seen: string[] = [];
      askpass.onAsk = (q) => {
        seen.push(q.prompt);
        void handler(
          new Request(`${B}/askpass/answer`, {
            method: "POST",
            headers: { host: `127.0.0.1:${port}`, cookie, origin: B, "datastar-request": "true" },
            body: new URLSearchParams({ id: q.id, passphrase: "pass phrase" }),
          }),
        ).then((r) => r.text());
      };
      const sign = await proc.run(["ssh-keygen", "-Y", "sign", "-f", key, "-n", "git", msg], {
        env: { ...env },
        input: "",
      });
      assertEquals(sign.code, 0, sign.stderr);
      assert(await fs.exists(`${msg}.sig`), "signed");
      assert(seen.length === 1 && /passphrase/i.test(seen[0] ?? ""), seen.join("; "));
      // Cancelled: OpenSSH is told no, and nothing is signed.
      await fs.remove(`${msg}.sig`);
      askpass.onAsk = (q) => void askpass.answer(q.id, undefined);
      const no = await proc.run(["ssh-keygen", "-Y", "sign", "-f", key, "-n", "git", msg], {
        env: { ...env },
        input: "",
      });
      assert(no.code !== 0 && !(await fs.exists(`${msg}.sig`)), "cancelled: not signed");
    } finally {
      askpass.onAsk = undefined;
      await server.shutdown();
      await fs.remove(dir, { recursive: true });
    }
  },
  {
    skip:
      proc.build.os === "windows" && "the Windows askpass helper is exercised by CI's console job",
  },
);

proves(
  ["099-engine-update FR-001"],
  "099: update puts your commit on top of GitHub's; a conflict is undone and named",
  async () => {
    const sb = await sandbox("archon-update099-");
    try {
      const gitconfig = path.join(sb.home, "gitconfig");
      await fs.writeTextFile(gitconfig, "[user]\n\tname = t\n\temail = t@example.invalid\n");
      const env = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", HOME: sb.home };
      const sh = async (cwd: string, ...a: string[]): Promise<string> => {
        const r = await proc.output(a, { cwd, env: { ...proc.env.toObject(), ...env } });
        if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
        return new TextDecoder().decode(r.stdout).trim();
      };
      const origin = path.join(sb.home, "origin.git");
      const mine = path.join(sb.home, "fleet");
      const theirs = path.join(sb.home, "theirs");
      await sh(sb.home, "git", "init", "-q", "--bare", "-b", "main", origin);
      await sh(sb.home, "git", "clone", "-q", origin, theirs);
      await fs.mkdir(path.join(theirs, "fleets"), { recursive: true });
      await sh(".", "cp", "-r", "examples/fleets/lab", path.join(theirs, "fleets", "lab"));
      await fs.writeTextFile(path.join(theirs, ".gitignore"), "node_modules/\n");
      await sh(theirs, "git", "add", "-A");
      await sh(theirs, "git", "commit", "-q", "--no-gpg-sign", "-m", "lab: the fleet");
      await sh(theirs, "git", "push", "-q", "origin", "main");
      await sh(sb.home, "git", "clone", "-q", origin, mine);
      await linkEngine(mine);
      const stolos = (args: string[]): ReturnType<typeof sb.run> =>
        sb.run("src/stolos/main.ts", args, "", { ...env, ARCHON_REPO: mine, ARCHON_FLEET: "lab" });

      // Theirs and mine, on different files: mine goes on top.
      await fs.writeTextFile(path.join(theirs, "theirs.txt"), "t\n");
      await sh(theirs, "git", "add", "-A");
      await sh(theirs, "git", "commit", "-q", "--no-gpg-sign", "-m", "theirs");
      await sh(theirs, "git", "push", "-q", "origin", "main");
      await fs.writeTextFile(path.join(mine, "mine.txt"), "m\n");
      await sh(mine, "git", "add", "mine.txt");
      await sh(mine, "git", "commit", "-q", "--no-gpg-sign", "-m", "mine");
      let r = await stolos(["update", "--no-upgrade", "--no-doctor", "--verbose"]);
      assertStringIncludes(r.out, "your 1 commit(s) on top");
      assertEquals(await sh(mine, "git", "log", "-2", "--format=%s"), "mine\ntheirs");

      // The same file, two ways: undone, named, nothing lost.
      await fs.writeTextFile(path.join(theirs, "mine.txt"), "theirs\n");
      await sh(theirs, "git", "pull", "-q", "--no-rebase", "--no-edit");
      await sh(theirs, "git", "add", "-A");
      await sh(theirs, "git", "commit", "-q", "--no-gpg-sign", "-m", "theirs again");
      await sh(theirs, "git", "push", "-q", "origin", "main");
      const before = await sh(mine, "git", "rev-parse", "HEAD");
      r = await stolos(["update", "--no-upgrade", "--no-doctor"]);
      assertStringIncludes(r.out, "change the same lines");
      assertEquals(await sh(mine, "git", "rev-parse", "HEAD"), before);
      assertEquals(await fs.readTextFile(path.join(mine, "mine.txt")), "m\n");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "cp -r and the shell fixtures are POSIX" },
);

proves(
  ["099-engine-update FR-001", "099-engine-update FR-004"],
  "099: update sends the upgrade itself; no message tells anyone to run git push",
  async () => {
    const root = path.fromFileUrl(new URL("../src/", import.meta.url));
    const op = await fs.readTextFile(path.join(root, "archon/update/operator.ts"));
    const upgrade = op.indexOf('stolos(["fleet", "upgrade", upgradeTo]');
    const apply = op.indexOf('stolos(["apply"]', upgrade);
    assert(upgrade > 0 && apply > upgrade, "fleet upgrade, then stolos apply");
    // Every fix and next step the engine prints says stolos apply, never git push.
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for await (const e of fs.readDir(dir)) {
        const f = path.join(dir, e.name);
        if (e.isDirectory) await walk(f);
        else if (f.endsWith(".ts") && !f.endsWith(".auto.ts")) {
          for (const l of (await fs.readTextFile(f)).split("\n")) {
            // Advice starts with the command; an error's label ("git push: ...") does not count.
            if (/["`']\s*(then |push it: |and )?git push\b(?!:| failed| --no-verify)/.test(l)) {
              offenders.push(`${f}: ${l.trim()}`);
            }
          }
        }
      }
    };
    await walk(root);
    assertEquals(offenders, []);
  },
);

proves(
  ["099-engine-update FR-006"],
  "099: records Stolos wrote are told from your own edits, and named for what they are",
  async () => {
    const { porcelainPath, recordOf, splitChanges } =
      await import("../src/archon/fleet/records.ts");
    assertEquals(
      porcelainPath(" M fleets/lab/hosts/alpha/registration.ts"),
      "fleets/lab/hosts/alpha/registration.ts",
    );
    assertEquals(porcelainPath("R  a.ts -> fleets/lab/discovered.ts"), "fleets/lab/discovered.ts");
    assertEquals(
      recordOf("fleets/lab/hosts/alpha/registration.ts"),
      "alpha's registration (from its install)",
    );
    assertEquals(
      recordOf("fleets/lab/adopted/bob-desk/observed.ts"),
      "bob-desk, adopted (what it reported)",
    );
    assertEquals(recordOf("fleets/lab/hosts/alpha/host.ts"), undefined, "a host's model is yours");
    const s = splitChanges(["fleets/lab/hosts/alpha/registration.ts", "fleets/lab/fleet.ts"]);
    assertEquals([s.records.length, s.yours], [1, ["fleets/lab/fleet.ts"]]);
  },
);

proves(
  ["099-engine-update FR-006"],
  "099: update sends an install's registration by itself; the doctor calls it not sent yet",
  async () => {
    const sb = await sandbox("archon-update099-rec-");
    try {
      const gitconfig = path.join(sb.home, "gitconfig");
      await fs.writeTextFile(gitconfig, "[user]\n\tname = t\n\temail = t@example.invalid\n");
      const env = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", HOME: sb.home };
      const sh = async (cwd: string, ...a: string[]): Promise<string> => {
        const r = await proc.output(a, { cwd, env: { ...proc.env.toObject(), ...env } });
        if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
        return new TextDecoder().decode(r.stdout).trim();
      };
      const origin = path.join(sb.home, "origin.git");
      const mine = path.join(sb.home, "fleet");
      await sh(sb.home, "git", "init", "-q", "--bare", "-b", "main", origin);
      await sh(sb.home, "git", "clone", "-q", origin, mine);
      await fs.mkdir(path.join(mine, "fleets"), { recursive: true });
      await sh(".", "cp", "-r", "examples/fleets/lab", path.join(mine, "fleets", "lab"));
      await fs.writeTextFile(path.join(mine, ".gitignore"), "node_modules/\n");
      // The checkout's own entry file: what update runs for its steps (spec 105-calm-output FR-005).
      await fs.writeTextFile(
        path.join(mine, "stolos.ts"),
        `import { run } from ${JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, "src/stolos/main.ts")).href)};\nawait run();\n`,
      );
      await sh(mine, "git", "add", "-A");
      await sh(mine, "git", "commit", "-q", "--no-gpg-sign", "-m", "lab");
      await sh(mine, "git", "push", "-q", "origin", "main");
      await linkEngine(mine);
      const reg = path.join(mine, "fleets", "lab", "hosts", "alpha", "registration.ts");
      await fs.writeTextFile(reg, `${(await fs.readTextOr(reg)) ?? ""}// learned at install\n`);
      const r = await sb.run("src/stolos/main.ts", ["update", "--no-doctor"], "", {
        ...env,
        ARCHON_REPO: mine,
        ARCHON_FLEET: "lab",
      });
      // It is handed to `stolos apply` without asking (this checkout has no signing key, so apply says
      // why it cannot sign), and is never offered as your own change.
      assert(!/Send your|of yours/.test(r.out), r.out);
      assertStringIncludes(r.out, "E057-NO-KEY");
      assert(!/push or commit your own changes/.test(r.out), r.out);
      const d = await sb.run("src/stolos/main.ts", ["boot", "doctor"], "", {
        ...env,
        ARCHON_REPO: mine,
        ARCHON_FLEET: "lab",
      });
      if ((await sh(mine, "git", "status", "--porcelain")).includes("registration.ts")) {
        assertStringIncludes(d.out, "Not sent yet: alpha's registration (from its install)");
      }
      assert(!/change\(s\) not committed/.test(d.out), d.out);
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "cp -r and the shell fixtures are POSIX" },
);

proves(
  ["099-engine-update FR-007"],
  "099: ⚡ is your move: commons' mark, its own section, never a warning, and the run still succeeds",
  async () => {
    const { Ui } = await import("../src/archon/core/ui.ts");
    const palette = await import("@intellectual-frontiers/terminal/palette");
    const run = (emoji: boolean) => {
      let text = "";
      const ui = new Ui({
        tty: false,
        color: false,
        emoji,
        now: () => 0,
        write: (s) => (text += s),
      });
      const p = ui.phase("Checkout");
      p.action("not sent yet: olympia's registration (from its install)", "bun run stolos update");
      p.pending("a certificate is not issued yet", "it is issued at the next apply");
      p.done();
      const code = ui.finish();
      return { text, code };
    };
    const e = run(true);
    assertEquals(e.code, 0, "an action is not a failure");
    assertStringIncludes(e.text, `${palette.MARKS.action.emoji} not sent yet`);
    // Spec 105-calm-output FR-006: your move first, then what waits, then the verdict; the phase
    // that holds a ⚡ is not green; nothing is wrong, so nothing is a problem.
    assertStringIncludes(e.text, `${palette.MARKS.action.emoji} Checkout`);
    assertStringIncludes(e.text, "run: bun run stolos update");
    assert(!e.text.includes("Needs attention"), "nothing is wrong");
    assert(
      e.text.lastIndexOf("not sent yet") < e.text.lastIndexOf("a certificate is not issued yet"),
      "Your move comes before what waits",
    );
    const a = run(false);
    assertStringIncludes(a.text, `${palette.MARKS.action.ascii} not sent yet`);
    const { lineClass } = await import("../src/archon/console/server.ts");
    assertEquals(lineClass("   [you] not sent yet"), "act");
  },
);

proves(
  ["099-engine-update FR-008"],
  "099: the impact's scratch copy is inside .git, and no link is made: node_modules is found above",
  async () => {
    const { extractFleets } = await import("../src/archon/compliance/impact.ts");
    const repo = await fs.makeTempDir({ prefix: "stolos-impact-test-" });
    try {
      const git = (...a: string[]) =>
        proc.run([
          "git",
          "-C",
          repo,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          ...a,
        ]);
      await git("init", "-q", "-b", "main");
      await fs.mkdir(path.join(repo, "fleets", "lab"), { recursive: true });
      await fs.writeTextFile(path.join(repo, "fleets", "lab", "fleet.ts"), "export const x = 1;\n");
      await fs.mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
      await git("add", "fleets");
      await git("commit", "-q", "--no-gpg-sign", "-m", "lab");
      const tree = await extractFleets(repo, "HEAD");
      // Windows: drive letters and separators may be spelled differently; Git may check out CRLF.
      const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const gitDir = norm(await fs.realPath(path.join(repo, ".git")));
      assert(norm(await fs.realPath(tree)).startsWith(`${gitDir}/`), `${tree} is inside .git`);
      assertEquals(
        (await fs.readTextFile(path.join(tree, "fleets", "lab", "fleet.ts"))).replace(
          /\r\n/g,
          "\n",
        ),
        "export const x = 1;\n",
      );
      assert(
        !(await fs.exists(path.join(tree, "node_modules"))),
        "no link: Bun and Node look above",
      );
    } finally {
      await fs.remove(repo, { recursive: true });
    }
  },
);
