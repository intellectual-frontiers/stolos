/**
 * Spec 009: surviving flaky upstream DNS on an IPv4-only network.
 *
 * @module
 */
import { fs } from "@intellectual-frontiers/system";
import {
  assertExists,
  assert,
  assertEquals,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { ui } from "../src/archon/core/ui.ts";
import {
  aptDeps,
  aptInstall,
  aptUpdate,
  ARCHIVE_UNREACHABLE,
  classifyAptLine,
} from "../src/archon/apply/apt.ts";
import { settleInstallRecord } from "../src/archon/apply/apply.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";

// What alpha' apt printed on 2026-11-11 when an A lookup failed upstream.
const DNS_FAILURE = [
  "Ign:1 http://archive.ubuntu.com/ubuntu resolute InRelease",
  "Err:1 http://archive.ubuntu.com/ubuntu resolute InRelease",
  "  Cannot initiate the connection to archive.ubuntu.com:80 (2620:2d:4000:1::102). - connect (101: Network is unreachable)",
  "E: The repository 'http://archive.ubuntu.com/ubuntu resolute Release' no longer has a Release file.",
  "W: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/resolute/InRelease  Temporary failure resolving 'archive.ubuntu.com'",
];

/** Replace apt with a script of runs: each is the lines it prints and its exit code. */
function fakeApt(runs: Array<{ lines: string[]; code: number }>): {
  calls: string[][];
  sleeps: number[];
  restore: () => void;
} {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const real = { ...aptDeps };
  aptDeps.stream = (argv, o) => {
    calls.push([...argv]);
    const r = runs[Math.min(calls.length - 1, runs.length - 1)] ?? { lines: [], code: 0 };
    for (const l of r.lines) o.onLine?.(l, "stdout");
    return Promise.resolve(r.code);
  };
  aptDeps.sleep = (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { calls, sleeps, restore: () => Object.assign(aptDeps, real) };
}

const problemsSince = (n: number) => ui.problems.slice(n);

proves(
  ["009-updates FR-006"],
  "network-shaped apt lines are warnings that say the next reconcile retries",
  () => {
    for (const l of DNS_FAILURE.filter((x) => /^(E|W):/.test(x) && /resolving/.test(x))) {
      const i = classifyAptLine(l);
      assertExists(i);
      assertEquals(i.level, "warn");
      assert(i.network);
      assertEquals(i.message, ARCHIVE_UNREACHABLE);
    }
  },
);

proves(
  ["009-updates FR-006"],
  "apt-get update: a DNS failure is retried with backoff and recovers",
  async () => {
    ui.quiet = true;
    const f = fakeApt([
      { lines: DNS_FAILURE, code: 100 },
      {
        lines: ["Hit:1 http://archive.ubuntu.com/ubuntu resolute InRelease"],
        code: 0,
      },
    ]);
    const before = ui.problems.length;
    try {
      const r = await aptUpdate(ui.phase("Packages"));
      assertEquals(r, { ok: true, network: false });
      assertEquals(f.sleeps, [10_000]);
      assertEquals(problemsSince(before), []);
    } finally {
      f.restore();
    }
  },
);

proves(
  ["009-updates FR-006"],
  "apt-get update: a DNS failure that persists is a WARN, never a FAIL",
  async () => {
    ui.quiet = true;
    const f = fakeApt([{ lines: DNS_FAILURE, code: 100 }]);
    const before = ui.problems.length;
    try {
      const r = await aptUpdate(ui.phase("Packages"));
      assertEquals(r, { ok: false, network: true });
      assertEquals(f.sleeps, [10_000, 30_000, 60_000]);
      const p = problemsSince(before);
      assertEquals(
        p.map((x) => x.level),
        ["warn"],
      );
      assertEquals(p[0]?.message, ARCHIVE_UNREACHABLE);
    } finally {
      f.restore();
    }
  },
);

proves(
  ["009-updates FR-006"],
  "apt-get update: a real repository error is still a FAIL, without network retries",
  async () => {
    ui.quiet = true;
    const f = fakeApt([
      {
        lines: [
          "E: The repository 'http://example/ubuntu x Release' does not have a Release file.",
        ],
        code: 100,
      },
    ]);
    const before = ui.problems.length;
    try {
      const r = await aptUpdate(ui.phase("Packages"));
      assertEquals(r.ok, false);
      assertEquals(r.network, false);
      assertEquals(f.sleeps, []);
      assert(problemsSince(before).some((x) => x.level === "fail"));
    } finally {
      f.restore();
    }
  },
);

proves(
  ["009-updates FR-006"],
  "apt-get install: downloads lost to DNS are a WARN; dpkg failures stay FAILs",
  async () => {
    ui.quiet = true;
    const f = fakeApt([
      {
        lines: [
          "Err:1 http://archive.ubuntu.com/ubuntu resolute/main amd64 btop amd64 1.4.6-1",
          "  Temporary failure resolving 'archive.ubuntu.com'",
          "E: Failed to fetch http://archive.ubuntu.com/ubuntu/pool/main/b/btop/btop_1.4.6-1_amd64.deb  Temporary failure resolving 'archive.ubuntu.com'",
          "E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?",
        ],
        code: 100,
      },
    ]);
    const before = ui.problems.length;
    try {
      const r = await aptInstall(ui.phase("Packages"), ["btop"]);
      assertEquals(r, { ok: false, network: true });
      assertEquals(
        problemsSince(before).map((x) => x.level),
        ["warn"],
      );
    } finally {
      f.restore();
    }
  },
);

proves(
  ["009-updates FR-005"],
  "network.ipv6 false renders 52archon-network (IPv4 only, retries); hosts may override",
  () => {
    const file = (p: ReturnType<typeof resolvePlan>) =>
      p.files.find((f) => f.path === "/etc/apt/apt.conf.d/52archon-network")?.content;
    const v4 = file(resolvePlan(host(), { ...fleet(), network: { ipv6: false } }));
    assertExists(v4);
    assert(v4.includes('Acquire::ForceIPv4 "true";') && v4.includes('Acquire::Retries "5";'));
    assert(
      v4.includes('Acquire::http::Timeout "30";') && v4.includes('Acquire::https::Timeout "30";'),
    );
    assertEquals(file(resolvePlan(host(), fleet())), undefined);
    assertEquals(
      file(resolvePlan({ ...host(), ipv6: true }, { ...fleet(), network: { ipv6: false } })),
      undefined,
    );
    const checks = resolvePlan(host(), fleet()).checks;
    assertEquals(checks.find((c) => c.name === "dns:ipv4")?.level, "warn");
    assertEquals(checks.find((c) => c.name === "apt:ipv4-only")?.level, "warn");
  },
);

proves(
  ["009-updates FR-008"],
  "a successful apply settles an install record left at ok: false",
  async () => {
    const dir = await fs.makeTempDir();
    const { getRecord, putRecord } = await import("../src/archon/state/store.ts");
    await putRecord(
      "alpha",
      "install",
      "install",
      {
        host: "alpha",
        ok: false,
        problems: [{ level: "fail", message: "apt: Could not get lock" }],
      },
      dir,
    );
    assert(await settleInstallRecord("alpha", dir));
    type Install = { ok: boolean; problems: unknown[]; resolved: { problems: unknown[] } };
    const rec = (await getRecord<Install>("alpha", "install", "install", dir))?.body;
    assertEquals(rec?.ok, true);
    assertEquals(rec?.problems, []);
    assertEquals(rec?.resolved.problems.length, 1);
    assert(!(await settleInstallRecord("alpha", dir))); // already ok: untouched
    await fs.remove(dir, { recursive: true });
  },
);
