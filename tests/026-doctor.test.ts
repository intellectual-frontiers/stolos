/**
 * Spec 026 (archon doctor): what it reads and how it runs its tools. The doctor runs in a sandbox
 * on a copy of the example lab with every tool replaced by a script that records how it was called
 * and what it was given, and answers as the test says.
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
import { ui } from "../src/archon/core/ui.ts";
import { emailChecks, missingRecords } from "../src/archon/doctor/email.ts";
import type { Site } from "../src/archon/notify/notify.ts";
import { ENGINE_ROOT, linkEngine, type Sandbox, sandbox } from "./sandbox.ts";

const posix = proc.build.os === "linux";
const SKIP = { skip: posix ? false : "archon doctor and its stand-in tools are Linux's" };

/**
 * Every tool: `timeout` records its arguments and LC_ALL and answers from $FAKE_DIR/<tool>.out
 * (by the wrapped tool's name and first argument); any other tool called directly records that.
 */
const TOOL = `#!/bin/sh
n=\${0##*/}
if [ "$n" = timeout ]; then
  echo "timeout LC_ALL=\${LC_ALL:-} $*" >> "$FAKE_DIR/log"
  shift
  f="$FAKE_DIR/$1.\${2:-}.\${3:-}.out"
  # Only builtins: PATH holds the stand-ins alone.
  [ -f "$f" ] && { while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < "$f"; exit 0; }
  exit 1
fi
echo "direct $n LC_ALL=\${LC_ALL:-} $*" >> "$FAKE_DIR/log"
exit 7
`;
const TOOLS = [
  "timeout",
  "ip",
  "ping",
  "resolvectl",
  "dig",
  "getent",
  "timedatectl",
  "chronyc",
  "apt-config",
  "ufw",
  "git",
  "runuser",
  "curl",
  "snap",
  "mtr",
  "systemctl",
  "postconf",
  "postqueue",
  "sh",
  "ethtool",
];

/** archon doctor on alpha of the example lab, with the stand-in tools and their answers. */
async function doctorWith(
  sb: Sandbox,
  answers: Readonly<Record<string, string>>,
): Promise<{ out: string; log: string[] }> {
  const repo = path.join(sb.home, "fleet");
  const bin = path.join(sb.home, "bin");
  const dir = path.join(sb.home, "fake");
  // The doctor runs as the checkout's owner, elevated (asOwner): a host root (ARCHON_ROOT) makes
  // this run root's on a fresh host, whoever runs the test, so it never reaches for sudo.
  const root = path.join(sb.home, "root");
  for (const d of [path.join(repo, "fleets"), bin, dir, root]) {
    await fs.mkdir(d, { recursive: true });
  }
  if (!(await fs.exists(path.join(repo, "fleets", "lab")))) {
    await proc.output([
      "cp",
      "-r",
      path.join(ENGINE_ROOT, "examples/fleets/lab"),
      path.join(repo, "fleets/lab"),
    ]);
    await linkEngine(repo);
  }
  await fs.writeTextFile(path.join(bin, "_tool"), TOOL);
  await fs.chmod(path.join(bin, "_tool"), 0o755);
  for (const t of TOOLS) {
    if (!(await fs.exists(path.join(bin, t)))) await fs.symlink("_tool", path.join(bin, t));
  }
  await fs.remove(path.join(dir, "log")).catch(() => undefined);
  for (const f of await fs.listFiles(dir)) await fs.remove(path.join(dir, f));
  for (const [k, v] of Object.entries(answers)) {
    await fs.writeTextFile(path.join(dir, `${k}.out`), v);
  }
  const r = await sb.run(
    path.join(ENGINE_ROOT, "src/archon/main.ts"),
    ["doctor", "--host", "alpha"],
    "",
    { ARCHON_REPO: repo, ARCHON_FLEET: "lab", ARCHON_ROOT: root, FAKE_DIR: dir, PATH: bin },
  );
  const log = ((await fs.readTextOr(path.join(dir, "log"))) ?? "").split("\n").filter(Boolean);
  return { out: r.out, log };
}

