/**
 * Spec 106-one-passphrase-speed: one passphrase per command. The session's memory, retry and wipe
 * as units; the broker and the helper over loopback with a token; a real `ssh-keygen` asking
 * through the helper; and the real `stolos update`, in a sandbox fleet with real Git and OpenSSH,
 * which signs two commits, starts a child run, and asks a counting askpass once.
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
import { COMMANDS } from "../src/archon/commands/registry.ts";
import {
  collectSecret,
  ENV_HELPER,
  ENV_TOKEN,
  ENV_URL,
  askThePerson,
  PassphraseSession,
  passphrasesFor,
  PerSigningSession,
  TOKEN_HEADER,
} from "../src/archon/core/passphrase.ts";
import { SIGNING_OUTCOMES } from "../src/archon/ontology.auto.ts";
import { discoveredSource } from "../src/archon/adopt/integrate.ts";
import { VERSION } from "../src/archon/version.ts";
import { runtimeCommand } from "../src/archon/install/bun.ts";
import { ENGINE_ROOT } from "./sandbox.ts";
import { countingAskpass, engineRepo, fleet, PASS } from "./lab-fleet.ts";

/** Why the broker's end-to-end tests do not run on Windows (spec 106-one-passphrase-speed tasks). */
const NO_BROKER_ON_WINDOWS =
  "Windows keeps spec 105's one askpass per signing until the broker has had a real Windows test";

const te = new TextEncoder();
const td = new TextDecoder();

/** A session whose person answers from a script, and counts how often they were asked. */
function scripted(answers: string[]): { session: PassphraseSession; asked: string[] } {
  const asked: string[] = [];
  const session = new PassphraseSession({
    ask: (prompt) => {
      asked.push(prompt);
      const a = answers.shift();
      return Promise.resolve(a === undefined ? undefined : te.encode(a));
    },
  });
  return { session, asked };
}

proves(
  ["106-one-passphrase-speed FR-004"],
  "106: the terminal's prompt reads bytes with no echo: Enter ends it, Backspace and Ctrl+U edit it, Ctrl+C and Ctrl+D cancel",
  async () => {
    const feed = (s: number[]): (() => Promise<number | null>) => {
      const q = [...s];
      return () => Promise.resolve(q.length ? (q.shift() ?? null) : null);
    };
    const bytes = (s: string): number[] => [...te.encode(s)];
    const got = await collectSecret(feed([...bytes("hunter2"), 0x0d]));
    assertEquals(got && td.decode(got), "hunter2");
    // Backspace takes one character back, a multi-byte one whole; Ctrl+U everything.
    const edited = await collectSecret(feed([...bytes("abx"), 0x7f, ...bytes("cé"), 0x08, 0x0a]));
    assertEquals(edited && td.decode(edited), "abc");
    const cleared = await collectSecret(feed([...bytes("wrong"), 0x15, ...bytes("right"), 0x0a]));
    assertEquals(cleared && td.decode(cleared), "right");
    // An empty line is an empty answer (an unencrypted key's), Ctrl+C and Ctrl+D cancel, the end of the input too.
    assertEquals((await collectSecret(feed([0x0d])))?.length, 0);
    assertEquals(await collectSecret(feed([...bytes("abc"), 0x03])), undefined);
    assertEquals(await collectSecret(feed([0x04])), undefined);
    assertEquals(await collectSecret(feed([])), undefined);
  },
);

