/**
 * Spec 105-calm-output: golden user-acceptance tests. The real `update`, `apply` and a report
 * (`boot doctor`) run in sandbox fleets (real temporary Git repositories, OpenSSH's askpass for the
 * passphrase) and the default output is read in each state: nothing to do; a wrong passphrase
 * retried; a wrong passphrase three times; an unsent commit listed; an engine upgrade, and one
 * interrupted and resumed; an optional feature that is off; `--quiet`; `--verbose`; a report.
 * Invariants hold over all of them. No real network: the engine is a local Git repository and the
 * release notes come from a local server named by `ARCHON_GITHUB_API`.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { OUTPUT_CLASSES } from "../src/archon/ontology.auto.ts";
import { splitFix, Ui } from "../src/archon/core/ui.ts";
import { EXPLAIN } from "../src/archon/core/explain.ts";
import { summarizeCommits, tidySubject } from "../src/archon/fleet/whatsnew.ts";
import { readSummary } from "../src/archon/update/operator.ts";
import { VERSION } from "../src/archon/version.ts";
import { ENGINE_ROOT } from "./sandbox.ts";
import { countingAskpass, engineRepo, fleet } from "./lab-fleet.ts";

/** What a run's default output must never hold (spec 105-calm-output FR-003, FR-004). */
function invariants(out: string, what: string): void {
  const lines = out.split("\n");
  assert(
    !out.includes("✅") && !lines.some((l) => /^\[ok\] /.test(l)),
    `${what}: a green step line\n${out}`,
  );
  if (/⚡|^\[you\]|\n\s*\[you\]/.test(out)) {
    assert(!/all well|\bdone\b|finished/i.test(out), `${what}: a verdict beside a ⚡\n${out}`);
  }
  assertEquals(
    lines.filter((l) => /^(==>|🛰️)\s*Stolos /.test(l)).length,
    1,
    `${what}: one header\n${out}`,
  );
  assert(!/^next: .*\n(.|\n)*\nnext: /m.test(out), `${what}: more than one next line\n${out}`);
  // Every problem line carries its code.
  for (const l of lines) {
    if (/^(\[FAIL\]|\[warn\]|\[you\]|!! |⚡|❌|⚠️)/.test(l) && !/\[[EP]\d{3}-[A-Z-]+\]/.test(l)) {
      assert(false, `${what}: no code on: ${l}`);
    }
  }
}

