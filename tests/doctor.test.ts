/**
 * Spec 026: archon doctor's parsers and explanations, with real tool output.
 *
 * @module
 */
import { assert, assertEquals, proves, the } from "@intellectual-frontiers/ifc-ts/runtime/test";
import {
  aptRepos,
  explainCurl,
  inReleaseUrl,
  parseChronyTracking,
  parsePing,
  parseProbe,
  parseResolvectlDns,
  parseSnapConnectivity,
  ufwOutgoing,
} from "../src/archon/doctor/probe.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { fleet, host } from "./fixtures.ts";

proves(["026-doctor FR-008"], "doctor: apt repositories from deb822 and one-line sources", () => {
  const repos = aptRepos([
    {
      name: "ubuntu.sources",
      text: `Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: resolute resolute-updates resolute-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: resolute-security
Components: main restricted universe multiverse
`,
    },
    {
      name: "off.sources",
      text: "Types: deb\nURIs: https://example.org/x\nSuites: stable\nEnabled: no\n",
    },
    {
      name: "github-cli.list",
      text: "deb [arch=amd64 signed-by=/etc/apt/keyrings/gh.gpg] https://cli.github.com/packages stable main\n# deb http://x y z\n",
    },
  ]);
  assertEquals(
    repos.map((r) => `${r.uri} ${r.suite}`),
    [
      "http://archive.ubuntu.com/ubuntu/ resolute",
      "http://archive.ubuntu.com/ubuntu/ resolute-updates",
      "http://archive.ubuntu.com/ubuntu/ resolute-backports",
      "http://security.ubuntu.com/ubuntu/ resolute-security",
      "https://cli.github.com/packages stable",
    ],
  );
  assertEquals(
    inReleaseUrl(the(repos[3])),
    "http://security.ubuntu.com/ubuntu/dists/resolute-security/InRelease",
  );
  assertEquals(
    inReleaseUrl({ uri: "https://example.org/repo", suite: "./" }),
    "https://example.org/repo/./InRelease",
  );
});

proves(["026-doctor FR-008"], "doctor: curl's timings and failures", () => {
  const ok = parseProbe("https://x", 0, "200 91.189.91.83 0.012 0.031 0.070 0.120 https://x/", "");
  assertEquals([ok.ok, ok.http, ok.ip, ok.tls], [true, 200, "91.189.91.83", 0.07]);
  const dns = parseProbe(
    "https://x",
    6,
    "000  0 0 0 0.004 https://x/",
    "curl: (6) Could not resolve host: x",
  );
  assertEquals([dns.ok, dns.error], [false, "Could not resolve host: x"]);
  assert(explainCurl(6).what.includes("resolve"));
  assert(explainCurl(28, "Resolving timed out after 5001 milliseconds").what.includes("resolve"));
  assert(explainCurl(28).what.includes("timed out"));
  assert(explainCurl(60).look.includes("clock"));
});

proves(
  [
    "026-doctor FR-003",
    "026-doctor FR-004",
    "026-doctor FR-006",
    "026-doctor FR-007",
    "026-doctor FR-008",
  ],
  "doctor: ping, resolvectl, chronyc, snap, ufw",
  () => {
    const ping = parsePing(`PING 10.0.30.1 (10.0.30.1) 56(84) bytes of data.

--- 10.0.30.1 ping statistics ---
5 packets transmitted, 4 received, 20% packet loss, time 812ms
rtt min/avg/max/mdev = 0.301/0.402/0.611/0.120 ms
`);
    assertEquals(ping, { sent: 5, received: 4, avgMs: 0.402 });
    assertEquals(parsePing("5 packets transmitted, 0 received, 100% packet loss"), {
      sent: 5,
      received: 0,
      avgMs: undefined,
    });
    assertEquals(
      parseResolvectlDns(
        "Global:\nLink 2 (enp1s0): 10.0.30.1 fd00::1%enp1s0\n        10.0.30.2#dns.lan\nLink 3 (lxdbr0):\n",
      ),
      ["10.0.30.1", "fd00::1", "10.0.30.2"],
    );
    assertEquals(
      parseChronyTracking(`Reference ID    : B9FD2A11 (185.253.42.17)
Stratum         : 3
System time     : 0.000123000 seconds slow of NTP time
Leap status     : Normal
`),
      { offset: -0.000123, leap: "Normal", ref: "185.253.42.17" },
    );
    // The exact output snapd's own tests expect.
    assertEquals(parseSnapConnectivity("Connectivity status:\n * PASS\n"), {
      pass: true,
      unreachable: [],
    });
    assertEquals(parseSnapConnectivity("Connectivity status:\n * foo.bar.com: unreachable\n"), {
      pass: false,
      unreachable: ["foo.bar.com"],
    });
    assertEquals(
      ufwOutgoing(
        "Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), deny (routed)\n",
      ),
      "allow",
    );
  },
);

proves(
  ["026-doctor FR-001", "026-doctor FR-010"],
  "doctor: a read-only command, and every host carries its tools",
  () => {
    const cmd = the(COMMANDS.find((c) => c.name === "doctor"));
    assertEquals(cmd.tier, "read");
    const pkgs = resolvePlan(host(), fleet()).packages.map((p) => p.name);
    for (const p of ["bind9-dnsutils", "mtr-tiny", "iputils-ping", "curl"]) {
      assert(pkgs.includes(p), p);
    }
  },
);
