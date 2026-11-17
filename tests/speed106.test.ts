/**
 * Spec 106-one-passphrase-speed: a quick one. A no-op `update`, `apply` and `fleet status` against a
 * sandbox fleet (real Git, real OpenSSH, a pinned engine) finish inside a bound, start no child
 * process, fetch once and write their timings to the run log; and the pieces that make it so:
 * a nested run in this process, the probe cache, the once-per-run fetch and read.
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
import { portNotCheckable } from "../src/archon-boot/doctor.ts";
import { firewallWarnings, forgetWindowsState } from "../src/archon-boot/firewall.ts";
import { runNested, setNestedRunner } from "../src/archon/core/nested.ts";
import {
  bypassed,
  forgetRun,
  PROBE_TTL_MS,
  probed,
  probeCacheFile,
} from "../src/archon/core/probe-cache.ts";
import { fetchOnce, readOnce, resetRunMemo } from "../src/archon/core/run-memo.ts";
import { Ui, ui } from "../src/archon/core/ui.ts";
import { engineRepo, fleet } from "./lab-fleet.ts";

/**
 * How long a no-op command may take in the sandbox before its test fails. The spec's target is 3
 * seconds on an ordinary PC; on this container the commands take about 0.3 seconds. The bound is
 * generous (10 seconds) because the suite runs many tests at once on shared CI machines, on Windows
 * too, where starting a process takes up to a second: it still fails for the shape this spec
 * removed (a process, a fetch and a model load per step, and a firewall probe), which took 41
 * seconds on a Windows PC.
 */
const NO_OP_BOUND_MS = proc.build.os === "windows" ? 60_000 : 10_000;

/** The `git fetch` processes a `GIT_TRACE2_EVENT` file records (the top-level ones, not git's own helpers). */
function fetches(trace: string): number {
  return trace
    .split("\n")
    .filter((l) => l.includes('"event":"cmd_name"') && l.includes('"name":"fetch"'))
    .filter((l) => !/"sid":"[^"]*\//.test(l)).length;
}