proves(
  [
    "105-calm-output FR-003",
    "105-calm-output FR-004",
    "105-calm-output FR-005",
    "105-calm-output FR-006",
    "105-calm-output FR-007",
    "105-calm-output FR-010",
    "105-calm-output FR-012",
    "105-calm-output FR-013",
    "105-calm-output FR-018",
  ],
  "105: update and apply in a sandbox fleet: nothing to do, --quiet, --verbose, an unsent commit listed, a wrong passphrase retried, and three times",
  async () => {
    const f = await fleet();
    try {
      const { sb, repo, sh, stolos } = f;
      // 1. Nothing to do: calm, one header, one verdict, no green step line, no next line.
      let r = await stolos(["update", "--no-doctor"]);
      assertEquals(r.code, 0, r.out);
      invariants(r.out, "update, nothing to do");
      assertStringIncludes(r.out, "Up to date");
      assert(!r.out.includes("next:"), r.out);
      assert(!r.out.includes("where you are"), r.out);
      // With the doctor: it is a phase of this run (stolos keys, nested), not a run of its own.
      r = await stolos(["update"]);
      invariants(r.out, "update with its doctor");
      assertEquals(r.out.split("\n").filter((l) => /Up to date|finished/.test(l)).length, 1, r.out);

      // 2. --quiet: one line and the exit code. --verbose: every green step is back.
      r = await stolos(["update", "--no-doctor", "--quiet"]);
      assertEquals(r.code, 0);
      assertEquals(r.out.trim().split("\n").length, 1, r.out);
      assertStringIncludes(r.out, "Up to date");
      r = await stolos(["update", "--no-doctor", "-q"]);
      assertEquals(r.out.trim().split("\n").length, 1, r.out);
      r = await stolos(["update", "--no-doctor", "--verbose"]);
      assert(/\[ok\] Pull +up to date/.test(r.out), r.out);
      assert(/\[ok\] Engine/.test(r.out), r.out);

      // 3. An unsent commit made here: listed with its subject before the passphrase.
      await fs.writeTextFile(path.join(repo, "NOTES.md"), "made here\n");
      await sh(repo, "git", "add", "-A");
      await sh(repo, "git", "commit", "-q", "--no-gpg-sign", "-m", "notes for the lab");
      r = await stolos(["update", "--no-doctor"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "1 commit made elsewhere, not signed by a fleet signer");
      assertStringIncludes(r.out, "notes for the lab");
      assertStringIncludes(r.out, "Sent: every server applies it within 15 minutes");
      invariants(r.out, "update, an unsent commit");
      // A commit signed here and not sent: listed too, before anything leaves.
      await fs.writeTextFile(path.join(repo, "NOTES2.md"), "signed here\n");
      await sh(repo, "git", "add", "-A");
      await sh(repo, "git", "commit", "-q", "-S", "-m", "signed notes for the lab");
      r = await stolos(["update", "--no-doctor"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "Sending 1 commit made here");
      assertStringIncludes(r.out, "signed notes for the lab");
      invariants(r.out, "update, a signed unsent commit");

      // 4. A wrong passphrase once, then right: retried in place, one message, success.
      const count = path.join(sb.home, "asked");
      const wrongOnce = await countingAskpass(sb.home, count, 1);
      const hostFile = path.join(repo, "fleets/lab/hosts/alpha/host.ts");
      await fs.writeTextFile(hostFile, (await fs.readTextFile(hostFile)) + "\n// a change\n");
      r = await stolos(["apply", "-m", "lab: alpha, retried"], { SSH_ASKPASS: wrongOnce });
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "That passphrase didn't unlock your daily key (2 left)");
      assertEquals(r.out.split("didn't unlock").length - 1, 1, r.out);
      assertStringIncludes(r.out, "Sent: every server applies it within 15 minutes");
      invariants(r.out, "apply, retried");
      assert(!r.out.includes("error:"), `no raw git or ssh text\n${r.out}`);

      // 5. A wrong passphrase three times: cause first, once, what happened to the data, one command.
      await fs.remove(count);
      const alwaysWrong = await countingAskpass(sb.home, count, 99);
      await fs.writeTextFile(hostFile, (await fs.readTextFile(hostFile)) + "\n// another\n");
      r = await stolos(["apply", "-m", "lab: alpha, wrong"], {
        SSH_ASKPASS: alwaysWrong,
        ARCHON_LOG: path.join(sb.home, "wrong.log"),
      });
      assertEquals(r.code, 1, r.out);
      assertEquals(r.out.split("didn't unlock your daily key, three times").length - 1, 1, r.out);
      assertStringIncludes(r.out, "(1 left)");
      assertStringIncludes(r.out, "Nothing was sent");
      assertStringIncludes(r.out, "safe");
      assertStringIncludes(r.out, "[E105-SIGN-PASSPHRASE]");
      assertStringIncludes(r.out, "next: bun run stolos apply");
      assert(!/incorrect passphrase|Load key/i.test(r.out), `raw text stays in the log\n${r.out}`);
      assertEquals(r.out.split("\n").filter((l) => l.startsWith("next:")).length, 1, r.out);
      assertEquals(
        await sh(f.origin, "git", "log", "-1", "--format=%s", "main"),
        "lab: alpha, retried",
      );
      assertStringIncludes(await sh(repo, "git", "status", "--porcelain"), "host.ts");
      // The log has the raw text; `stolos log` reads it.
      const lg = await stolos(["log", "--last", "200"]);
      assertEquals(lg.code, 0, lg.out);
      // (As root every run logs to one shared folder, and tests run side by side: this run's own log is read by its path.)
      assert(/passphrase/i.test(await fs.readTextFile(path.join(sb.home, "wrong.log"))));
      const where = await stolos(["log", "--path"]);
      assert(where.out.trim().endsWith(".log"), where.out);
    } finally {
      await fs.remove(f.sb.home, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

proves(
  [
    "105-calm-output FR-005",
    "105-calm-output FR-007",
    "105-calm-output FR-013",
    "105-calm-output FR-014",
    "105-calm-output FR-015",
    "105-calm-output FR-016",
    "105-calm-output FR-018",
  ],
  "105: an engine upgrade whose signing fails is said once and resumed by the next update; a later upgrade succeeds with what's new and an operator action",
  async () => {
    const f = await fleet();
    const api = await serve(
      { hostname: "127.0.0.1", port: 19000 + Math.floor(Math.random() * 900) },
      (req) => {
        const url = new URL(req.url);
        if (
          /\/compare\/stolos-v0\.135\.0\.\.\.stolos-v0\.999\.0$/.test(url.pathname) ||
          /\/compare\/.*\.\.\.stolos-v0\.999\.0$/.test(url.pathname)
        ) {
          return Response.json({
            commits: [
              { commit: { message: "105-calm-output: calm output for actions\n\nbody" } },
              { commit: { message: "spec 105-calm-output: calm output for actions" } },
              {
                commit: {
                  message: "106-next: a thing\n\nOperator action: run bun run stolos vault backup",
                },
              },
            ],
          });
        }
        return new Response("{}", { status: 404 });
      },
    );
    try {
      const { sb, repo, origin, sh, stolos } = f;
      const engine = path.join(sb.home, "stolos-engine");
      await engineRepo(sh, engine);
      const source = `git+${path.toFileUrl(engine).href}`;
      const { packageJsonText } = await import("../src/archon/fleet/scaffold.ts");
      // The fleet pins an old engine.
      await fs.writeTextFile(
        path.join(repo, "package.json"),
        packageJsonText("stolos-v0.0.1", source),
      );
      const baseEnv = { ARCHON_GITHUB_API: `http://127.0.0.1:${api.addr.port}` };
      let r = await stolos(["apply", "-m", "lab: pin the engine", "--verbose"], baseEnv);
      assertEquals(r.code, 0, r.out);

      // (a) The upgrade is made, signing fails three times: said once, cause first, files safe.
      const count = path.join(sb.home, "asked");
      const wrong = await countingAskpass(sb.home, count, 99);
      r = await stolos(["update", "--no-doctor"], { ...baseEnv, SSH_ASKPASS: wrong });
      assertEquals(r.code, 1, r.out);
      assertEquals(r.out.split("didn't unlock your daily key, three times").length - 1, 1, r.out);
      assertStringIncludes(
        r.out,
        `The engine upgrade to stolos-v${VERSION} is not signed and nothing was sent`,
      );
      assertStringIncludes(r.out, "next: bun run stolos update");
      assertEquals(r.out.split("\n").filter((l) => l.startsWith("next:")).length, 1, r.out);
      assertEquals(r.out.split("\n").filter((l) => /^(==>|🛰️)\s*Stolos /.test(l)).length, 1, r.out);
      assert(!/Needs attention|finished with/.test(r.out), r.out);
      assertStringIncludes(await sh(repo, "git", "status", "--porcelain"), "package.json");

      // (b) Interrupted: update recognizes the upgrade waiting for its signature, never "your changes",
      // and finishes it with the automatic message (no -m), then sends it.
      r = await stolos(["update", "--no-doctor"], baseEnv);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, `Signing`);
      assertStringIncludes(r.out, `engine upgrade to stolos-v${VERSION}`);
      assertStringIncludes(r.out, "Updated to stolos-v" + VERSION);
      assert(!r.out.includes("of yours") && !r.out.includes("your changes"), r.out);
      assertEquals(
        await sh(origin, "git", "log", "-1", "--format=%s", "main"),
        `stolos: adopt the engine stolos-v${VERSION}`,
      );
      assertEquals(await sh(repo, "git", "status", "--porcelain"), "");
      invariants(r.out, "update, an upgrade resumed");

      // (c) A newer engine: the upgrade, the send, what's new and its operator action, one run.
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
      await sh(engine, "git", "tag", "stolos-v0.999.0");
      r = await stolos(["update", "--no-doctor"], baseEnv);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "Signing");
      assertStringIncludes(r.out, "engine upgrade to stolos-v0.999.0");
      assertStringIncludes(r.out, "Sent: every server applies it within 15 minutes");
      assertStringIncludes(r.out, "What's new in stolos-v0.999.0:");
      assertStringIncludes(r.out, "- 105-calm-output: calm output for actions");
      assertEquals(r.out.split("calm output for actions").length - 1, 1, "deduplicated");
      assertStringIncludes(r.out, "run bun run stolos vault backup");
      assertStringIncludes(r.out, "[E105-OPERATOR]");
      assertStringIncludes(r.out, "Updated to stolos-v0.999.0 · 1 for you");
      assert(!r.out.includes("Install"), r.out);
      assert(!r.out.includes(`the engine stolos-v${VERSION}`), "the old version is never reported");
      invariants(r.out, "update, an engine upgrade");
      assertStringIncludes(
        await fs.readTextFile(path.join(repo, "package.json")),
        `#stolos-v0.999.0`,
      );
      const verbose = await stolos(["update", "--no-doctor", "--verbose"], baseEnv);
      assert(/\[ok\] Install +the engine stolos-v0\.999\.0/.test(verbose.out), verbose.out);
    } finally {
      await api.shutdown();
      await fs.remove(f.sb.home, { recursive: true });
    }
  },
  {
    skip:
      proc.which("bun") === undefined && "bun is not installed (fleet upgrade runs bun install)",
    timeout: 180_000,
  },
);

/** A Ui that writes into a string, calm, on a fixed clock. */
function calm(o: ConstructorParameters<typeof Ui>[0] = {}): { ui: Ui; out: () => string } {
  let text = "";
  const ui = new Ui({
    tty: false,
    color: false,
    emoji: false,
    now: () => 0,
    mode: "calm",
    hintsFile: null,
    write: (s) => (text += s),
    ...o,
  });
  return { ui, out: () => text };
}

proves(
  [
    "105-calm-output FR-001",
    "105-calm-output FR-002",
    "105-calm-output FR-018",
    "105-calm-output FR-019",
    "105-calm-output FR-020",
  ],
  "105: every command has an output class from the ontology; reports are the read-tier commands; --quiet and --verbose are global options",
  async () => {
    assertEquals([...OUTPUT_CLASSES], ["report", "action"]);
    // Article 19 states the contract (constitution 6.2.0; later amendments keep it).
    const constitution = await fs.readTextFile(
      path.join(ENGINE_ROOT, ".specify/memory/constitution.md"),
    );
    assertStringIncludes(constitution, "## Article 19: Calm Output");
    assertStringIncludes(constitution, "**Version**: 6.");
    for (const w of [
      "report",
      "action",
      "--quiet",
      "One run, one header, one summary",
      "Raw system errors go to the run log",
    ]) {
      assertStringIncludes(constitution, w);
    }
    for (const c of COMMANDS) {
      assert(OUTPUT_CLASSES.includes(c.output), `${c.name} declares no output class`);
      // The rule: what only reads is a report; anything that writes is an action (the listed exceptions aside).
      if (
        c.tier !== "read" &&
        !c.mutateWith &&
        !["vault status", "vault list", "notify watch"].includes(c.name)
      ) {
        assertEquals(c.output, "action", c.name);
      }
    }
    const byName = (n: string) => COMMANDS.filter((c) => c.name === n).map((c) => c.output);
    assertEquals(byName("update"), ["action", "action"]);
    assertEquals(byName("apply"), ["action", "action"]);
    assertEquals(byName("fleet upgrade"), ["action"]);
    assertEquals(byName("pair"), ["action"]);
    assertEquals(byName("vault backup"), ["action"]);
    assertEquals(byName("vault status"), ["report"]);
    assertEquals(byName("doctor"), ["report"]);
    assertEquals(byName("log"), ["report"]);
    assertEquals(byName("web serve"), ["report"]);
    const { GLOBAL_ARGS } = await import("../src/archon/core/registry-types.ts");
    assertEquals(
      GLOBAL_ARGS.filter((a) => ["quiet", "verbose", "json"].includes(a.name)).map((a) => a.name),
      ["json", "verbose", "quiet"],
    );
    // No command declares its own --quiet, --verbose or -q/-v: the global ones are the only ones.
    for (const c of COMMANDS) {
      for (const a of c.args) {
        assert(
          !["quiet", "verbose"].includes(a.name) && !["q", "v"].includes(a.short ?? ""),
          c.name,
        );
      }
    }
  },
);

proves(
  [
    "105-calm-output FR-003",
    "105-calm-output FR-004",
    "105-calm-output FR-006",
    "105-calm-output FR-007",
    "105-calm-output FR-009",
  ],
  "105: calm prints no green step; honest marks; a failure once, cause first, with one next command; every problem coded; raw errors off the screen",
  () => {
    // Nothing to report: a verdict and no next.
    let c = calm();
    c.ui.phase("Pull").done("up to date");
    c.ui.phase("Engine").done("the newest");
    assertEquals(c.ui.finish(), 0);
    assertEquals(c.out().trim(), "==> Up to date");
    // Marks are honest: a phase holding a ⚡ is not green, a phase holding a ⏳ neither.
    const m = new Ui({ tty: false, color: false, emoji: false, now: () => 0, write: () => {} });
    const a = m.phase("Send");
    a.action("send it", "bun run stolos apply", "E105-UNSENT");
    assertEquals(a.mark, "action");
    const w = m.phase("Email");
    w.pending("later", "bun run stolos boot mail-push alpha", "P027-MAIL-TOKEN");
    assertEquals(w.mark, "pending");
    assertEquals(m.phase("Fine").mark, "ok");
    // Counts in the verdict; the most important command is the one next line; code on every item.
    c = calm();
    const p = c.ui.phase("Send");
    p.action("Your 3 changes stay here.", "bun run stolos apply", "E105-UNSENT");
    c.ui.hint("remote-access", "Remote access is not set up.", "bun run stolos console --lan");
    c.ui.finish();
    const t = c.out();
    assertStringIncludes(t, "[you] Your 3 changes stay here. [E105-UNSENT]");
    assertStringIncludes(t, "run: bun run stolos apply");
    assertStringIncludes(t, "-> Remote access is not set up.");
    assertStringIncludes(t, "==> Up to date · 1 for you · 1 optional");
    assertEquals(t.trim().split("\n").pop(), "next: bun run stolos apply");
    assertEquals(t.split("\n").filter((l) => l.startsWith("next:")).length, 1);
    // A failure appears once (the verdict), not inline, not in a section; its fix is the one next command.
    c = calm();
    c.ui.phase("Push").fail("Nothing was sent. Your 3 files are safe.", "bun run stolos apply");
    assertEquals(c.ui.finish(), 1);
    assertEquals(c.out().split("Nothing was sent").length - 1, 1, c.out());
    assertStringIncludes(c.out(), "!! Nothing was sent. Your 3 files are safe. [E105-FAILED]");
    assertEquals(c.out().trim().split("\n").pop(), "next: bun run stolos apply");
    // A raw system error: a plain sentence and a stable code on screen, the raw text in the log and with --verbose.
    c = calm();
    c.ui.phase("Doctor").warn("EPERM: operation not permitted, unlink 'C:\\Users\\alice\\x.tmp'");
    c.ui.finish();
    assert(!c.out().includes("EPERM"), c.out());
    assertStringIncludes(c.out(), "[E105-FILE-LOCKED]");
    const v = calm({ verbose: true });
    v.ui.phase("Doctor").warn("EPERM: operation not permitted, unlink 'x.tmp'");
    v.ui.finish();
    assertStringIncludes(v.out(), "raw: EPERM: operation not permitted");
    // The same warning raised three times is shown once.
    c = calm();
    for (let i = 0; i < 3; i++)
      c.ui.phase("Doctor").warn("EPERM: operation not permitted, unlink 'x.tmp'");
    c.ui.finish();
    assertEquals(c.out().split("[E105-FILE-LOCKED]").length - 1, 1, c.out());
    for (const code of [
      "E105-FAILED",
      "E105-WARNING",
      "E105-YOURS",
      "P105-WAITING",
      "E105-SIGN-PASSPHRASE",
      "E105-FILE-LOCKED",
      "E105-UNSENT",
      "E105-BACKUP",
      "E105-OPERATOR",
    ]) {
      assert(EXPLAIN[code], `${code} is not explained`);
    }
  },
);

proves(
  ["105-calm-output FR-002", "105-calm-output FR-003", "105-calm-output FR-005"],
  "105: --quiet is one verdict line; --verbose brings the green steps back; a nested run prints nothing and hands its problems to its parent once; progress leaves no residue",
  async () => {
    const q = calm({ mode: "quiet", quiet: true });
    q.ui.header("Stolos update", "lab");
    q.ui.phase("Pull").warn("a warning");
    q.ui.finish();
    assertEquals(q.out().trim(), "==> Up to date · 1 warning", "no header, one verdict line");
    // (--quiet writes its one line to the screen's own writer; a custom writer gets it too.)
    const qq = calm();
    qq.ui.setMode("quiet");
    qq.ui.phase("Pull").done("up to date");
    qq.ui.finish();
    assertEquals(qq.out().trim().split("\n").length, 1);
    assertStringIncludes(qq.out(), "Up to date");
    const v = calm({ mode: "verbose" });
    v.ui.phase("Pull").done("up to date");
    v.ui.finish();
    assertStringIncludes(v.out(), "[ok] Pull");
    // Nested: no header, no summary, nothing at all; the problems travel in the summary file.
    const dir = await fs.makeTempDir({ prefix: "archon-calm-sum-" });
    const file = path.join(dir, "summary.json");
    const was = [proc.env.get("STOLOS_NESTED"), proc.env.get("STOLOS_SUMMARY")];
    try {
      proc.env.set("STOLOS_NESTED", "calm");
      proc.env.set("STOLOS_SUMMARY", file);
      const child = calm();
      child.ui.header("Stolos apply", "lab");
      const p = child.ui.phase("Signing");
      p.fail(
        "That passphrase didn't unlock your daily key, three times.",
        "bun run stolos apply",
        "E105-SIGN-PASSPHRASE",
      );
      p.done();
      child.ui.outcome("Sent: x");
      assertEquals(child.ui.finish({ next: ["next: x"] }), 1);
      assertEquals(child.out(), "", "a nested run prints nothing");
      proc.env.delete("STOLOS_NESTED");
      const sum = readSummary(await fs.readTextFile(file));
      assertEquals(sum.problems.length, 1);
      assertEquals(sum.outcomes, ["Sent: x"]);
      const parent = calm();
      const ph = parent.ui.phase("Send");
      ph.merge(sum.problems, sum.outcomes);
      ph.done();
      parent.ui.finish();
      assertEquals(parent.out().split("didn't unlock").length - 1, 1, parent.out());
      assertEquals(readSummary("not json").problems, []);
    } finally {
      for (const [k, val] of [
        ["STOLOS_NESTED", was[0]],
        ["STOLOS_SUMMARY", was[1]],
      ] as const) {
        if (val === undefined) proc.env.delete(k);
        else proc.env.set(k, val);
      }
      await fs.remove(dir, { recursive: true });
    }
    // Progress on a terminal leaves nothing behind: the last thing written clears the line.
    let text = "";
    const t = new Ui({
      tty: true,
      color: false,
      emoji: false,
      mode: "calm",
      hintsFile: null,
      now: () => 0,
      write: (s) => (text += s),
    });
    t.phase("Files").step(3, 12, "x");
    t.finish();
    assert(text.includes("3/12"), text);
    assert(
      text.lastIndexOf("3/12") < text.lastIndexOf("\r\x1b[2K"),
      "the last thing written clears the line",
    );
  },
);

proves(
  ["105-calm-output FR-008"],
  "105: an optional feature that is off is a hint, shown once per 7 days (a fake clock), always with --verbose, never with --quiet",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-calm-hint-" });
    const file = path.join(dir, "hints.json");
    const was = proc.env.get("STOLOS_HINT_NOW");
    const day = 86_400_000;
    const run = (now: number, mode: "calm" | "verbose" | "quiet"): string => {
      proc.env.set("STOLOS_HINT_NOW", String(now));
      const c = calm({ hintsFile: file, mode });
      c.ui
        .phase("Remote access")
        .hint("remote-access", "Remote access is not set up.", "bun run stolos console --lan");
      c.ui.finish();
      return c.out();
    };
    try {
      const t0 = 1_800_000_000_000;
      assertStringIncludes(run(t0, "calm"), "Remote access is not set up.");
      assertStringIncludes(
        run(t0, "calm"),
        "Up to date\n",
        "the second time within 7 days: not shown",
      );
      assert(!run(t0 + 3 * day, "calm").includes("Remote access"), "3 days later: quiet");
      assert(run(t0 + 3 * day, "verbose").includes("Remote access"), "--verbose always shows it");
      assert(!run(t0 + 3 * day, "quiet").includes("Remote access"), "--quiet never");
      assertStringIncludes(run(t0 + 8 * day, "calm"), "Remote access is not set up.");
      assert(!(await fs.readTextFile(file)).includes("Remote"), "only ids and times are kept");
      // The hint is not a problem: no mark of waiting, and the exit code is 0.
      assert(!run(t0 + 9 * day, "calm").includes("[todo]"));
    } finally {
      if (was === undefined) proc.env.delete("STOLOS_HINT_NOW");
      else proc.env.set("STOLOS_HINT_NOW", was);
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["105-calm-output FR-011", "105-calm-output FR-016", "105-calm-output FR-017"],
  "105: a command line holds only the command; what's new is five deduplicated bullets and the operator actions; secrets are named by machine",
  async () => {
    assertEquals(splitFix("bun run stolos vault backup, then move the ZIP somewhere safe"), {
      cmd: "bun run stolos vault backup",
      say: "Move the ZIP somewhere safe",
    });
    assertEquals(splitFix("bun run stolos apply"), { cmd: "bun run stolos apply" });
    assertEquals(splitFix("bun run stolos apply (it lists those commits)"), {
      cmd: "bun run stolos apply",
      say: "It lists those commits",
    });
    assertEquals(splitFix("check the network, then run this again"), {
      say: "check the network, then run this again",
    });
    assertEquals(splitFix(undefined), {});
    // What's new.
    assertEquals(
      tidySubject("spec 103-three-ports: pairing at /device/pair (#12)"),
      "103-three-ports: pairing at /device/pair",
    );
    const w = summarizeCommits([
      "a: one",
      "a: one",
      "b: two\n\nOperator action: run bun run stolos vault backup",
      "c: three",
      "d: four",
      "e: five",
      "f: six",
    ]);
    assertEquals(w.bullets.length, 5);
    assertEquals(w.bullets[0], "f: six", "newest first");
    assertEquals(w.actions, ["run bun run stolos vault backup"]);
    // The secrets reminder in words.
    const { secretsInWords } = await import("../src/archon/vault/panel.ts");
    const secret = (name: string) => ({
      name,
      changedAt: "2026-11-17T00:00:00Z",
      size: 1,
      sha256: "x",
    });
    const a = {
      severity: "amber" as const,
      unbacked: ["hosts/intrepid/probe.key", "hosts/olympia/deploy-key", "hosts/a/deploy-key"].map(
        secret,
      ),
      removed: [],
    };
    // Whatever the inventory calls them, two are named and the rest counted.
    const words = secretsInWords(a as never);
    assert(/more$/.test(words) && words.split(",").length === 3, words);
  },
);

proves(
  [
    "105-calm-output FR-001",
    "105-calm-output FR-002",
    "105-calm-output FR-008",
    "105-calm-output FR-018",
  ],
  "105: a report (boot doctor) stays verbose by default, one header, the off feature as a hint; --quiet is one line and the exit code",
  async () => {
    const f = await fleet();
    try {
      const { stolos } = f;
      const r = await stolos(["boot", "doctor"]);
      const lines = r.out.split("\n");
      // Every phase is a line, as before.
      for (const phase of [
        "Checkout",
        "Model",
        "Signing keys",
        "Secrets",
        "Network",
        "Firewall",
        "Remote access",
      ]) {
        assert(
          lines.some((l) => new RegExp(`^\\[(ok|warn|FAIL|you|todo)\\] ${phase}\\b`).test(l)),
          `${phase}\n${r.out}`,
        );
      }
      assertEquals(lines.filter((l) => /Stolos boot doctor/.test(l)).length, 1, r.out);
      // Remote access that is merely off is a hint (👉, "->" in ASCII), not a waiting item.
      assertStringIncludes(
        r.out,
        "-> The Stolos Console answers on this PC only: remote access is not set up.",
      );
      assert(!/\[todo\] .*remote access/i.test(r.out), r.out);
      assert(!/all well/.test(r.out), r.out);
      const q = await stolos(["boot", "doctor", "--quiet"]);
      assertEquals(q.code, r.code, "the same exit code");
      assertEquals(q.out.trim().split("\n").length, 1, q.out);
      assert(!q.out.includes("Remote access"), "never a hint with --quiet");
      const v = await stolos(["where", "-q"]);
      assertEquals(v.out.trim().split("\n").length, 1, v.out);
    } finally {
      await fs.remove(f.sb.home, { recursive: true });
    }
  },
  { timeout: 180_000 },
);