proves(
  [
    "106-one-passphrase-speed FR-001",
    "106-one-passphrase-speed FR-002",
    "106-one-passphrase-speed FR-003",
  ],
  "106: the session asks once per key, keeps a passphrase only after it unlocked, replaces it only after a new one unlocks, and wipes",
  async () => {
    // Once: two signings, one question.
    const { session, asked } = scripted(["first", "second", "third", "fourth"]);
    const one = await session.answer("Enter passphrase:", "/home/alice/.ssh/fleet-signing");
    assertEquals(one && td.decode(one), "first");
    await session.settle("unlocked");
    const again = await session.answer("Enter passphrase:", "/home/alice/.ssh/fleet-signing");
    assertEquals(again && td.decode(again), "first");
    await session.settle("unlocked");
    assertEquals(session.asks, 1);
    assertEquals(asked.length, 1);
    assertStringIncludes(asked[0] ?? "", `"/home/alice/.ssh/fleet-signing"`, "the key is named");
    // Another key is another passphrase.
    const other = await session.answer("Enter passphrase:", "/home/alice/.ssh/own-key");
    assertEquals(other && td.decode(other), "second");
    assertEquals(session.asks, 2);
    await session.settle("unlocked");
    // The key refuses what was kept (it was rotated): asked again, the old one stays until a new one unlocks.
    const kept = await session.answer("Enter passphrase:", "/home/alice/.ssh/fleet-signing");
    assertEquals(kept && td.decode(kept), "first");
    await session.settle("refused");
    const retry = await session.answer("Enter passphrase:", "/home/alice/.ssh/fleet-signing");
    assertEquals(retry && td.decode(retry), "third");
    await session.settle("refused"); // wrong again: nothing is kept for it
    const retry2 = await session.answer("Enter passphrase:", "/home/alice/.ssh/fleet-signing");
    assertEquals(retry2 && td.decode(retry2), "fourth");
    assertEquals(
      kept && td.decode(kept),
      "first",
      "the old one is still held while the new ones fail",
    );
    await session.settle("unlocked");
    assertEquals(kept && [...kept].every((b) => b === 0), true, "the replaced one is zeroed");
    const now = await session.answer("Enter passphrase:", "/home/alice/.ssh/fleet-signing");
    assertEquals(now && td.decode(now), "fourth");
    await session.settle("unlocked");
    // Another failure throws away what was typed for it, keeps what was kept.
    const f = scripted(["good", "typed-for-a-failure"]);
    const g1 = await f.session.answer("Enter passphrase:", "k");
    await f.session.settle("unlocked");
    assertEquals(g1 && td.decode(g1), "good");
    await f.session.settle("failed");
    assertEquals(f.session.held, 1);
    // Cancelled (nobody answered): nothing held, the signing tool is told no.
    const none = scripted([]);
    assertEquals(await none.session.answer("Enter passphrase:", "k"), undefined);
    assertEquals(none.session.held, 0);
    // The end of the command: everything is zeroed.
    const held = now;
    await session.wipe();
    assertEquals(held && [...held].every((b) => b === 0), true, "wiped");
    assertEquals(session.held, 0);
    assertEquals(SIGNING_OUTCOMES.length, 3);
  },
);

proves(
  ["106-one-passphrase-speed FR-002", "106-one-passphrase-speed FR-005"],
  "106: the broker answers only 127.0.0.1 with the run's token and only passphrase prompts; the environment holds the address and the token, never the passphrase; it stops at the end",
  async () => {
    const { session } = scripted(["s3cret-pass", "s3cret-pass"]);
    const env = await session.signingEnv("/home/alice/.ssh/fleet-signing");
    assertEquals(
      Object.keys(env).sort(),
      [
        "DISPLAY",
        ENV_HELPER,
        "SSH_ASKPASS",
        "SSH_ASKPASS_REQUIRE",
        "STOLOS_PASSPHRASE_SCOPE",
        ENV_TOKEN,
        ENV_URL,
      ].sort(),
    );
    assert(!JSON.stringify(env).includes("s3cret-pass"), "never in the environment");
    assertEquals(env["SSH_ASKPASS_REQUIRE"], "force");
    const url = env[ENV_URL] ?? "";
    assert(url.startsWith("http://127.0.0.1:"), `loopback only: ${url}`);
    const ask = (headers: Record<string, string>, body = "Enter passphrase:", method = "POST") =>
      fetch(`${url}/ask`, { method, headers, body: method === "POST" ? body : null });
    assertEquals((await ask({})).status, 403, "no token");
    assertEquals((await ask({ [TOKEN_HEADER]: "x".repeat(64) })).status, 403, "the wrong token");
    assertEquals(
      (await ask({ [TOKEN_HEADER]: env[ENV_TOKEN] ?? "" }, "Are you sure (yes/no)?")).status,
      403,
      "a question that is not a passphrase prompt is OpenSSH's own",
    );
    assertEquals((await ask({ [TOKEN_HEADER]: env[ENV_TOKEN] ?? "" }, "x", "GET")).status, 403);
    const good = await ask({ [TOKEN_HEADER]: env[ENV_TOKEN] ?? "" });
    assertEquals(good.status, 200);
    assertEquals(await good.text(), "s3cret-pass");
    const bad = await fetch(`${url}/settle`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: env[ENV_TOKEN] ?? "" },
      body: "sideways",
    });
    assertEquals(bad.status, 400);
    const ok = await fetch(`${url}/settle`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: env[ENV_TOKEN] ?? "" },
      body: "unlocked",
    });
    assertEquals(ok.status, 204);
    // The helper's folder holds a script and no secret, and is gone at the end with the broker.
    const helper = env[ENV_HELPER] ?? "";
    const script = await fs.readTextFile(helper);
    assert(!script.includes("s3cret-pass") && !script.includes(env[ENV_TOKEN] ?? "?"), script);
    await session.wipe();
    assertEquals(await fs.exists(helper), false, "the helper is removed");
    let refused = false;
    try {
      await fetch(`${url}/ask`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: env[ENV_TOKEN] ?? "" },
        body: "Enter passphrase:",
      });
    } catch {
      refused = true;
    }
    assert(refused, "nothing answers after the command ends");
  },
);

