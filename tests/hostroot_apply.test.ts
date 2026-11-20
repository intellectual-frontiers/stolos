/**
 * Apply's root side in a host root (tests/host.ts: `ARCHON_ROOT`, stand-ins for the programs):
 * spec 009 (a snap the Store does not deliver is a warning), 033 (etckeeper commits what apply
 * changed), 040 (the order of apply's steps; an opt-in's own secrets readable by its account only),
 * 041 (S3's admin credentials before the first start; a key rotated through Podman's environment),
 * 010 (an upstream binary checked, installed, linked, and rolled back).
 *
 * @module
 */
import { sha256 } from "@intellectual-frontiers/crypto";
import { fs, path, proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/net";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { HOST_ROOT_SKIP, hostRoot } from "./host.ts";
import { fleet, host } from "./fixtures.ts";
import type { ToolDef } from "../src/archon/model/types.ts";

const OPTS = { skip: HOST_ROOT_SKIP, timeout: 120_000 } as const;
const ON = { enabled: true, by: "alice", at: "2026-11-12T18:00:00Z", data: "durable" } as const;
const mode = async (p: string): Promise<number> => ((await fs.stat(p)).mode ?? 0) & 0o7777;

proves(
  ["033-etckeeper FR-002"],
  "033: an apply that changed something commits /etc through etckeeper when it is unclean, with the specs and the changes",
  async () => {
    const h = await hostRoot();
    try {
      const { etckeeperCommit } = await import("../src/archon/apply/apply.ts");
      const changes = ["update /etc/ssh/sshd_config.d/archon.conf (007-ssh)", "install tmux"];
      // No etckeeper on the host: nothing to do.
      assertEquals(await etckeeperCommit(changes), false);
      await fs.ensureDir(h.at("/usr/bin"));
      await fs.writeTextFile(h.at("/usr/bin/etckeeper"), "");
      // Clean: no commit.
      await h.standIn("etckeeper", `[ "$1" = unclean ] && exit 1`);
      assertEquals(await etckeeperCommit(changes), false);
      assert(!(await h.calls()).some((c) => c.startsWith("etckeeper commit")));
      // Unclean: one commit, attributed to archon, naming the specs and the changes.
      await h.standIn("etckeeper");
      assertEquals(await etckeeperCommit(changes), true);
      const log = (await h.calls()).join("\n");
      const commit = log.slice(log.indexOf("etckeeper commit"));
      assert(log.includes("etckeeper commit"), log);
      assertStringIncludes(commit, "archon apply: 2 change(s) (007-ssh)");
      assertStringIncludes(commit, "install tmux");
      assertEquals(await etckeeperCommit([]), true, "no spec named: still the changes");
    } finally {
      await h.restore();
    }
  },
  OPTS,
);

proves(
  ["009-updates FR-007"],
  "009: a snap the Store does not deliver is a warning, retried by the next reconcile; conntrack and ufw are not touched",
  async () => {
    const h = await hostRoot();
    try {
      // Every apt package is installed; no snap is, and the Store times out.
      await h.standIn("dpkg-query", `printf 'ii '`);
      await h.standIn(
        "snap",
        `case "$1" in
  list) exit 1;;
  install) echo 'error: cannot install "lxd": Post "https://api.snapcraft.io/v2/snaps/refresh": dial tcp: i/o timeout' >&2; exit 1;;
esac`,
      );
      await h.standIn("curl", `printf 200`);
      await h.standIn("add-apt-repository");
      await h.standIn("getent", "exit 2");
      const { ui } = await import("../src/archon/core/ui.ts");
      const { apply } = await import("../src/archon/apply/apply.ts");
      const guests = [{ name: "db", kind: "vm", image: "ubuntu:26.04", data: "durable" } as const];
      const r = await apply(host({ guests: [...guests] }), { check: false, only: ["packages"] });
      assert(!r.failed, "a snap that did not install fails nothing");
      assert(r.changes.includes("snap install lxd"), r.changes.join("\n"));
      const warn = ui.problems.find((p) => p.message.startsWith("snap install lxd"));
      assert(warn?.level === "warn", JSON.stringify(ui.problems));
      assertStringIncludes(warn.message, "the next reconcile tries again");
      assert(
        !(await h.calls()).some((c) => /^(conntrack|ufw|sysctl|iptables|nft)\b/.test(c)),
        (await h.calls()).join("\n"),
      );
    } finally {
      await h.restore();
    }
  },
  OPTS,
);

proves(
  ["040-opt-in FR-008"],
  "040: apply's steps in order: Files (then an opt-in container's secrets), Units, Databases, Containers",
  async () => {
    const h = await hostRoot();
    try {
      await h.standIn("dpkg-query", `printf 'ii '`);
      await h.standIn("curl", `printf 200`);
      await h.standIn("getent", "exit 2");
      const { ui } = await import("../src/archon/core/ui.ts");
      const { apply } = await import("../src/archon/apply/apply.ts");
      const { PRIME } = await import("../src/archon/pg/config.ts");
      const phases: string[] = [];
      const before = ui.onPhaseEnd;
      ui.onPhaseEnd = (name) => void phases.push(name);
      try {
        const r = await apply(host({ pg: { instances: [PRIME] }, optIn: { pg: ON, s3: ON } }), {
          check: true,
        });
        assertEquals(phases, [
          "Packages",
          "Accounts",
          "Files",
          "Units",
          "Databases",
          "Containers",
          "Dotfiles",
        ]);
        // S3's generated secrets come after its files (the container's Quadlet), before the units.
        const secrets = r.changes.indexOf(
          "/var/lib/archon/s3/rustfs.env (S3 admin credentials, root only)",
        );
        const quadlet = r.changes.findIndex((c) =>
          c.includes("/etc/containers/systemd/archon-s3.container"),
        );
        const units = r.changes.findIndex((c) => c.startsWith("enable --now "));
        assert(quadlet >= 0 && quadlet < secrets && secrets < units, r.changes.join("\n"));
        assert(!(await fs.exists(h.at("/var/lib/archon/s3/rustfs.env"))), "a check writes nothing");
      } finally {
        if (before) ui.onPhaseEnd = before;
        else delete ui.onPhaseEnd;
      }
    } finally {
      await h.restore();
    }
  },
  OPTS,
);

proves(
  ["041-s3 FR-004"],
  "041: S3's admin credentials are generated before the first start, root only (0600), never again",
  async () => {
    const h = await hostRoot();
    try {
      const { prepareS3 } = await import("../src/archon/s3/s3.ts");
      const changes: string[] = [];
      const sink = {
        check: false,
        change: (m: string) => void changes.push(m),
        warn: () => {},
        fail: (m: string) => {
          throw new Error(m);
        },
        unreadable: () => {},
      };
      await prepareS3(sink);
      const env = await fs.readTextFile(h.at("/var/lib/archon/s3/rustfs.env"));
      const m = /^RUSTFS_ACCESS_KEY=archon-root\nRUSTFS_SECRET_KEY=([A-Za-z0-9_-]{43})\n$/.exec(
        env,
      );
      assert(m !== null, "archon-root, 32 random bytes (base64url)");
      const rc = await fs.readTextFile(h.at("/var/lib/archon/s3/rc.env"));
      assertEquals(rc, `RC_HOST_archon=http://archon-root:${m[1]}@127.0.0.1:9000\n`);
      assertEquals(await mode(h.at("/var/lib/archon/s3")), 0o700);
      assertEquals(await mode(h.at("/var/lib/archon/s3/rustfs.env")), 0o600);
      assertEquals(await mode(h.at("/var/lib/archon/s3/rc.env")), 0o600);
      assertEquals(changes, ["/var/lib/archon/s3/rustfs.env (S3 admin credentials, root only)"]);
      // Never in a change line, the journal, or a log: only the path.
      assert(!changes.join("").includes(m[1] ?? "-"));
      await prepareS3(sink);
      assertEquals(changes.length, 1, "kept: never generated again");
      assertEquals(await fs.readTextFile(h.at("/var/lib/archon/s3/rustfs.env")), env);
    } finally {
      await h.restore();
    }
  },
  OPTS,
);

proves(
  ["040-opt-in FR-007", "041-s3 FR-011"],
  "040/041: each account's S3 secret is generated on the server, readable by that account only; rotate sets a new one through Podman's environment",
  async () => {
    const h = await hostRoot();
    const sudoUser = proc.env.get("SUDO_USER");
    try {
      // RustFS answers; alice is a Linux account; Podman records what rc was given, and where.
      const env = path.join(h.bin, "podman-env.log");
      await h.standIn("curl");
      await h.standIn(
        "getent",
        `[ "$1 $2" = "passwd alice" ] && echo "alice:x:1000:1000::/home/alice:/bin/bash" && exit 0; exit 2`,
      );
      await h.standIn(
        "podman",
        `echo "ARCHON_S3_SECRET=\${ARCHON_S3_SECRET:-}" >> '${env}'
case "$*" in *"user info"*) exit 1;; esac`,
      );
      const { convergeS3, s3Rotate } = await import("../src/archon/s3/s3.ts");
      const { resolvePlan } = await import("../src/archon/model/resolve.ts");
      const alpha = host({ optIn: { s3: ON } });
      const plan = resolvePlan(alpha, fleet());
      assert(
        plan.users.some((u) => u.name === "alice"),
        "the fleet's admin is a person here",
      );
      const changes: string[] = [];
      const sink = {
        check: false,
        change: (m: string) => void changes.push(m),
        warn: () => {},
        fail: (m: string) => {
          throw new Error(m);
        },
        unreadable: () => {},
      };
      assert(await convergeS3(plan, sink));
      assertStringIncludes(changes.join("\n"), "S3 user alice");
      const key = h.at("/var/lib/archon-keys/s3/alice");
      const first = (await fs.readTextFile(key)).trim();
      assert(/^[A-Za-z0-9_-]{43}$/.test(first), "generated on the server: 32 random bytes");
      assertEquals(await mode(key), 0o400);
      assertEquals(
        await mode(h.at("/var/lib/archon-keys/s3")),
        0o711,
        "anyone may pass, none list",
      );
      const calls = await h.calls();
      assert(
        calls.some((c) => c.startsWith("chown alice:root ")),
        "owned by alice",
      );
      // The secret reaches rc through Podman's environment, never its command line.
      assert(!calls.some((c) => c.includes(first)), "never on a command line");
      assertStringIncludes(await fs.readTextFile(env), `ARCHON_S3_SECRET=${first}`);
      assert(
        calls.some((c) => c.includes("passwd archon alice --password-from-env ARCHON_S3_SECRET")),
      );

      // FR-011: the person behind sudo rotates their own key.
      proc.env.set("SUDO_USER", "alice");
      assertEquals(await s3Rotate("alpha", { host: alpha }), 0);
      const second = (await fs.readTextFile(key)).trim();
      assert(second !== first && /^[A-Za-z0-9_-]{43}$/.test(second), "a new 32-byte secret");
      assertEquals(await mode(key), 0o400);
      assertStringIncludes(await fs.readTextFile(env), `ARCHON_S3_SECRET=${second}`);
      const after = await h.calls();
      assert(!after.some((c) => c.includes(second)), "never on a command line");
      const journal = after.filter((c) => c.startsWith("logger -t archon-s3"));
      assertEquals(journal.length, 1, after.join("\n"));
      assert(journal[0]?.endsWith("S3 secret for alice rotated"), "only the fact is journaled");
      // Not for root itself, and not where S3 is off.
      proc.env.set("SUDO_USER", "root");
      assertEquals(await s3Rotate("alpha", { host: alpha }), 2);
      proc.env.set("SUDO_USER", "alice");
      assertEquals(await s3Rotate("alpha", { host: host() }), 1);
      // The command elevates with the flag, and counts as mutate over MCP.
      const { COMMANDS } = await import("../src/archon/commands/registry.ts");
      const { effectiveTier } = await import("../src/archon/core/registry-types.ts");
      const cmd = COMMANDS.find((c) => c.name === "fs s3 key");
      assert(cmd !== undefined);
      assertEquals(effectiveTier(cmd, { rotate: true }), "mutate");
      assertEquals(effectiveTier(cmd, {}), "read");
    } finally {
      if (sudoUser === undefined) proc.env.delete("SUDO_USER");
      else proc.env.set("SUDO_USER", sudoUser);
      await h.restore();
    }
  },
  OPTS,
);

proves(
  ["010-tools FR-001"],
  "010: an upstream binary is verified against its published SHA-256, installed under /opt/tools/<tool>/<version>, smoke-tested, linked into /usr/local/bin, and rolled back on failure",
  async () => {
    const h = await hostRoot();
    const builds: Record<string, string> = {
      "10.2.0": "#!/bin/sh\necho fd 10.2.0\n",
      "10.3.0": "#!/bin/sh\necho 'fd: cannot execute binary file' >&2\nexit 126\n",
    };
    const server = await serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
      const v = new URL(req.url).pathname.slice(1);
      const body = builds[v];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    });
    try {
      const { installUpstream } = await import("../src/archon/tools/sync.ts");
      const link = h.at("/usr/local/bin/fd");
      const tool: ToolDef = {
        id: "fd",
        name: "fd",
        source: "upstream-binary",
        bins: ["fd"],
        versionCommand: `${link} --version`,
        verify: `${link} --version`,
        spec: "010-tools",
        github: { repo: "sharkdp/fd", asset: () => /^fd$/ },
      };
      const release = async (v: string, digest?: string) => ({
        tag: `v${v}`,
        version: v,
        assets: [
          {
            name: "fd",
            url: `http://127.0.0.1:${server.addr.port}/${v}`,
            digest: digest ?? `sha256:${await sha256(new TextEncoder().encode(builds[v] ?? ""))}`,
          },
        ],
      });
      await fs.ensureDir(h.at("/usr/local/bin"));
      // Verified, installed, linked, smoke-tested.
      await installUpstream(tool, await release("10.2.0"), "amd64");
      assertEquals(await fs.readLink(link), h.at("/opt/tools/fd/10.2.0/bin/fd"));
      assertEquals(await fs.readTextFile(h.at("/opt/tools/fd/10.2.0/bin/fd")), builds["10.2.0"]);
      // A digest that does not match: refused, nothing installed, the link unchanged.
      const wrong = await installUpstream(
        tool,
        await release("10.3.0", `sha256:${"0".repeat(64)}`),
        "amd64",
      ).then(
        () => "",
        (e: unknown) => String(e),
      );
      assert(wrong !== "", "a mismatched digest is refused");
      assert(!(await fs.exists(h.at("/opt/tools/fd/10.3.0"))), wrong);
      assertEquals(await fs.readLink(link), h.at("/opt/tools/fd/10.2.0/bin/fd"));
      // No published digest at all: refused (Article 12).
      const none = await installUpstream(
        tool,
        { tag: "v10.3.0", version: "10.3.0", assets: [{ name: "fd", url: "http://127.0.0.1:9/" }] },
        "amd64",
      ).then(
        () => "",
        (e: unknown) => String(e),
      );
      assertStringIncludes(none, "no published SHA-256 digest");
      // A build whose smoke test fails: rolled back to the version before.
      const failed = await installUpstream(tool, await release("10.3.0"), "amd64").then(
        () => "",
        (e: unknown) => String(e),
      );
      assertStringIncludes(failed, "fd 10.3.0: smoke test failed, rolled back");
      assertEquals(await fs.readLink(link), h.at("/opt/tools/fd/10.2.0/bin/fd"));
    } finally {
      await server.shutdown();
      await h.restore();
    }
  },
  OPTS,
);
