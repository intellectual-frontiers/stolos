/**
 * Spec 019: a run's output: one line per phase, progress, problems with their fix and run-log line
 * again under "Needs attention"; -v, --json, ARCHON_PLAIN and NO_COLOR.
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
import { Ui } from "../src/archon/core/ui.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

/** A Ui that writes into a string, on a fixed clock. */
function captured(o: ConstructorParameters<typeof Ui>[0] = {}): { ui: Ui; out: () => string } {
  let text = "";
  const ui = new Ui({
    tty: false,
    color: false,
    emoji: false,
    now: () => 0,
    write: (s) => (text += s),
    ...o,
  });
  return { ui, out: () => text };
}

proves(
  ["019-output FR-001"],
  "019: one line per phase with a mark and a result; progress; each problem with its fix and log line, again under Needs attention",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-ui-test-" });
    try {
      const log = path.join(dir, "run.log");
      const { ui, out } = captured({ logPath: log });
      const p = ui.phase("Packages");
      p.change("install tmux");
      p.change("install fish");
      p.done();
      const f = ui.phase("Files");
      f.ok("/etc/archon/host");
      f.fail("/etc/ssh/sshd_config.d/50-archon.conf: sshd -t failed", "sshd -t shows the line");
      f.done();
      const v = ui.phase("Verify");
      v.warn("dns:ipv4: no answer", "check the router's upstream DNS");
      v.done("41/42 checks");
      assertEquals(ui.finish(), 1, "a failure is exit code 1");
      const lines = out().split("\n");
      // One line per phase: its mark, its name, its result.
      assert(
        lines.some((l) => /^\[ok\] Packages +2 changed$/.test(l)),
        out(),
      );
      assert(
        lines.some((l) => /^\[FAIL\] Files +1 failed$/.test(l)),
        out(),
      );
      assert(
        lines.some((l) => /^\[warn\] Verify +41\/42 checks$/.test(l)),
        out(),
      );
      // Items already right are not listed (they are in the log).
      assert(!out().includes("/etc/archon/host"));
      // The problem when it happens, and again at the end with its fix and its line in the run log.
      const at = lines.indexOf("== Needs attention ========================================");
      assert(at > 0, out());
      const end = lines.slice(at).join("\n");
      assertStringIncludes(
        end,
        "[FAIL] files          /etc/ssh/sshd_config.d/50-archon.conf: sshd -t failed",
      );
      assertStringIncludes(end, "fix: sshd -t shows the line");
      assertStringIncludes(end, "[warn] verify         dns:ipv4: no answer");
      const logLine = end.match(/log: (.+):(\d+)/);
      assert(logLine !== null, end);
      assertEquals(logLine[1], log);
      const logged = (await fs.readTextFile(log)).split("\n")[Number(logLine[2]) - 1] ?? "";
      assertStringIncludes(logged, "FAIL /etc/ssh/sshd_config.d/50-archon.conf: sshd -t failed");
      // Progress while working: a bar with n of total, redrawn in place on a terminal.
      const t = captured({ tty: true });
      t.ui.phase("Tools").step(3, 12, "chezmoi");
      assertStringIncludes(t.out(), "3/12");
      assertStringIncludes(t.out(), "chezmoi");
      assertStringIncludes(t.out(), "\r\x1b[2K");
      t.ui.finish();
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["019-output FR-003"],
  "019: -v shows every item, --json prints nothing but the data, ARCHON_PLAIN gives ASCII marks, NO_COLOR no color",
  async () => {
    // -v: every item, dimmed, as it happens.
    const v = captured({ verbose: true });
    const p = v.ui.phase("Files");
    p.ok("/etc/archon/host");
    p.change("write /etc/ssh/ssh_known_hosts");
    p.done();
    assertStringIncludes(v.out(), "/etc/archon/host");
    assertStringIncludes(v.out(), "~ write /etc/ssh/ssh_known_hosts");
    // ARCHON_PLAIN and NO_COLOR, from the environment (FORCE_COLOR would turn color on).
    const keep = [
      "ARCHON_PLAIN",
      "ARCHON_EMOJI",
      "NO_COLOR",
      "FORCE_COLOR",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
    ].map((k) => [k, proc.env.get(k)] as const);
    try {
      for (const [k] of keep) proc.env.delete(k);
      proc.env.set("LANG", "en_US.UTF-8");
      proc.env.set("FORCE_COLOR", "1");
      const rich = new Ui({ tty: false, write: () => {} });
      assertEquals([rich.emoji, rich.color], [true, true]);
      proc.env.set("ARCHON_PLAIN", "1");
      proc.env.set("NO_COLOR", "1");
      let text = "";
      const plain = new Ui({ tty: false, now: () => 0, write: (s) => (text += s) });
      assertEquals([plain.emoji, plain.color], [false, false]);
      plain.phase("Model").done("valid");
      plain.finish();
      assert(/^\[ok\] Model/m.test(text), text);
      assert(!text.includes("\u001b["), "no escape codes");
      assert(
        [...text].every((c) => c.charCodeAt(0) < 128),
        "ASCII only",
      );
    } finally {
      for (const [k, val] of keep) {
        if (val === undefined) proc.env.delete(k);
        else proc.env.set(k, val);
      }
    }
    // --json: the command's data only; the run's lines stay in the log.
    const sb = await sandbox("archon-json-test-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await fs.copy(
        path.join(ENGINE_ROOT, "examples", "fleets", "lab"),
        path.join(repo, "fleets", "lab"),
      );
      await linkEngine(repo);
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      const main = path.join(ENGINE_ROOT, "src", "stolos", "main.ts");
      const shown = await sb.run(main, ["validate"], "", env);
      assertEquals(shown.code, 0, shown.out);
      assertStringIncludes(shown.out, "Model");
      const json = await sb.run(main, ["validate", "--json"], "", env);
      assertEquals(json.code, 0, json.out);
      assertEquals(json.out.trim(), "");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);
