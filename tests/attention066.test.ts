/**
 * Spec 066 FR-009: nothing that needs attention is a bare number. A check that did not pass is
 * recorded with its fix, and both consoles show it.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { attentionOf, type Check, verifyRecord } from "../src/archon/state/verify.ts";
import { attentionCard } from "../src/archon/console/pages.ts";
import { attentionFrom } from "../src/archon/console/pc.ts";
import { machinePage, machinesPage, stolosOverview } from "../src/archon/console/stolos-pages.ts";
import { FACTS } from "./console/serve-stolos.ts";

const CHECKS: Check[] = [
  { resource: "package:git", command: "dpkg-query -W git", ok: true, output: "ii" },
  {
    resource: "apt:ipv4-only",
    command: "grep -q ForceIPv4 /etc/apt/apt.conf.d/99archon",
    ok: false,
    output: "IPv6 is preferred for apt",
    level: "warn",
    fix: "sudo archon apply",
    code: "W009-IPV4",
  },
  {
    resource: "token:mail",
    command: "test -s /etc/archon/mail",
    ok: false,
    output: "",
    level: "pending",
  },
];

proves(
  ["066-stolos-console FR-009"],
  "066: a verify records every check that did not pass, with its fix",
  () => {
    const a = attentionOf(CHECKS);
    assertEquals(
      a.map((x) => [x.resource, x.level, x.fix]),
      [
        ["apt:ipv4-only", "warn", "sudo archon apply"],
        ["token:mail", "pending", "test -s /etc/archon/mail"],
      ],
    );
    assertEquals(a[0]?.code, "W009-IPV4");
    const r = verifyRecord(CHECKS, new Date("2026-11-16T12:00:00Z"));
    assertEquals([r.failed, r.warned, r.attention?.length], [[], ["apt:ipv4-only"], 2]);
    // An older record (names only) still lists every one.
    assertEquals(
      attentionFrom({ passed: 1, total: 3, failed: ["x"], warned: ["y"], since: "" }).map(
        (x) => x.level,
      ),
      ["fail", "warn"],
    );
  },
);

proves(
  ["066-stolos-console FR-009"],
  "066: the Archon Console shows each warning with its fix",
  () => {
    const card = String(
      attentionCard({
        at: "2026-11-16T12:00:00Z",
        passed: 1,
        total: 3,
        failed: [],
        attention: attentionOf(CHECKS),
      }),
    );
    assertStringIncludes(card, 'id="attention"');
    assertStringIncludes(card, "apt:ipv4-only");
    assertStringIncludes(card, "IPv6 is preferred for apt");
    assertStringIncludes(card, "How to fix: <code>sudo archon apply</code>");
    assertStringIncludes(card, "archon explain W009-IPV4");
    // An older engine's verify.json: no details, but never a bare number.
    const old = String(attentionCard({ at: "", passed: 140, total: 141, failed: [] }));
    assertStringIncludes(old, "1 check(s) did not pass");
  },
);

proves(
  ["066-stolos-console FR-009"],
  "066: the Stolos Console links a warning to its fix, and says when it has not asked",
  () => {
    const f = structuredClone(FACTS);
    const alpha = f.machines.find((m) => m.name === "alpha");
    assert(alpha);
    alpha.attention = attentionOf(CHECKS);
    f.machines.push({ name: "gamma", kind: "server", os: "Ubuntu", failing: [], notAsked: true });
    const list = String(machinesPage(f));
    assertStringIncludes(list, 'href="/machines/alpha#attention"');
    assertStringIncludes(list, "1 warning, 1 not set up yet");
    assertStringIncludes(list, "not asked yet");
    const page = String(machinePage(f, "alpha"));
    assertStringIncludes(page, "How to fix (on the server): <code>sudo archon apply</code>");
    const overview = String(stolosOverview(f));
    assertStringIncludes(overview, "This PC has not asked gamma for its");
    assertStringIncludes(overview, "How to fix");
  },
);
