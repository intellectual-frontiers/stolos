/**
 * Spec 015: the reconcile timer, the checkout's fast-forward (only a clean checkout, only to a tip
 * that comes after it), and one host-changing run at a time.
 *
 * @module
 */
import { sha256 } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, lock, path, proc, serve } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { hostLock, LOCK_HELD_ENV, LOCK_PATH } from "../src/archon/core/lock.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";
import { HOST_ROOT_SKIP, hostRoot } from "./host.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";
import { runtimeCommand } from "../src/archon/install/bun.ts";

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

proves(
  ["015-reconcile FR-002", "032-web FR-001"],
  "015: archon update pulls, validates (an invalid model stops it), applies, syncs tools (Traefik restarted after its upgrade), applies dotfiles again when a tool changed, and verifies",
  async () => {
    const h = await hostRoot();
    // The tools' releases (spec 010): every upstream tool is current but chezmoi (a binary) and
    // Traefik (its release archive), each newer release with its published SHA-256.
    // The new chezmoi records what it is asked (the dotfiles step); its verify finds a difference.
    const chezmoi = `#!/bin/sh\nprintf '%s\\n' "chezmoi $*" >> '${path.join(path.dirname(h.root), "calls.log")}'\n[ "$1" = verify ] && exit 1\necho 'chezmoi version v2.70.0'\n`;
    const traefikTgz = "traefik_v3.6.0_linux_amd64.tar.gz";
    const assets: Record<string, Uint8Array> = {
      "chezmoi-linux-amd64": new TextEncoder().encode(chezmoi),
    };
    const newer: Record<string, { tag: string; asset: string }> = {
      "twpayne/chezmoi": { tag: "v2.70.0", asset: "chezmoi-linux-amd64" },
      "traefik/traefik": { tag: "v3.6.0", asset: traefikTgz },
    };
    const server = await serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${server.addr.port}`;
      const file = assets[url.pathname.replace(/^\/dl\//, "")];
      if (url.pathname.startsWith("/dl/") && file !== undefined)
        return new Response(new Uint8Array(file));
      const m = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(url.pathname);
      if (m === null) return new Response("", { status: 404 });
      const n = newer[m[1] ?? ""];
      const bytes = n === undefined ? undefined : assets[n.asset];
      return Response.json({
        tag_name: n?.tag ?? "v9.9.9",
        prerelease: false,
        assets:
          n === undefined || bytes === undefined
            ? []
            : [
                {
                  name: n.asset,
                  browser_download_url: `${base}/dl/${n.asset}`,
                  digest: `sha256:${await sha256(bytes)}`,
                },
              ],
      });
    });
    try {
      const git = async (dir: string, ...args: string[]) => {
        const r = await proc.run(["git", "-C", dir, ...ID, ...args]);
        assertEquals(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
        return r.stdout.trim();
      };
      // The fleet's repository (a local bare remote), a PC's clone that pushes, and the host's
      // checkout at /srv/archon.
      const work = path.dirname(h.root);
      const origin = path.join(work, "origin.git");
      const seed = path.join(work, "seed");
      await fs.mkdir(path.join(seed, "fleets"), { recursive: true });
      await fs.copy(
        path.join(ENGINE_ROOT, "examples", "fleets", "lab"),
        path.join(seed, "fleets", "lab"),
      );
      await git(work, "init", "-q", "--bare", "-b", "main", origin);
      await git(seed, "init", "-q", "-b", "main");
      await git(seed, "add", "fleets");
      await git(seed, "commit", "-q", "-m", "lab");
      await git(seed, "remote", "add", "origin", origin);
      await git(seed, "push", "-q", "origin", "main");
      const checkout = h.at("/srv/archon");
      await git(work, "clone", "-q", origin, checkout);
      await linkEngine(checkout);
      const alphaTs = path.join(seed, "fleets", "lab", "hosts", "alpha", "host.ts");
      const good = await fs.readTextFile(alphaTs);
      const push = async (text: string, msg: string) => {
        await fs.writeTextFile(alphaTs, text);
        await git(seed, "commit", "-q", "-am", msg);
        await git(seed, "push", "-q", "origin", "main");
      };

      // The host's programs: git as the checkout's owner, packages installed, each upstream
      // tool's version (chezmoi older than its release, the others current).
      await h.standIn("runuser", `while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
      await h.standIn("dpkg-query", `printf 'ii '`);
      await h.standIn("curl", `printf 200`);
      // alice has an account (her files are written as hers); her home here is the root.
      await h.standIn(
        "getent",
        `case "$1 $2" in "passwd alice"|"group alice") echo "alice:x:1000:1000::${h.root}:/bin/bash";; *) exit 2;; esac`,
      );
      await h.standIn("gh", "exit 1");
      for (const p of ["postfix", "testparm", "sshd", "mandb", "add-apt-repository"]) {
        await h.standIn(p);
      }
      const { TOOLS } = await import("../src/archon/tools/catalog.ts");
      const { BUN_VERSION } = await import("../src/archon/core/bun-pin.ts");
      for (const t of TOOLS.filter((x) => x.source === "upstream-binary")) {
        const cmd = t.versionCommand.split(" ")[0] ?? t.id;
        const v =
          t.id === "bun"
            ? BUN_VERSION
            : t.id === "chezmoi"
              ? "2.60.0"
              : t.id === "traefik"
                ? "3.5.0"
                : "9.9.9";
        await h.standIn(cmd, `echo '${t.id} version v${v}'`);
      }
      // Traefik's release archive: the binary in a tar.gz; its unit is enabled on this server.
      const pack = path.join(work, "traefik-release");
      await fs.ensureDir(pack);
      await fs.writeTextFile(path.join(pack, "traefik"), "#!/bin/sh\necho 'Version: 3.6.0'\n");
      await fs.chmod(path.join(pack, "traefik"), 0o755);
      const tar = await proc.run([
        "tar",
        "-czf",
        path.join(work, traefikTgz),
        "-C",
        pack,
        "traefik",
      ]);
      assertEquals(tar.code, 0, tar.stderr);
      assets[traefikTgz] = await fs.readFile(path.join(work, traefikTgz));
      const self = path.join(h.bin, "archon-self");
      await fs.writeTextFile(
        self,
        `#!/bin/sh\nexec ${runtimeCommand()
          .map((a) => `'${a}'`)
          .join(" ")} '${path.join(ENGINE_ROOT, "src", "archon", "main.ts")}' "$@"\n`,
      );
      await fs.chmod(self, 0o755);
      const update = async () => {
        const r = await proc.run([self, "update", "--host", "alpha", "--verbose"], {
          env: {
            ARCHON_REPO: checkout,
            ARCHON_FLEET: "lab",
            ARCHON_SELF: self,
            ARCHON_GITHUB_API: `http://127.0.0.1:${server.addr.port}`,
            GITHUB_TOKEN: "",
            GH_TOKEN: "",
            NO_COLOR: "1",
            ARCHON_PLAIN: "1",
          },
        });
        return { code: r.code, out: r.stdout + r.stderr };
      };
      /** The phases a run went through, in order, as its screen names them. */
      const phases = (out: string): string[] =>
        out
          .split("\n")
          .map((l) => /^\[(?:ok|FAIL|warn|skip|changed?)\]\s+(\S.*?)\s{2,}/i.exec(l)?.[1])
          .filter((p): p is string => p !== undefined);

      // An invalid model arrives: pulled, validated, and nothing applied.
      await push(
        good.replace(
          `name: "alpha",`,
          `name: "alpha",\n  pg: { instances: [{ name: "Bad_Name" }] },`,
        ),
        "a bad instance name",
      );
      let r = await update();
      assert(r.code !== 0, r.out);
      assertEquals(
        await git(checkout, "rev-parse", "HEAD"),
        await git(origin, "rev-parse", "main"),
      );
      let seen = phases(r.out);
      assert(seen.includes("Pull") && seen.includes("Model"), r.out);
      for (const later of ["Packages", "Tools", "Dotfiles", "Verify"]) {
        assert(!seen.includes(later), `${later} after an invalid model:\n${r.out}`);
      }

      // A valid model arrives: pull, validate, apply, tools (chezmoi upgraded), dotfiles again,
      // verify, in that order.
      await push(good, "the model fixed");
      r = await update();
      assertEquals(
        await git(checkout, "rev-parse", "HEAD"),
        await git(origin, "rev-parse", "main"),
      );
      seen = phases(r.out);
      const at = (p: string, from = 0): number => seen.indexOf(p, from);
      const pull = at("Pull");
      const model = at("Model");
      const apply = at("Packages");
      const dotfiles1 = at("Dotfiles", apply);
      const tools = at("Tools");
      const dotfiles2 = at("Dotfiles", tools);
      const verify = at("Verify");
      assert(
        pull >= 0 &&
          pull < model &&
          model < apply &&
          apply < dotfiles1 &&
          dotfiles1 < tools &&
          tools < dotfiles2 &&
          dotfiles2 < verify,
        `${seen.join(" > ")}\n${r.out}`,
      );
      assertStringIncludes(r.out, "chezmoi 2.70.0 (new)");
      assertStringIncludes(r.out, "traefik 3.6.0 (new)");
      assertEquals(
        await fs.readLink(h.at("/usr/local/bin/traefik")),
        h.at("/opt/tools/traefik/3.6.0/bin/traefik"),
      );
      // The dotfiles step after the tools ran the new chezmoi for each person.
      const calls = await h.calls();
      const synced = calls.findIndex((c) => c.startsWith("logger -t archon-tools"));
      const applied = calls.findIndex((c) => c === "chezmoi apply --force --no-tty");
      assert(synced >= 0 && synced < applied, `${calls.join("\n")}\n${r.out}`);
      const verified = calls.lastIndexOf("chezmoi verify --no-tty");
      assert(verified >= 0 && verified < applied, "verify finds the difference, then apply");
      // Spec 032: the tools sync restarts Traefik after its upgrade (its unit is enabled).
      const enabled = calls.indexOf("systemctl is-enabled --quiet traefik.service");
      assert(enabled >= 0 && enabled + 1 < synced, calls.join("\n"));
      assertEquals(calls[enabled + 1], "systemctl restart traefik.service");
      assertEquals(
        await fs.readLink(h.at("/usr/local/bin/chezmoi")),
        h.at("/opt/tools/chezmoi/2.70.0/bin/chezmoi"),
      );
    } finally {
      await server.shutdown();
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 300_000 },
);