/** An encrypted key made by the real ssh-keygen, in `dir`. */
async function makeKey(dir: string): Promise<string> {
  const key = path.join(dir, "key");
  const r = await proc.run([
    "ssh-keygen",
    "-q",
    "-t",
    "ed25519",
    "-N",
    PASS,
    "-C",
    "alice@example.invalid",
    "-f",
    key,
  ]);
  assertEquals(r.code, 0, r.stderr);
  return key;
}

proves(
  [
    "106-one-passphrase-speed FR-001",
    "106-one-passphrase-speed FR-002",
    "106-one-passphrase-speed FR-003",
  ],
  "106: a real ssh-keygen asks the helper, the helper asks the session: two signatures, one question; a wrong one is asked again; the passphrase is in no argument or variable",
  async () => {
    const dir = await fs.realPath(await fs.makeTempDir({ prefix: "stolos-pass106-" }));
    try {
      const key = await makeKey(dir);
      // The person's answers: wrong, then right.
      const { session, asked } = scripted(["not it", PASS]);
      const sign = async (): Promise<{ code: number; out: string }> => {
        const env = await session.signingEnv(key);
        const all = JSON.stringify(env);
        assert(!all.includes(PASS) && !all.includes("not it"), "never in a variable");
        const r = await proc.run(["ssh-keygen", "-Y", "sign", "-f", key, "-n", "git"], {
          env,
          input: "the data",
        });
        return { code: r.code, out: r.stdout + r.stderr };
      };
      const first = await sign();
      assert(first.code !== 0, "the wrong passphrase signs nothing");
      assert(/incorrect passphrase/i.test(first.out), first.out);
      await session.settle("refused");
      const second = await sign();
      assertEquals(second.code, 0, second.out);
      assertStringIncludes(second.out, "BEGIN SSH SIGNATURE");
      await session.settle("unlocked");
      // A third and a fourth signature: nobody is asked.
      for (let i = 0; i < 2; i++) {
        const more = await sign();
        assertEquals(more.code, 0, more.out);
        await session.settle("unlocked");
      }
      assertEquals(asked.length, 2, "one wrong and one right, and no more");
      assertEquals(session.asks, 2);
      await session.wipe();
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && NO_BROKER_ON_WINDOWS },
);

proves(
  [
    "106-one-passphrase-speed FR-001",
    "106-one-passphrase-speed FR-002",
    "106-one-passphrase-speed FR-003",
    "106-one-passphrase-speed FR-004",
    "106-one-passphrase-speed FR-006",
  ],
  "106: update that signs a record, then upgrades the engine in a child run, asks the askpass once; a wrong passphrase is asked again and the next signing still asks nobody; nothing keeps the passphrase",
  async () => {
    const f = await fleet();
    const { sb, repo, origin, sh, stolos } = f;
    try {
      const engine = path.join(sb.home, "stolos-engine");
      await engineRepo(sh, engine);
      const source = `git+${path.toFileUrl(engine).href}`;
      const { packageJsonText } = await import("../src/archon/fleet/scaffold.ts");
      await fs.writeTextFile(path.join(repo, "package.json"), packageJsonText("v0.0.1", source));
      let r = await stolos(["apply", "-m", "lab: pin the engine"]);
      assertEquals(r.code, 0, r.out);

      // A record Stolos wrote (signed by the send) and a newer engine (signed by the upgrade): two signatures.
      const record = discoveredSource([
        {
          name: "gamma",
          hostname: "gamma.lab.example.net",
          source: "check-in",
          at: "2026-11-17T09:00:00Z",
          addresses: ["10.0.0.30"],
          macs: ["02:00:00:00:00:30"],
          hostKeys: [],
        },
      ]);
      await fs.writeTextFile(path.join(repo, "fleets/lab/discovered.ts"), record);
      const count = path.join(sb.home, "asked");
      const counting = await countingAskpass(sb.home, count, 0);
      // This run's own log (as root every run logs to one shared folder, and tests run side by side).
      const logFile = path.join(sb.home, "update.log");
      r = await stolos(["update", "--no-doctor", "--verbose"], {
        SSH_ASKPASS: counting,
        ARCHON_LOG: logFile,
      });
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "Signing 1 file: machines discovered");
      assertEquals((r.out.match(/Signing \d+ files?:/g) ?? []).length, 2, `two signings\n${r.out}`);
      assertStringIncludes(r.out, "engine upgrade to v" + VERSION);
      assertEquals((await fs.readTextFile(count)).trim(), "1", "the askpass was asked once");
      // Both are on GitHub, signed (the servers would accept them).
      const subjects = (await sh(origin, "git", "log", "-3", "--format=%s", "main")).split("\n");
      assertStringIncludes(subjects.join("|"), `adopt the engine v${VERSION}`);
      assertStringIncludes(subjects.join("|"), "machines discovered");
      assertEquals(await sh(repo, "git", "log", "-2", "--format=%G?"), "G\nG");

      // The run log says what ran where: the send in this process, the upgrade in a child (the pin moved).
      const log = await fs.readTextFile(logFile);
      assertStringIncludes(log, "nested (in process): apply -m");
      assertStringIncludes(log, "nested (child process): fleet upgrade");
      assertStringIncludes(log, "passphrase: asked (1)");
      assert(!log.includes(PASS), "never in the run log");

      // A newer engine and another record, with a first wrong answer: asked twice in all, the second signing asks nobody.
      await sh(
        engine,
        "sh",
        "-c",
        `sed -i.bak 's/"version":"${VERSION}"/"version":"0.999.0"/' package.json && rm package.json.bak`,
      );
      await sh(
        engine,
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "-a",
        "--no-gpg-sign",
        "-m",
        "0.999.0",
      );
      await sh(engine, "git", "tag", "v0.999.0");
      await fs.writeTextFile(
        path.join(repo, "fleets/lab/discovered.ts"),
        record.replace("gamma", "delta"),
      );
      await fs.remove(count);
      const wrongOnce = await countingAskpass(sb.home, count, 1);
      r = await stolos(["update", "--no-doctor"], { SSH_ASKPASS: wrongOnce });
      assertEquals(r.code, 0, r.out);
      assertEquals(r.out.split("didn't unlock").length - 1, 1, r.out);
      assertStringIncludes(r.out, "(2 left)");
      assertStringIncludes(r.out, "Updated to v0.999.0");
      assertEquals(
        (await fs.readTextFile(count)).trim(),
        "2",
        "one wrong, one right, and nobody more",
      );

      // Nothing the engine wrote holds the passphrase (the askpass stand-ins are the person typing it).
      const hits: string[] = [];
      for (const file of await fs.walkFiles(sb.home)) {
        if (
          /askpass.*\.(sh|cmd)$/.test(file) ||
          file.includes("node_modules") ||
          file.includes(".git/")
        )
          continue;
        const bytes = await fs.readFile(path.join(sb.home, file)).catch(() => new Uint8Array());
        if (td.decode(bytes).includes(PASS)) hits.push(file);
      }
      assertEquals(hits, [], "never stored");
      // The helper's folder is gone.
      const left: string[] = [];
      for await (const e of fs.readDir(sb.env["TMPDIR"] ?? "/tmp")) {
        if (e.name.startsWith("stolos-askpass-")) left.push(e.name);
      }
      assertEquals(left, []);
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  {
    skip:
      (proc.build.os === "windows" && NO_BROKER_ON_WINDOWS) ||
      (proc.which("bun") === undefined && "bun is not installed (fleet upgrade runs bun install)"),
  },
);

/** Python's pty module drives a real terminal (Linux and macOS): the passphrase is typed, and not echoed. */
const PTY_DRIVER = `
import pty, os, sys, select, time
pid, fd = pty.fork()
if pid == 0:
    for k in list(os.environ):
        if k.startswith("SSH_ASKPASS") or k == "DISPLAY":
            del os.environ[k]
    os.chdir(sys.argv[1])
    cmd = sys.argv[2:-1] + ["apply", "-m", "lab: typed at a terminal"]
    os.execvp(cmd[0], cmd)
out = b""
sent = False
t0 = time.time()
while time.time() - t0 < 80:
    r, _, _ = select.select([fd], [], [], 1)
    if not r:
        continue
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    out += d
    if not sent and b"kept in memory" in out:
        time.sleep(0.3)
        os.write(fd, sys.argv[-1].encode() + b"\\r")
        sent = True
_, st = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
sys.stdout.write("\\nEXIT %d" % os.waitstatus_to_exitcode(st))
`;

proves(
  ["106-one-passphrase-speed FR-004"],
  "106: at a terminal Stolos asks itself, naming the key, with no echo, and the key unlocks",
  async () => {
    const f = await fleet();
    try {
      const hostFile = path.join(f.repo, "fleets/lab/hosts/alpha/host.ts");
      await fs.writeTextFile(hostFile, (await fs.readTextFile(hostFile)) + "\n// a change\n");
      const env: Record<string, string> = {
        ...f.sb.env,
        ...f.env,
        ARCHON_REPO: f.repo,
        ARCHON_FLEET: "lab",
      };
      delete env["SSH_ASKPASS"];
      const r = await proc.run(
        [
          "python3",
          "-I",
          "-c",
          PTY_DRIVER,
          f.repo,
          ...runtimeCommand(),
          path.join(ENGINE_ROOT, "src/stolos/main.ts"),
          PASS,
        ],
        { env, clearEnv: true },
      );
      const out = r.stdout;
      assertStringIncludes(out, "EXIT 0");
      assertStringIncludes(out, "kept in memory until this command ends");
      assertStringIncludes(
        out,
        `Enter passphrase for "${path.join(f.sb.home, ".ssh", "fleet-signing")}"`,
      );
      assert(!out.includes(PASS), "what was typed is not echoed");
      assertStringIncludes(out, "Sent: every server applies it within 15 minutes");
      assertEquals(
        await f.sh(f.origin, "git", "log", "-1", "--format=%s", "main"),
        "lab: typed at a terminal",
      );
    } finally {
      await fs.remove(f.sb.home, { recursive: true });
    }
  },
  {
    skip:
      (proc.build.os === "windows" && "a pseudo-terminal driver needs Python's pty module") ||
      (proc.which("python3") === undefined && "python3 is not installed"),
  },
);

proves(
  ["106-one-passphrase-speed FR-005"],
  "106: the keys commands are unchanged (OpenSSH asks, Stolos never sees the passphrase) and none is offered over MCP",
  async () => {
    const keys = COMMANDS.filter((c) => c.name === "keys" || c.name.startsWith("keys "));
    assert(keys.length >= 5, keys.map((c) => c.name).join(", "));
    const { listed } = await import("../src/archon/mcp/server.ts");
    for (const c of keys) assert(!listed(c, "mutate"), `${c.name} is offered over MCP`);
    // The keys commands do not use the session; the MCP server never imports it.
    const root = path.join(ENGINE_ROOT, "src/archon");
    for (const rel of ["identity/keys-commands.ts", "identity/keys.ts", "mcp/server.ts"]) {
      const text = await fs.readTextFile(path.join(root, rel));
      assert(!/passphrase\.ts/.test(text), `${rel} imports the passphrase session`);
    }
  },
);

proves(
  ["106-one-passphrase-speed FR-002", "106-one-passphrase-speed FR-004"],
  "106: Windows keeps one askpass per signing (no broker, no helper script, no server, nothing added to the environment), every other system keeps the broker",
  async () => {
    const win = passphrasesFor("windows");
    assert(win instanceof PerSigningSession);
    assertEquals(await win.signingEnv(), {});
    assertEquals(await win.childEnv(), {});
    await win.wipe();
    for (const os of ["linux", "darwin"]) {
      const other = passphrasesFor(os);
      assert(other instanceof PassphraseSession, os);
      await other.wipe();
    }
  },
);

proves(
  ["106-one-passphrase-speed FR-004"],
  "106: an askpass program that never answers is stopped at the limit: the person is told no, and nothing waits for it",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-ask106-" });
    const saved = ["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"].map((k) => [k, proc.env.get(k)] as const);
    try {
      const program =
        proc.build.os === "windows" ? path.join(dir, "never.cmd") : path.join(dir, "never.sh");
      await fs.writeTextFile(
        program,
        proc.build.os === "windows"
          ? "@ping -n 60 127.0.0.1 >nul\r\n"
          : "#!/bin/sh\nexec sleep 60\n",
      );
      if (proc.build.os !== "windows") await fs.chmod(program, 0o700);
      proc.env.set("SSH_ASKPASS", program);
      proc.env.set("SSH_ASKPASS_REQUIRE", "force");
      const start = performance.now();
      const typed = await askThePerson("Enter passphrase:", 300);
      assertEquals(typed, undefined);
      assert(performance.now() - start < 15_000, "stopped at the limit, not at the program's end");
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) proc.env.delete(k);
        else proc.env.set(k, v);
      }
      await fs.remove(dir, { recursive: true });
    }
  },
);