proves(
  ["026-doctor FR-011"],
  "026: every tool the doctor runs has a time limit and the C locale",
  async () => {
    const sb = await sandbox("archon-026-");
    try {
      const { log, out } = await doctorWith(sb, {});
      assert(log.length > 10, out);
      for (const l of log) {
        if (l.startsWith("timeout ")) {
          assert(l.startsWith("timeout LC_ALL=C "), l);
          assert(/^timeout LC_ALL=C \d+ /.test(l), l);
        } else {
          // curl keeps its own limits (--connect-timeout, --max-time), in the C locale.
          assert(l.startsWith("direct curl LC_ALL=C "), `run without a time limit: ${l}`);
          assertStringIncludes(l, "--max-time");
        }
      }
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  SKIP,
);

/** The answers of a host whose default route is on `eth0`. */
const LINK = (stats: { rx: number; tx: number }): Record<string, string> => ({
  "ip.-j.route": JSON.stringify([{ gateway: "10.0.30.1", dev: "lab0" }]),
  "ip.-j.-4": JSON.stringify([{ addr_info: [{ local: "10.0.30.57", prefixlen: 24 }] }]),
  "ip.-j.-s": JSON.stringify([{ stats64: { rx: { errors: stats.rx }, tx: { errors: stats.tx } } }]),
});

proves(
  ["026-doctor FR-002"],
  "026: Link: the default route, the interface's address, and its error counters",
  async () => {
    const sb = await sandbox("archon-026-link-");
    try {
      // No default route: a failure that says nothing outside is reachable.
      let r = await doctorWith(sb, {});
      assertStringIncludes(r.out, "no IPv4 default route");
      // A route on eth0 with errors: its address, its gateway, and a warning with the count.
      r = await doctorWith(sb, LINK({ rx: 3, tx: 2 }));
      assertStringIncludes(r.out, "lab0 10.0.30.57/24 · gateway 10.0.30.1");
      assertStringIncludes(r.out, "lab0: 5 receive/transmit errors since boot");
      assert(
        r.log.some((l) => / ip -j -s link show dev lab0$/.test(l)),
        r.log.join("\n"),
      );
      // Carrier, duplex and MTU come from sysfs (/sys/class/net/lab0): here there is none, so
      // no carrier is reported.
      assertStringIncludes(r.out, "lab0 has no carrier");
      // Without errors, no warning.
      r = await doctorWith(sb, LINK({ rx: 0, tx: 0 }));
      assert(!r.out.includes("receive/transmit errors"), r.out);
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  SKIP,
);

proves(
  ["026-doctor FR-005"],
  "026: IPv6: without a route, sites with IPv6 addresses while apt is not limited to IPv4 fail; with one, it is tried",
  async () => {
    const sb = await sandbox("archon-026-v6-");
    try {
      // The lab's network has no IPv6. Sites publish AAAA, no route, apt not limited (no
      // 52archon-network file on this test machine's apt): a failure that names spec 009's fix.
      const aaaa = { "dig.+time=2.+tries=1": "2620:2d:4000:1::101\n" };
      let r = await doctorWith(sb, aaaa);
      const limited = /ForceIPv4 "true"/.test(
        (await fs.readTextOr("/etc/apt/apt.conf.d/52archon-network")) ?? "",
      );
      if (limited) assertStringIncludes(r.out, "apt uses IPv4 only");
      else {
        assertStringIncludes(
          r.out,
          "sites have IPv6 addresses this host cannot reach, and apt is not limited to IPv4",
        );
      }
      // A default route: it is tried, over curl, and its failure is a warning.
      r = await doctorWith(sb, {
        ...aaaa,
        "ip.-6.route": "default via fe80::1 dev eth0 proto ra metric 100\n",
      });
      assertStringIncludes(r.out, "an IPv6 default route exists but connections fail");
      assertStringIncludes(r.out, "default route default via fe80::1");
      assert(
        r.log.some((l) => l.startsWith("direct curl") && l.endsWith("https://archive.ubuntu.com/")),
      );
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  SKIP,
);

proves(
  ["026-doctor FR-009"],
  "026: Email: Cloudflare's records on cf-bounce and _dmarc, the relay's token, and archon notify's queue and last send",
  async () => {
    const all = {
      spf: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
      dkim: ["v=DKIM1; h=sha256; k=rsa; p=MIIB"],
      dmarc: ["v=DMARC1; p=reject"],
      mx: ["route1.mx.cloudflare.net"],
    };
    assertEquals(missingRecords("example.org", all), []);
    assertEquals(missingRecords("example.org", { spf: [], dkim: [], dmarc: [], mx: [] }), [
      "SPF (TXT cf-bounce.example.org)",
      "DKIM (TXT cf-bounce._domainkey.example.org)",
      "DMARC (TXT _dmarc.example.org)",
      "bounce MX (cf-bounce.example.org)",
    ]);
    assertEquals(missingRecords("example.org", { ...all, mx: ["mx.other.example"] }), [
      "bounce MX (cf-bounce.example.org)",
    ]);

    // The queue and the last send, on the boot machine's own site (no Postfix there).
    const dir = await fs.makeTempDir({ prefix: "archon-026-email-" });
    try {
      const site: Site = {
        role: "boot",
        name: "bootpc",
        credential: path.join(dir, "mail.json"),
        spool: path.join(dir, "notify"),
        status: path.join(dir, "notify", "status.json"),
        to: "fleet@example.net",
        from: "alice+bootpc.lab@example.net",
        relay: "smtp.mx.cloudflare.net:465",
        ipv4: true,
        timezone: "America/New_York",
      };
      await fs.mkdir(site.spool, { recursive: true });
      await fs.writeTextFile(
        site.status,
        JSON.stringify({
          configured: false,
          queue: 2,
          oldest: "2026-11-11T00:00:00Z",
          lastSend: { at: "2026-11-11T01:00:00Z", ok: false, subject: "s", error: "421 busy" },
        }),
      );
      for (const id of ["1-0000abcd", "2-0000abcd"]) {
        await fs.writeTextFile(
          path.join(site.spool, `${id}.json`),
          JSON.stringify({ id, created: "2026-11-11T00:00:00Z", subject: "s", text: "", html: "" }),
        );
      }
      const before = ui.problems.length;
      const p = ui.phase("Email");
      await emailChecks(site, p, "bun run stolos boot mail-setup");
      const said = ui.problems.slice(before).map((x) => `${x.level} ${x.message}`);
      // No token: not set up yet, with its next step; nothing is tried against the relay.
      assert(
        said.includes("pending no relay token yet: this machine sends no mail"),
        said.join("\n"),
      );
      assert(
        said.includes("warn archon notify's last send failed (2026-11-11T01:00:00Z): 421 busy"),
        said.join("\n"),
      );
      assert(
        said.some((s) => s.startsWith("warn 2 archon message(s) waiting")),
        said.join("\n"),
      );
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);
