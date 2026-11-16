/**
 * Spec 016: daily zstd archives into Ubuntu's backup location, kept to a number, overridable per
 * host; restore-tests of the newest, and restores into a folder, never in place.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { backupPolicy, DEFAULT_BACKUP } from "../src/archon/capabilities/backup.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";
const zstd = proc.which("zstd") !== undefined;
/** GNU tar, as the hosts have it (macOS's bsdtar has no --warning=, --acls means another thing). */
const gnuTar = proc.build.os === "linux";

proves(
  ["016-backups FR-001"],
  "016: daily (02:37) zstd tar archives of the host's state into /var/backups/archon, 14 kept, per host overrides",
  async () => {
    // The defaults: Ubuntu's backup location, the host's own state and LXD's database, 14, 02:37.
    assertEquals(DEFAULT_BACKUP.target, "/var/backups/archon");
    for (const p of [
      "/etc",
      "/home",
      "/root",
      "/var/lib/archon",
      "/var/snap/lxd/common/lxd/database",
    ]) {
      assert(DEFAULT_BACKUP.paths.includes(p), p);
    }
    assertEquals([DEFAULT_BACKUP.keep, DEFAULT_BACKUP.onCalendar], [14, "*-*-* 02:37:00"]);
    const plan = resolvePlan(host(), fleet());
    const t = plan.units.find((u) => u.unitName === "archon-backup.timer");
    assertExists(t);
    assertEquals(t.state, "enabled");
    assertStringIncludes(t.content ?? "", "OnCalendar=*-*-* 02:37:00");
    assertStringIncludes(
      plan.units.find((u) => u.unitName === "archon-backup.service")?.content ?? "",
      "ExecStart=/usr/local/bin/archon backup run",
    );
    // A host overrides paths, target, retention, and schedule.
    const own = backupPolicy(
      host({
        backup: {
          paths: ["/srv/data"],
          target: "/srv/backups",
          keep: 3,
          onCalendar: "*-*-* 01:00:00",
        },
      }),
    );
    assertEquals(
      [own.paths, own.target, own.keep, own.onCalendar],
      [["/srv/data"], "/srv/backups", 3, "*-*-* 01:00:00"],
    );
    const t2 = resolvePlan(host({ backup: { onCalendar: "*-*-* 01:00:00" } }), fleet()).units.find(
      (u) => u.unitName === "archon-backup.timer",
    );
    assertStringIncludes(t2?.content ?? "", "OnCalendar=*-*-* 01:00:00");

    // backup run, for real, as on a host (Ubuntu, GNU tar's options): zstd tar archives in the
    // target, the oldest pruned past `keep`.
    if (!zstd || !gnuTar) return;
    const sb = await sandbox("archon-backup-test-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await fs.copy(
        path.join(ENGINE_ROOT, "examples", "fleets", "lab"),
        path.join(repo, "fleets", "lab"),
      );
      await linkEngine(repo);
      const data = path.join(sb.home, "data-to-keep");
      const target = path.join(sb.home, "backups");
      await fs.mkdir(data);
      await fs.writeTextFile(path.join(data, "notes.txt"), "kept\n");
      const alpha = path.join(repo, "fleets", "lab", "hosts", "alpha", "host.ts");
      await fs.writeTextFile(
        alpha,
        (await fs.readTextFile(alpha)).replace(
          'spec: "004-install",',
          `spec: "004-install",\n  backup: { paths: [${JSON.stringify(data)}], target: ${JSON.stringify(target)}, keep: 2 },`,
        ),
      );
      const probe = path.join(sb.home, "backup.ts");
      const src = (rel: string) =>
        JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, "src", "archon", rel)).href);
      await fs.writeTextFile(
        probe,
        `import { backupRun } from ${src("backup/backup.ts")};
import { loadHosts } from ${src("model/load.ts")};
const alpha = (await loadHosts()).find((h) => h.name === "alpha");
const runs = [];
for (let i = 0; i < 3; i++) { runs.push((await backupRun(alpha)).archive); await new Promise((r) => setTimeout(r, 20)); }
console.log(JSON.stringify(runs));`,
      );
      const r = await sb.run(probe, [], "", { ARCHON_REPO: repo, ARCHON_FLEET: "lab" });
      assertEquals(r.code, 0, r.out);
      const runs = JSON.parse(r.out.trim().split("\n").pop() ?? "[]") as string[];
      const kept = (await fs.listFiles(target, ".tar.zst")).sort();
      assertEquals(
        kept,
        runs
          .slice(1)
          .map((p) => path.basename(p))
          .sort(),
        "the newest 2 kept",
      );
      for (const a of kept) assert(/^alpha-.+\.tar\.zst$/.test(a), a);
      const list = await proc.run(["tar", "--zstd", "-tf", path.join(target, kept[0] ?? "")]);
      assertStringIncludes(list.stdout, "data-to-keep/notes.txt");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["016-backups FR-002"],
  "016: backup verify restore-tests the newest archive; backup restore extracts into a folder, never in place",
  async () => {
    const sb = await sandbox("archon-restore-test-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await fs.copy(
        path.join(ENGINE_ROOT, "examples", "fleets", "lab"),
        path.join(repo, "fleets", "lab"),
      );
      await linkEngine(repo);
      const target = path.join(sb.home, "backups");
      await fs.mkdir(target);
      const alpha = path.join(repo, "fleets", "lab", "hosts", "alpha", "host.ts");
      await fs.writeTextFile(
        alpha,
        (await fs.readTextFile(alpha)).replace(
          'spec: "004-install",',
          `spec: "004-install",\n  backup: { target: ${JSON.stringify(target)} },`,
        ),
      );
      // Two archives as backup run writes them: the older names beta, the newest names alpha.
      const make = async (name: string, marker: string) => {
        const root = path.join(sb.home, `root-${name}`);
        await fs.mkdir(path.join(root, "etc", "archon"), { recursive: true });
        await fs.writeTextFile(path.join(root, "etc", "archon", "host"), `${marker}\n`);
        const r = await proc.run([
          "tar",
          "--zstd",
          "-cf",
          path.join(target, name),
          "-C",
          root,
          "etc",
        ]);
        assertEquals(r.code, 0, r.stderr);
      };
      await make("alpha-2026-11-01T02-37-00-000Z.tar.zst", "beta");
      await make("alpha-2026-11-02T02-37-00-000Z.tar.zst", "alpha");
      const probe = path.join(sb.home, "verify.ts");
      const src = (rel: string) =>
        JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, "src", "archon", rel)).href);
      const out = path.join(sb.home, "inspect");
      await fs.writeTextFile(
        probe,
        `import { backupRestore, backupVerify } from ${src("backup/backup.ts")};
import { loadHosts } from ${src("model/load.ts")};
const alpha = (await loadHosts()).find((h) => h.name === "alpha");
const v = await backupVerify(alpha);
const r = await backupRestore(alpha, "alpha-2026-11-01T02-37-00-000Z.tar.zst", ${JSON.stringify(out)});
console.log(JSON.stringify({ ok: v.ok, reason: v.reason, archive: v.archive, dir: r.dir }));`,
      );
      const r = await sb.run(probe, [], "", { ARCHON_REPO: repo, ARCHON_FLEET: "lab" });
      assertEquals(r.code, 0, r.out);
      const got = JSON.parse(r.out.trim().split("\n").pop() ?? "{}") as {
        ok: boolean;
        reason: string;
        archive: string;
        dir: string;
      };
      // The newest was tested, and it restores this host's marker.
      assertEquals([got.ok, got.reason], [true, ""]);
      assertEquals(got.archive, path.join(target, "alpha-2026-11-02T02-37-00-000Z.tar.zst"));
      // The restore went into <to>/<archive name>, to inspect.
      assertEquals(got.dir, path.join(out, "alpha-2026-11-01T02-37-00-000Z"));
      assertEquals(await fs.readTextFile(path.join(got.dir, "etc", "archon", "host")), "beta\n");
      // A newest archive of another machine fails the restore test.
      await make("alpha-2026-11-03T02-37-00-000Z.tar.zst", "gamma");
      const again = await sb.run(probe, [], "", { ARCHON_REPO: repo, ARCHON_FLEET: "lab" });
      assertStringIncludes(again.out, "restored host marker 'gamma' != 'alpha'");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { skip: posix && zstd ? false : "tar with zstd" },
);