proves(
  [
    "106-one-passphrase-speed FR-006",
    "106-one-passphrase-speed FR-007",
    "106-one-passphrase-speed FR-009",
    "106-one-passphrase-speed FR-010",
  ],
  "106: a no-op update, apply and fleet status in a pinned sandbox fleet finish inside the bound, start no child process, fetch once, and log the time of every phase",
  async () => {
    const f = await fleet();
    const { sb, repo, sh, stolos } = f;
    try {
      const engine = path.join(sb.home, "stolos-engine");
      await engineRepo(sh, engine);
      const source = `git+${path.toFileUrl(engine).href}`;
      const { packageJsonText } = await import("../src/archon/fleet/scaffold.ts");
      await fs.writeTextFile(path.join(repo, "package.json"), packageJsonText("v0.0.1", source));
      let r = await stolos(["apply", "-m", "lab: pin the engine"]);
      assertEquals(r.code, 0, r.out);
      // The first update adopts the engine (a child run, the pin moved); the rest are no-ops.
      r = await stolos(["update", "--no-doctor"]);
      assertEquals(r.code, 0, r.out);
      // A boot machine (an admin password hash), so that the update runs the boot doctor too.
      const hash = path.join(sb.home, "config/stolos/secrets/lab/admin-password.hash");
      await fs.mkdir(path.dirname(hash), { recursive: true });
      await fs.writeTextFile(hash, "x\n");

      const trace = path.join(sb.home, "git-trace.json");
      // On Windows each doctor may spend its 20 s firewall limit (PowerShell reads every rule), so
      // two commands there keep the test inside the runner's per-test limit; the rest run all four.
      const commands =
        proc.build.os === "windows"
          ? [["update"], ["fleet", "status"]]
          : [["update"], ["apply"], ["fleet", "status"], ["update"]];
      for (const args of commands) {
        await fs.remove(trace).catch(() => {});
        const start = performance.now();
        const logFile = path.join(sb.home, "run.log");
        await fs.remove(logFile).catch(() => {});
        r = await stolos(args, { GIT_TRACE2_EVENT: trace, ARCHON_LOG: logFile });
        const took = performance.now() - start;
        assert(took < NO_OP_BOUND_MS, `${args.join(" ")} took ${Math.round(took)} ms\n${r.out}`);
        assertEquals(r.code, 0, `${args.join(" ")}\n${r.out}`);
        const log = await fs.readTextFile(logFile);
        assert(
          !log.includes("nested (child process)"),
          `${args.join(" ")} started a child\n${log}`,
        );
        // Every phase has its time, and the run its total; none of it on the screen.
        assert(/^\S+ +TIME \S.* \d+ms$/m.test(log), log);
        assert(/ TIME total \d+ms$/m.test(log), log);
        assert(!/TIME/.test(r.out), `no timing on the screen\n${r.out}`);
        const t = await fs.readTextFile(trace).catch(() => "");
        if (args[0] === "update") {
          assertStringIncludes(log, "nested (in process): boot doctor");
          assertEquals(fetches(t), 1, "update and its doctor fetch once between them");
        } else assert(fetches(t) <= 1, `${args.join(" ")} fetched ${fetches(t)} times`);
      }
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  {
    skip:
      proc.which("bun") === undefined && "bun is not installed (fleet upgrade runs bun install)",
  },
);

/** A Ui that writes into a string. */
function mk(mode: "calm" | "verbose" | "quiet", logPath?: string): { u: Ui; out: () => string } {
  let text = "";
  const u = new Ui({
    tty: false,
    color: false,
    emoji: false,
    now: () => 0,
    mode,
    hintsFile: null,
    write: (s) => (text += s),
    ...(logPath ? { logPath } : {}),
  });
  return { u, out: () => text };
}

proves(
  ["106-one-passphrase-speed FR-006"],
  "106: a run nested in this process is a phase of its parent: it sets the parent's phases and problems aside, draws nothing, hands back what it found, and gives everything back, even when it throws",
  async () => {
    const { u, out } = mk("calm");
    const send = u.phase("Send");
    send.warn("a warning of the parent's", "bun run stolos apply", "E105-WARNING");
    const { value, summary } = await u.nestedRun(() => {
      u.header("Stolos apply", "lab");
      const c = u.phase("Checks");
      c.fail("the child failed", "bun run stolos apply", "E105-FAILED");
      u.phase("Commit").action("yours", "bun run stolos apply", "E105-UNSENT");
      u.outcome("Sent: x");
      assertEquals(u.nested, "calm");
      return Promise.resolve(7);
    });
    assertEquals(value, 7);
    assertEquals(summary.fails, 1);
    assertEquals(summary.actions, 1);
    assertEquals(summary.outcomes, ["Sent: x"]);
    assertEquals(
      summary.problems.map((p) => p.message),
      ["the child failed", "yours"],
    );
    // The parent's phase is still open and its problems are its own; the child drew nothing.
    assertEquals(u.nested, undefined);
    assertEquals(
      u.problems.map((p) => p.message),
      ["a warning of the parent's"],
    );
    assertEquals(u.outcomes, []);
    assertEquals(out(), "", "calm: a nested run prints nothing");
    send.merge(summary.problems, summary.outcomes);
    send.done();
    u.finish();
    assertEquals(out().split("the child failed").length - 1, 1, "shown once, by the parent");
    assertEquals(out().split("==> Stolos").length - 1, 0, "no second header");

    // Verbose: the child's steps are the parent's to show.
    const v = mk("verbose");
    await v.u.nestedRun(() => {
      v.u.phase("Keys").done("current");
      return Promise.resolve();
    });
    assertStringIncludes(v.out(), "Keys");
    // A child that throws gives everything back.
    const t = mk("calm");
    t.u.phase("Send").warn("kept", "x", "E105-WARNING");
    let threw = false;
    try {
      await t.u.nestedRun(() => {
        t.u.phase("Checks").fail("lost with the child", "x", "E105-FAILED");
        return Promise.reject(new Error("boom"));
      });
    } catch {
      threw = true;
    }
    assert(threw);
    assertEquals(t.u.nested, undefined);
    assertEquals(
      t.u.problems.map((p) => p.message),
      ["kept"],
    );
    // A finish inside (a command that ends with its own) is the child's summary, not a closing block.
    const w = mk("calm");
    const inner = await w.u.nestedRun(() => {
      w.u.phase("Validate").warn("w", "x", "E105-WARNING");
      return Promise.resolve(w.u.finish());
    });
    assertEquals(inner.value, 0);
    assertEquals(inner.summary.warns, 1);
    assertEquals(w.out(), "");
    // With no runner (or one that says the command needs a process of its own) nothing runs here.
    setNestedRunner(undefined);
    assertEquals(await runNested(["keys"]), undefined);
    setNestedRunner(() => Promise.resolve(undefined));
    assertEquals(await runNested(["apply"]), undefined);
    setNestedRunner(() => Promise.resolve(0));
    assertEquals((await runNested(["keys"]))?.code, 0);
    setNestedRunner(undefined);
  },
);

proves(
  ["106-one-passphrase-speed FR-008"],
  "106: the probe cache keeps an answer for five minutes, never longer, not for a report, --verbose or --fresh, not an incomplete one, and asks the system once per run",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-probe106-" });
    try {
      const file = path.join(dir, "probe-cache.json");
      let clock = 1_000_000;
      const now = (): number => clock;
      let asked = 0;
      const ask = (): Promise<{ done: boolean; n: number }> =>
        Promise.resolve({ done: true, n: ++asked });
      const keep = (v: unknown): boolean => (v as { done: boolean }).done;
      const o = { file, now, keep, bypass: false };
      // A miss asks and keeps; a hit does not ask.
      assertEquals((await probed("k", ask, o)).n, 1);
      forgetRun();
      assertEquals((await probed("k", ask, o)).n, 1);
      assertEquals(asked, 1);
      // The same question twice in one run asks once even where nothing is kept.
      assertEquals((await probed("once", ask, { ...o, bypass: true })).n, 2);
      assertEquals((await probed("once", ask, { ...o, bypass: true })).n, 2);
      assertEquals(asked, 2);
      // Just inside the time to live it is a hit; at it, a miss, and the new answer replaces it.
      forgetRun();
      clock += PROBE_TTL_MS - 1;
      assertEquals((await probed("k", ask, o)).n, 1);
      forgetRun();
      clock += 1;
      assertEquals((await probed("k", ask, o)).n, 3);
      // A clock gone backwards is not a hit.
      forgetRun();
      clock -= 10 * 60_000;
      assertEquals((await probed("k", ask, o)).n, 4);
      // A bypass neither reads nor writes: the kept answer stays as it was.
      forgetRun();
      const before = await fs.readTextFile(file);
      assertEquals((await probed("k", ask, { ...o, bypass: true })).n, 5);
      assertEquals(await fs.readTextFile(file), before);
      // An incomplete answer is not kept.
      forgetRun();
      const half = (): Promise<{ done: boolean; n: number }> =>
        Promise.resolve({ done: false, n: 99 });
      assertEquals((await probed("half", half, o)).n, 99);
      forgetRun();
      assertEquals(
        (await probed("half", ask, o)).n,
        6,
        "asked again: the half answer was not kept",
      );
      // A question that throws is not kept for the rest of the run.
      forgetRun();
      let threw = false;
      try {
        await probed("bad", () => Promise.reject(new Error("no")), o);
      } catch {
        threw = true;
      }
      assert(threw);
      assertEquals((await probed("bad", ask, o)).n, 7);
      // A damaged file is not an error.
      forgetRun();
      await fs.writeTextFile(file, "{ not json");
      assertEquals((await probed("k", ask, o)).n, 8);

      // The report's and --verbose's way: a verbose run leaves the file alone.
      const was = ui.mode;
      try {
        ui.setMode("verbose");
        assert(bypassed(), "verbose bypasses");
        ui.setMode("calm");
        assert(!bypassed(), "calm does not");
      } finally {
        ui.setMode(was);
      }
    } finally {
      forgetRun();
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["106-one-passphrase-speed FR-008"],
  "106: the firewall check is kept in the state folder as warnings (never rules), used by the next calm run, and left alone by a fresh one",
  async () => {
    const home = await fs.makeTempDir({ prefix: "stolos-fw106-" });
    const saved = ["HOME", "LOCALAPPDATA", "USERPROFILE"].map((k) => [k, proc.env.get(k)] as const);
    try {
      proc.env.set("HOME", home);
      proc.env.set("LOCALAPPDATA", path.join(home, "local"));
      proc.env.set("USERPROFILE", home);
      forgetRun();
      forgetWindowsState();
      const was = ui.mode;
      ui.setMode("calm");
      const needs = [{ protocol: "TCP" as const, port: 8080, what: "HTTP" }];
      const lines = await firewallWarnings(needs);
      const file = probeCacheFile();
      assert(file.startsWith(home) || file.includes("local"), `in the state folder: ${file}`);
      // On a machine whose firewall cannot be read the check is incomplete and nothing is kept.
      const kept = await fs.exists(file);
      if (kept) {
        const text = await fs.readTextFile(file);
        const entry = Object.values(
          JSON.parse(text) as Record<
            string,
            { at: number; value: { done: boolean; lines: string[] } }
          >,
        )[0];
        assertEquals(entry?.value.done, true);
        assertEquals(entry?.value.lines, lines, "the warnings, nothing else");
        // The next calm run answers from the file; a fresh one asks again and leaves it as it was.
        forgetRun();
        assertEquals(await firewallWarnings(needs), lines);
        assertEquals(await fs.readTextFile(file), text, "a hit writes nothing");
        forgetRun();
        assertEquals(await firewallWarnings(needs, { fresh: true }), lines);
        assertEquals(await fs.readTextFile(file), text, "fresh leaves the file alone");
        // A report (verbose) leaves it alone too.
        forgetRun();
        ui.setMode("verbose");
        assertEquals(await firewallWarnings(needs), lines);
        assertEquals(await fs.readTextFile(file), text);
      }
      ui.setMode(was);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) proc.env.delete(k);
        else proc.env.set(k, v);
      }
      forgetRun();
      forgetWindowsState();
      await fs.remove(home, { recursive: true });
    }
  },
);

proves(
  ["106-one-passphrase-speed FR-009"],
  "106: a run fetches origin once (a fetch of one branch is not asked twice, a fetch of everything covers it) and reads a file once until it changes",
  async () => {
    const dir = await fs.realPath(await fs.makeTempDir({ prefix: "stolos-memo106-" }));
    const was = proc.env.get("GIT_TRACE2_EVENT");
    try {
      const git = async (cwd: string, ...a: string[]): Promise<void> => {
        const r = await proc.run(["git", ...a], { cwd });
        assertEquals(r.code, 0, r.stderr);
      };
      const origin = path.join(dir, "origin.git");
      const clone = path.join(dir, "clone");
      await git(dir, "init", "-q", "--bare", "-b", "main", origin);
      await git(dir, "clone", "-q", origin, clone);
      const trace = path.join(dir, "trace.json");
      proc.env.set("GIT_TRACE2_EVENT", trace);
      resetRunMemo();
      const a = await fetchOnce(clone, "main");
      const b = await fetchOnce(clone, "main");
      assertEquals(a, b);
      assertEquals(fetches(await fs.readTextFile(trace)), 1, "one fetch for two asks");
      // Everything is not covered by one branch, and covers it after.
      await fetchOnce(clone);
      await fetchOnce(clone, "main");
      await fetchOnce(clone);
      assertEquals(fetches(await fs.readTextFile(trace)), 2);
      // Each command starts afresh.
      resetRunMemo();
      await fetchOnce(clone, "main");
      assertEquals(fetches(await fs.readTextFile(trace)), 3);

      // A file is read once, and again after it changed.
      const file = path.join(dir, "fleet.ts");
      await fs.writeTextFile(file, "one");
      let reads = 0;
      const load = async (): Promise<string> => {
        reads++;
        return await fs.readTextFile(file);
      };
      assertEquals(await readOnce("fleet", [file], load), "one");
      assertEquals(await readOnce("fleet", [file], load), "one");
      assertEquals(reads, 1);
      await fs.writeTextFile(file, "two, longer");
      assertEquals(await readOnce("fleet", [file], load), "two, longer");
      assertEquals(reads, 2);
      await fs.remove(file);
      assertEquals(await readOnce("fleet", [file], () => Promise.resolve("gone")), "gone");
    } finally {
      if (was === undefined) proc.env.delete("GIT_TRACE2_EVENT");
      else proc.env.set("GIT_TRACE2_EVENT", was);
      resetRunMemo();
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["106-one-passphrase-speed FR-010"],
  "106: every phase writes its time to the run log, and the run its total, and the screen shows none of it",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-time106-" });
    try {
      const log = path.join(dir, "run.log");
      let clock = 0;
      let text = "";
      const u = new Ui({
        tty: false,
        color: false,
        emoji: false,
        now: () => clock,
        mode: "verbose",
        hintsFile: null,
        write: (s) => (text += s),
        logPath: log,
      });
      u.useLog(log);
      u.header("Stolos update", "lab");
      const p = u.phase("Pull");
      clock += 1234;
      p.done("up to date");
      const k = u.phase("Keys");
      clock += 56;
      k.done("current");
      u.finish();
      const lines = (await fs.readTextFile(log)).split("\n");
      assert(
        lines.some((l) => / {3}TIME Pull 1234ms$/.test(l)),
        lines.join("\n"),
      );
      assert(
        lines.some((l) => / {3}TIME Keys 56ms$/.test(l)),
        lines.join("\n"),
      );
      assert(
        lines.some((l) => / {3}TIME total 1290ms$/.test(l)),
        lines.join("\n"),
      );
      assert(!text.includes("TIME"), "never drawn");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["106-one-passphrase-speed FR-008"],
  "106: reading the firewall has a hard time limit: a probe that never answers is cut, stopped by its signal, and says it could not check, as one warning with what to do; the answer is not kept",
  async () => {
    const home = await fs.makeTempDir({ prefix: "stolos-fwlimit106-" });
    const saved = ["HOME", "LOCALAPPDATA", "USERPROFILE"].map((k) => [k, proc.env.get(k)] as const);
    try {
      proc.env.set("HOME", home);
      proc.env.set("LOCALAPPDATA", path.join(home, "local"));
      proc.env.set("USERPROFILE", home);
      const was = ui.mode;
      ui.setMode("calm");
      const needs = [{ protocol: "UDP" as const, port: 69, what: "TFTP" }];
      let stopped = false;
      forgetRun();
      const start = performance.now();
      // A probe that ignores its signal and never settles (a stuck PowerShell with a child holding its pipes).
      const lines = await firewallWarnings(needs, {
        limitMs: 200,
        probe: (_n, signal) => {
          signal.addEventListener("abort", () => (stopped = true));
          return new Promise<string[] | undefined>(() => {});
        },
      });
      assert(performance.now() - start < 10_000, "cut at the limit");
      assertEquals(lines.length, 1, lines.join("\n"));
      assertStringIncludes(lines[0] ?? "", "could not be checked");
      assertStringIncludes(lines[0] ?? "", "--fresh");
      assert(!/\u2014/.test(lines[0] ?? ""), "no em dash");
      assert(stopped, "the probe was told to stop");
      assert(!(await fs.exists(probeCacheFile())), "an unfinished check is not kept");
      // A probe that cannot read the rules says the same.
      forgetRun();
      const none = await firewallWarnings(needs, {
        limitMs: 200,
        probe: () => Promise.resolve(undefined),
      });
      assertEquals(none, lines);
      // One that answers in time is believed and kept.
      forgetRun();
      assertEquals(
        await firewallWarnings(needs, { limitMs: 5_000, probe: () => Promise.resolve([]) }),
        [],
      );
      ui.setMode(was);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) proc.env.delete(k);
        else proc.env.set(k, v);
      }
      forgetRun();
      await fs.remove(home, { recursive: true });
    }
  },
);

proves(
  ["106-one-passphrase-speed FR-008"],
  "106: a port below 1024 that an account may not bind is not a taken port: the doctor cannot check it and says so (a warning), never a failure",
  () => {
    assert(portNotCheckable("EACCES", 69, "linux"));
    assert(portNotCheckable("EACCES", 443, "darwin"));
    assert(!portNotCheckable("EADDRINUSE", 69, "linux"), "taken is taken");
    assert(
      !portNotCheckable("EACCES", 8080, "linux"),
      "an ordinary port that is refused is a real problem",
    );
    assert(!portNotCheckable("EACCES", 69, "windows"));
  },
);
