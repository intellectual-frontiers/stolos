/**
 * Root's side of a host, through the seam of `core/paths.ts` (`ARCHON_ROOT`, tests/host.ts): the
 * fixed host paths resolve inside a temporary root, the run is root's, and the programs archon runs
 * are stand-ins. Specs 004 (the boot log), 013 (the daily report, its mail, MCP resources), 014 (the
 * prompt's status line), 016 (backup mail), 017 (guests), 019 (run logs kept 30 days), 024
 * (discovery as observe shows it), 095 (the daily report's drift).
 *
 * @module
 */
import { fs, path, serve } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { attachmentText, HOST_ROOT_SKIP, hostRoot } from "./host.ts";
import { host } from "./fixtures.ts";
import type { GuestDef } from "../src/archon/model/types.ts";

const today = (): string => new Date().toISOString().slice(0, 10);
const days = (n: number): Date => new Date(Date.now() - n * 86_400_000);

proves(
  ["004-install FR-017"],
  "004: boot serve writes its log to boot.log in the boot cache, keeping one previous copy past 5 MB",
  async () => {
    const { openBootLog, BOOT_LOG_MAX_BYTES } = await import("../src/archon-boot/boot-log.ts");
    const { P } = await import("../src/archon/core/paths.ts");
    assertEquals(path.basename(P.bootCache), "boot", "the boot cache is the default folder");
    const dir = await fs.makeTempDir({ prefix: "archon-boot-log-" });
    try {
      const a = await openBootLog(dir);
      assertEquals(a.path, path.join(dir, "boot.log"));
      a.write("alpha: First boot");
      const first = await fs.readTextFile(a.path);
      assertStringIncludes(first, "== boot serve started");
      assertStringIncludes(first, "alpha: First boot\n");
      // Under 5 MB: the next start appends.
      await openBootLog(dir);
      assert(!(await fs.exists(`${a.path}.1`)), "no rotation under 5 MB");
      // Past 5 MB: the old log becomes boot.log.1 (one copy), and a new one starts.
      await fs.writeTextFile(a.path, "x".repeat(BOOT_LOG_MAX_BYTES + 1));
      await fs.writeTextFile(`${a.path}.1`, "the copy before");
      const b = await openBootLog(dir);
      b.write("beta: Ready");
      assertEquals((await fs.stat(`${a.path}.1`)).size, BOOT_LOG_MAX_BYTES + 1, "one copy kept");
      const now = await fs.readTextFile(a.path);
      assert(now.length < 1000 && now.includes("beta: Ready"), now.slice(0, 200));
      assertEquals(
        (await fs.listFiles(dir)).sort(),
        ["boot.log", "boot.log.1"],
        "never a second copy",
      );
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["019-output FR-002"],
  "019: run logs are kept 30 days: older ones are removed when a run opens its log, for root and for users",
  async () => {
    const { defaultLogPath, pruneRunLogs, RUN_LOG_DAYS } = await import("../src/archon/core/ui.ts");
    assertEquals(RUN_LOG_DAYS, 30);
    // A user's folder (~/.local/state/archon/log, or the Stolos PC's %LOCALAPPDATA%\stolos\log).
    const dir = await fs.makeTempDir({ prefix: "archon-run-logs-" });
    try {
      for (const [name, age] of [
        ["old.log", 31],
        ["recent.log", 29],
        ["today.log", 0],
      ] as const) {
        await fs.writeTextFile(path.join(dir, name), name);
        await fs.utime(path.join(dir, name), days(age), days(age));
      }
      await fs.writeTextFile(path.join(dir, "notes.txt"), "not a run log");
      await fs.utime(path.join(dir, "notes.txt"), days(90), days(90));
      assertEquals(pruneRunLogs(dir), ["old.log"]);
      assertEquals((await fs.listFiles(dir)).sort(), ["notes.txt", "recent.log", "today.log"]);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
    if (HOST_ROOT_SKIP) return;
    // Root's folder (/var/log/archon): the run that opens its log removes the old ones.
    const h = await hostRoot();
    try {
      const old = h.at("/var/log/archon/20260101T000000-1.log");
      await fs.writeTextFile(old, "old run");
      await fs.utime(old, days(40), days(40));
      const log = defaultLogPath();
      assert(log?.startsWith(h.at("/var/log/archon/")), String(log));
      assert(!(await fs.exists(old)), "a log older than 30 days is gone");
    } finally {
      await h.restore();
    }
  },
);

proves(
  ["013-ops FR-001", "013-ops FR-002", "013-ops FR-003", "095-proposals FR-005"],
  "013: report daily writes facts to /var/lib/archon/reports/daily-<date>.md, mails it once a day, and serves it over MCP; 095: it collects and includes the drift",
  async () => {
    const h = await hostRoot();
    try {
      await h.standIn(
        "systemctl",
        `case "$1" in
  --failed) echo "backup.service loaded failed failed Archon backup";;
  list-timers) echo "Mon 2026-11-16 06:23:00 UTC 6h archon-report.timer archon-report.service";;
  list-unit-files) echo "ssh.service enabled enabled";;
esac`,
      );
      await h.standIn("df", `echo "/ 100G 40G 60G 40%"`);
      await h.standIn(
        "apt",
        `echo "Listing..."; echo "openssl/noble-updates 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]"`,
      );
      // What a person installed by hand after the birth snapshot (spec 095).
      const manual = path.join(h.bin, "manual.txt");
      await fs.writeTextFile(manual, "");
      await h.standIn("apt-mark", `cat '${manual}'`);
      await fs.writeTextFile(
        h.at("/var/lib/archon/reports/tools-2026-W46.md"),
        "# Tools\n\nfd 10.2.0 ok\n",
      );
      const alpha = host();
      const { recordBirth } = await import("../src/archon/proposal/collect.ts");
      const { P } = await import("../src/archon/core/paths.ts");
      assertEquals(P.state, h.at("/var/lib/archon"), "a host keeps its state in /var/lib/archon");
      await recordBirth(alpha.name);
      await fs.writeTextFile(manual, "htop\n");

      const { COMMANDS } = await import("../src/archon/commands/registry.ts");
      const cmd = COMMANDS.find((c) => c.name === "report daily");
      assert(cmd !== undefined);
      assertEquals(await cmd.run({}, { hostName: "alpha", json: false, verbose: false }), 0);
      const file = h.at(`/var/lib/archon/reports/daily-${today()}.md`);
      const text = await fs.readTextFile(file);
      for (const want of [
        `# Daily report ${today()}: alpha`,
        "## Failed units\n\n```\nbackup.service loaded failed failed Archon backup\n```",
        "## Disk\n\n```\n/ 100G 40G 60G 40%\n```",
        "## Pending upgrades: 1",
        "archon-report.timer",
        "## Drift",
        "## Latest tools report\n\n### Tools\n\nfd 10.2.0 ok",
      ]) {
        assertStringIncludes(text, want);
      }
      assert(!/summar(y|ize)|\bAI\b/i.test(text), "facts only, no summary");
      // Spec 095: collected first (as root), then the same text archon drift prints.
      const outside = text.slice(text.indexOf("## Changes outside Stolos (spec 095)"));
      assertStringIncludes(outside, "htop");
      const { loadDrift } = await import("../src/archon/proposal/server.ts");
      const { driftText } = await import("../src/archon/proposal/drift.ts");
      const v = await loadDrift(alpha);
      assert(
        v.items.some((i) => i.name === "htop"),
        JSON.stringify(v.items),
      );
      assertStringIncludes(
        outside,
        driftText(alpha.name, v.items, v.alerts, {
          birthLate: v.birth?.late,
          collected: v.state?.at,
        }),
      );
      // The journal's line (tag archon-report).
      assert(
        (await h.calls()).some(
          (c) =>
            c.startsWith("logger -t archon-report") &&
            c.endsWith("daily report: failed units present, 1 pending upgrade(s)"),
        ),
        (await h.calls()).filter((c) => c.startsWith("logger")).join("\n"),
      );
      // Spec 013 FR-002: the host's daily email, the report attached, once per day.
      let mail = (await h.spool()).filter((q) => q.subject.includes("daily report"));
      assertEquals(mail.length, 1);
      const m = mail[0];
      assert(m !== undefined);
      assertStringIncludes(m.subject, `[Archon] alpha: daily report ${today()}`);
      assertEquals(m.key, `daily:${today()}`);
      assertEquals(attachmentText(m, `daily-${today()}.md`), text);
      assert(
        (await h.calls()).includes("systemctl start --no-block archon-notify-flush.service"),
        "the sender is started",
      );
      assertEquals(await cmd.run({}, { hostName: "alpha", json: false, verbose: false }), 0);
      mail = (await h.spool()).filter((q) => q.subject.includes("daily report"));
      assertEquals(mail.length, 1, "a second run the same day sends nothing more");
      // Spec 013 FR-003: reports are MCP resources.
      const { handle } = await import("../src/archon/mcp/server.ts");
      const list = JSON.stringify(
        await handle({ jsonrpc: "2.0", id: 1, method: "resources/list" }),
      );
      assertStringIncludes(list, `archon://reports/daily-${today()}.md`);
      assertStringIncludes(list, "archon://reports/tools-2026-W46.md");
      const read = JSON.stringify(
        await handle({
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: `archon://reports/daily-${today()}.md` },
        }),
      );
      assertStringIncludes(read, `# Daily report ${today()}: alpha`);
    } finally {
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 120_000 },
);

proves(
  ["016-backups FR-003a"],
  "016: every failed backup is mailed with its log; successful ones as one summary a week",
  async () => {
    const h = await hostRoot();
    try {
      const { backupOutcome, readHealth } = await import("../src/archon/notify/events.ts");
      const log = h.at("/var/log/archon/backup.log");
      await fs.writeTextFile(log, "restic: repository not reachable\n");
      await backupOutcome("alpha", false, "restic backup failed: repository not reachable", log);
      let mail = await h.spool();
      assertEquals(mail.length, 1);
      assertStringIncludes(mail[0]?.subject ?? "", "backup failed");
      assertEquals(
        attachmentText(mail[0] ?? ({ attachments: [] } as never), "backup.log"),
        "restic: repository not reachable\n",
      );
      // The first success this week: one summary; the next ones that week: none.
      await backupOutcome("alpha", true, "3 snapshots, 1.2 GB", null);
      await backupOutcome("alpha", true, "4 snapshots, 1.3 GB", null);
      mail = await h.spool();
      const summaries = mail.filter((q) => q.subject.includes("backups this week"));
      assertEquals(summaries.length, 1);
      assertStringIncludes(summaries[0]?.text ?? "", "3 snapshots");
      const at = (await readHealth()).backupSummaryAt;
      assert(at !== undefined, "the summary's time is kept in health.json");
      // A week later, the next summary.
      await fs.writeTextFile(
        h.at("/var/lib/archon/status/health.json"),
        JSON.stringify({ backupSummaryAt: days(8).toISOString() }),
      );
      await fs.remove(h.at("/var/spool/archon/notify/keys.json")); // and the hour of dedupe passed
      await backupOutcome("alpha", true, "5 snapshots, 1.4 GB", null);
      assertEquals(
        (await h.spool()).filter((q) => q.subject.includes("backups this week")).length,
        2,
      );
    } finally {
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 120_000 },
);

const DB: GuestDef = { name: "db", kind: "vm", image: "ubuntu:26.04", data: "durable" };
const WEB: GuestDef = { name: "web", kind: "container", image: "ubuntu:26.04", data: "ephemeral" };

proves(
  ["017-guests FR-003", "017-guests FR-005"],
  "017: archon verify checks each guest exists; guests guest sync creates are mailed",
  async () => {
    const h = await hostRoot();
    try {
      // LXD has web; db is missing until it is launched.
      const made = path.join(h.bin, "db-made");
      await h.standIn(
        "lxc",
        `case "$1" in
  list) echo '[{"name":"web","status":"Running","type":"container"}]';;
  launch) touch '${made}';;
  info) [ "$2" = web ] || [ -e '${made}' ] || { echo "Error: Instance not found" >&2; exit 1; };;
esac`,
      );
      const alpha = host({ guests: [DB, WEB] });
      const { verify } = await import("../src/archon/state/verify.ts");
      const guestChecks = async () =>
        Object.fromEntries(
          (await verify(alpha))
            .filter((c) => c.resource.startsWith("guest:"))
            .map((c) => [c.resource, c.ok]),
        );
      assertEquals(await guestChecks(), { "guest:db": false, "guest:web": true });
      const { guestSync } = await import("../src/archon/guests/guests.ts");
      assert(await guestSync(alpha));
      assertEquals(await guestChecks(), { "guest:db": true, "guest:web": true });
      const mail = (await h.spool()).filter((q) => q.subject.includes("guests created"));
      assertEquals(mail.length, 1);
      assertStringIncludes(mail[0]?.text ?? "", "db (ubuntu:26.04, VM)");
      assert(!(mail[0]?.text ?? "").includes("web ("), "only the guest it created");
      // Nothing created: nothing mailed.
      await h.standIn(
        "lxc",
        `[ "$1" = list ] && echo '[{"name":"web","status":"Running","type":"container"},{"name":"db","status":"Running","type":"virtual-machine"}]'`,
      );
      assert(await guestSync(alpha));
      assertEquals((await h.spool()).filter((q) => q.subject.includes("guests created")).length, 1);
    } finally {
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 120_000 },
);

proves(
  ["014-state FR-005"],
  "014: every archon run that records something writes the prompt's status line",
  async () => {
    const h = await hostRoot();
    try {
      await h.standIn("lxc", `[ "$1" = list ] && echo '[]'`);
      const { main } = await import("../src/archon/main.ts");
      // A mutating run (guest sync, through the CLI as root): the line follows it.
      assertEquals(await main(["guest", "sync"]), 0);
      const plain = await fs.readTextFile(h.at("/var/lib/archon/status/prompt-plain"));
      assert(/^guest sync ok(, push)?\n$/.test(plain), plain);
      const last = JSON.parse(await fs.readTextFile(h.at("/var/lib/archon/status/last.json"))) as {
        command: string;
        failures: number;
      };
      assertEquals([last.command, last.failures], ["guest sync", 0]);
      assert((await fs.readTextFile(h.at("/var/lib/archon/status/prompt"))).includes("guest sync"));
    } finally {
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 120_000 },
);

proves(
  ["024-discovery FR-006"],
  "024: archon observe shows what discovery last found (/var/lib/archon/status/otel-central.json)",
  async () => {
    const h = await hostRoot();
    try {
      const { ui } = await import("../src/archon/core/ui.ts");
      const { observe } = await import("../src/archon/observe/observe.ts");
      const { CENTRAL, lastDiscovery } = await import("../src/archon/observe/discover.ts");
      assertEquals(CENTRAL.status, "/var/lib/archon/status/otel-central.json");
      const seen: string[] = [];
      const before = ui.onPhaseEnd;
      ui.onPhaseEnd = (name, _level, summary) => void seen.push(`${name}: ${summary}`);
      const quiet = ui.quiet;
      ui.quiet = true;
      try {
        await observe(host());
        assertStringIncludes(seen.join("\n"), "no central collector found: local only");
        await fs.writeTextFile(
          h.at(CENTRAL.status),
          JSON.stringify({ endpoint: "http://otel.localdomain:4318", source: "dns" }),
        );
        assertEquals((await lastDiscovery())?.endpoint, "http://otel.localdomain:4318");
        seen.length = 0;
        await observe(host());
        assertStringIncludes(
          seen.join("\n"),
          "forwarding to http://otel.localdomain:4318 (found by dns)",
        );
      } finally {
        if (before) ui.onPhaseEnd = before;
        else delete ui.onPhaseEnd;
        ui.quiet = quiet;
      }
    } finally {
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 120_000 },
);

proves(
  ["005-first-boot FR-004", "009-updates FR-004"],
  "005/009: a first boot ends with Ready to the boot server's window, removes the report URL, and starts Ubuntu's daily apt run in the background",
  async () => {
    const h = await hostRoot();
    const events: unknown[] = [];
    const server = await serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
      events.push(await req.json());
      return new Response("");
    });
    try {
      // The install left the boot server's event URL; no relay token here (no mail is sent).
      await fs.remove(h.at("/etc/postfix/sasl_passwd"));
      const url = `http://127.0.0.1:${server.addr.port}/event`;
      await fs.writeTextFile(h.at("/etc/archon/boot-events"), `${url}\n`);
      const { bootEvent } = await import("../src/archon/install/report.ts");
      const { endFirstBoot } = await import("../src/archon/install/first-boot.ts");
      await endFirstBoot(host(), {
        failed: 0,
        tally: { passed: 40, total: 40, pending: 2 },
        head: "abc1234",
        pending: [bootEvent({ phase: "Verify", level: "ok", summary: "40 passed" })],
      });
      assertEquals(
        events.map((e) => (e as { phase?: string }).phase),
        ["Verify", "Ready"],
        JSON.stringify(events),
      );
      assertStringIncludes(
        JSON.stringify(events[1]),
        "40/40 checks · 2 not set up yet · ssh alpha",
      );
      assert(!(await fs.exists(h.at("/etc/archon/boot-events"))), "the report URL is removed");
      // Nothing more reaches the boot server once the URL is gone.
      await bootEvent({ phase: "late" });
      assertEquals(events.length, 2);
      const calls = await h.calls();
      assertEquals(
        calls.at(-1),
        "systemctl start --no-block apt-daily.service apt-daily-upgrade.service",
        "the last step: Ubuntu's daily run, in the background (--no-block)",
      );
    } finally {
      await server.shutdown();
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 120_000 },
);
