/**
 * Spec 015: the reconcile timer, the checkout's fast-forward (only a clean checkout, only to a tip
 * that comes after it), and one host-changing run at a time.
 *
 * @module
 */
import { fs, lock, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { hostLock, LOCK_HELD_ENV, LOCK_PATH } from "../src/archon/core/lock.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";
const ID = ["-c", "user.name=Alice Example", "-c", "user.email=alice@example.net"];

proves(
  ["015-reconcile FR-001"],
  "015: reconcile runs every 15 minutes; it fast-forwards a clean checkout and applies only at the remote's tip",
  async () => {
    const plan = resolvePlan(host(), fleet());
    const t = plan.units.find((u) => u.unitName === "archon-reconcile.timer");
    assertExists(t);
    assertEquals(t.state, "enabled");
    assertStringIncludes(t.content ?? "", "OnCalendar=*:0/15");
    const s = plan.units.find((u) => u.unitName === "archon-reconcile.service");
    assertStringIncludes(s?.content ?? "", "ExecStart=/usr/local/bin/archon reconcile");

    const sb = await sandbox("archon-reconcile-test-");
    try {
      const git = async (dir: string, ...args: string[]) => {
        const r = await proc.run(["git", "-C", dir, ...ID, ...args]);
        assertEquals(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
        return r.stdout.trim();
      };
      // The fleet's repository (origin), the host's checkout, and a PC's clone that pushes.
      const origin = path.join(sb.home, "origin.git");
      const seed = path.join(sb.home, "seed");
      await fs.mkdir(path.join(seed, "fleets"), { recursive: true });
      await fs.copy(
        path.join(ENGINE_ROOT, "examples", "fleets", "lab"),
        path.join(seed, "fleets", "lab"),
      );
      await git(sb.home, "init", "-q", "--bare", "-b", "main", origin);
      await git(seed, "init", "-q", "-b", "main");
      await git(seed, "add", "fleets");
      await git(seed, "commit", "-q", "-m", "lab");
      await git(seed, "remote", "add", "origin", origin);
      await git(seed, "push", "-q", "origin", "main");
      const checkout = path.join(sb.home, "srv-archon");
      await git(sb.home, "clone", "-q", origin, checkout);
      await linkEngine(checkout);
      const push = async (file: string) => {
        await fs.writeTextFile(path.join(seed, file), `${file}\n`);
        await git(seed, "add", file);
        await git(seed, "commit", "-q", "-m", `add ${file}`);
        await git(seed, "push", "-q", "origin", "main");
      };
      const probe = path.join(sb.home, "sync.ts");
      await fs.writeTextFile(
        probe,
        `import { syncCheckout } from ${JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, "src", "archon", "reconcile", "reconcile.ts")).href)};
const r = await syncCheckout();
console.log(JSON.stringify({ current: r.current, pulled: r.pulled.length, blocked: r.blocked ?? "", same: r.head === r.remote }));`,
      );
      const sync = async () => {
        const r = await sb.run(probe, [], "", { ARCHON_REPO: checkout, ARCHON_FLEET: "lab" });
        assertEquals(r.code, 0, r.out);
        // As root it also records the outcome for the PC (a line of its own when it cannot).
        const line = r.out
          .split("\n")
          .filter((l) => l.startsWith("{"))
          .pop();
        return JSON.parse(line ?? "{}") as {
          current: boolean;
          pulled: number;
          blocked: string;
          same: boolean;
        };
      };
      // Nothing new: current, nothing pulled.
      assertEquals(await sync(), { current: true, pulled: 0, blocked: "", same: true });
      // A new commit on the branch: fast-forwarded to it, so apply runs at the remote's tip.
      await push("one.txt");
      assertEquals(await sync(), { current: true, pulled: 1, blocked: "", same: true });
      assertEquals(
        await git(checkout, "rev-parse", "HEAD"),
        await git(origin, "rev-parse", "main"),
      );
      // A checkout with changes nobody committed is not moved: not current, so nothing is applied.
      await push("two.txt");
      const beta = path.join(checkout, "fleets", "lab", "hosts", "beta", "host.ts");
      await fs.writeTextFile(beta, (await fs.readTextFile(beta)) + "// edited on the host\n");
      let r = await sync();
      assertEquals([r.current, r.pulled], [false, 0]);
      assertStringIncludes(r.blocked, "uncommitted changes");
      await git(checkout, "checkout", "--", ".");
      // A local commit the branch does not have: no fast-forward, nothing applied.
      await fs.writeTextFile(path.join(checkout, "local.txt"), "x\n");
      await git(checkout, "add", "local.txt");
      await git(checkout, "commit", "-q", "-m", "local");
      r = await sync();
      assertEquals(r.current, false);
      assertStringIncludes(r.blocked, "does not come after this checkout");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "git checkouts in POSIX paths" },
);

proves(
  ["015-reconcile FR-003"],
  "015: one host-changing run at a time: a waiting run waits, the timer skips, children inherit the lock",
  async () => {
    assertEquals(LOCK_PATH, "/run/archon.lock");
    const dir = await fs.makeTempDir({ prefix: "archon-lock-test-" });
    const file = path.join(dir, "archon.lock");
    const saved = proc.env.get(LOCK_HELD_ENV);
    proc.env.delete(LOCK_HELD_ENV);
    try {
      // Another run holds it: a live process (this test's parent) named in the lock file.
      await fs.writeTextFile(
        file,
        `${JSON.stringify({ pid: proc.ppid(), command: "archon update, a terminal", since: new Date().toISOString(), token: "other" })}\n`,
      );
      // The reconcile timer does not wait: it skips.
      assertEquals(await hostLock({ wait: false }, file), undefined);
      // An interactive run waits, says for whom, and takes the lock once it is free.
      let waitedFor = "";
      const freed = proc.sleep(400).then(() => fs.remove(file));
      const held = await hostLock(
        { wait: true, onWait: (h) => (waitedFor = h?.command ?? "") },
        file,
      );
      await freed;
      assertExists(held);
      assertEquals(waitedFor, "archon update, a terminal");
      assertEquals((await lock.readHolder(file))?.pid, proc.pid);
      // Its children (bootstrap and update hand-offs, reconcile's apply) inherit it at once.
      assertEquals(proc.env.get(LOCK_HELD_ENV), "1");
      const child = await hostLock({ wait: false }, file);
      assertExists(child, "a child of the holder is not refused");
      child.release();
      assert(await fs.exists(file), "a child's release leaves its parent's lock");
      held.release();
      assert(!(await fs.exists(file)), "released");
      assertEquals(proc.env.get(LOCK_HELD_ENV), undefined);
    } finally {
      if (saved !== undefined) proc.env.set(LOCK_HELD_ENV, saved);
      await fs.remove(dir, { recursive: true });
    }
  },
);
