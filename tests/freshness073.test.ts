/**
 * Spec 073: evidence freshness as a control: cadences, ages, stale evidence failing MON-02, drift.
 *
 * @module
 */
import { type Literal, tsLiteral } from "@intellectual-frontiers/formats";
import { fs, proc } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertExists,
  assertThrows,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import {
  cadence,
  controlFreshness,
  DEFAULT_CADENCES,
  durationMs,
  fleetFreshView,
  freshView,
  resolveCadences,
  staleSubjects,
  stampEvidence,
} from "../src/archon/compliance/freshness.ts";
import { compareViews, drift, driftEvent } from "../src/archon/compliance/drift.ts";
import { complianceView, type Evidence, fleetEvidence } from "../src/archon/compliance/report.ts";
import { check, type Connector, type Observation } from "../src/archon/connect/connector.ts";
import { compose, type Site } from "../src/archon/notify/notify.ts";
import { compliancePage } from "../src/archon/console/compliance-page.ts";

import { FACTS } from "./console/serve-stolos.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

const ev = (o: Partial<Evidence>): Evidence => ({
  scf: ["CRY-07"],
  subject: "m1",
  source: "adopted",
  check: "The disk is encrypted",
  status: "pass",
  detail: "FileVault on",
  ...o,
});

proves(
  ["073-freshness FR-001"],
  "073: cadence defaults: verify every 15 minutes, the rest daily, stale after twice",
  () => {
    const c = resolveCadences();
    assertEquals(DEFAULT_CADENCES.managed.every, "15m");
    assertEquals([c.sources.managed.every, c.sources.managed.staleAfter], ["15m", "30m"]);
    for (const s of ["adopted", "device", "cloud"] as const) {
      assertEquals(
        [c.sources[s].every, c.sources[s].staleAfter, c.sources[s].from],
        ["1d", "2d", "default"],
      );
    }
    assertEquals(durationMs("6h"), 6 * H);
    assertThrows(() => durationMs("5x"), Error, "not a duration");
    assertThrows(() => durationMs("0d"), Error, "not a duration");
  },
);

proves(
  ["073-freshness FR-001", "073-freshness FR-002"],
  "073: a connector's own cadence, the fleet's overrides, and the 7-day cap",
  () => {
    const c = resolveCadences({
      connectors: [
        { id: "bamboohr", cadence: { every: "7d" } },
        { id: "okta" },
        {
          id: "github",
          cadence: { every: "6h" },
        },
      ],
      fleet: {
        managed: { every: "1h" },
        cloud: { every: "12h", staleAfter: "1d" },
        connectors: { github: { every: "1d", staleAfter: "3d" } },
      },
    });
    assertEquals([c.sources.managed.staleAfter, c.sources.managed.from], ["2h", "fleet"]);
    assertEquals([c.sources.cloud.every, c.sources.cloud.staleAfter], ["12h", "1d"]);
    // The connector's own: 7 days, twice is 14, capped at FedRAMP 20x's longest (7 days).
    const bamboohr = got(c.connectors["bamboohr"]);
    assertEquals(bamboohr.staleAfter, "7d");
    assertEquals(bamboohr.capped, true);
    assertEquals(bamboohr.from, "connector");
    // The fleet's per-connector override wins over the connector's own.
    const github = got(c.connectors["github"]);
    assertEquals([github.staleAfter, github.from], ["3d", "fleet"]);
    // Without its own, a connector takes the fleet's cloud cadence.
    assertEquals(c.connectors["okta"], undefined);
    const v = freshView(
      [ev({ source: "cloud", connector: "okta", observedAt: ago(30 * H) })],
      undefined,
      {
        cadences: c,
        now: NOW,
      },
    );
    assertEquals(got(v.controls.find((x) => x.control.id === "CRY-07")).status, "fail");
    // A service level shorter than the cadence is raised to it.
    assertEquals(cadence({ every: "1d", staleAfter: "1h" }).staleAfter, "1d");
  },
);

proves(
  ["073-freshness FR-004"],
  "073: stale evidence is a failing check of its controls and of MON-02, with its refresh",
  () => {
    const v = freshView(
      [
        ev({ subject: "m1", observedAt: ago(3 * D) }),
        ev({ subject: "m2", observedAt: ago(1 * H) }),
        ev({ subject: "m3", status: "unknown", observedAt: ago(30 * D) }),
        ev({ source: "repository", subject: "example/fleet", scf: ["CHG-03"] }),
      ],
      undefined,
      { now: NOW },
    );
    const cry = got(v.controls.find((c) => c.control.id === "CRY-07"));
    assertEquals(cry.status, "fail");
    const m1 = got(cry.evidence.find((e) => e.subject === "m1"));
    assertEquals(m1.status, "fail");
    assertEquals(m1.stale?.was, "pass");
    assertEquals(m1.stale?.staleAfter, "2d");
    assertEquals(m1.fix, "bun run stolos host observe m1");
    assert(m1.detail.includes("stale: observed 3d ago"), m1.detail);
    assertEquals(got(cry.evidence.find((e) => e.subject === "m2")).status, "pass");
    assertEquals(got(cry.evidence.find((e) => e.subject === "m3")).stale, undefined);
    const mon = got(v.controls.find((c) => c.control.id === "MON-02"));
    assertEquals(mon.status, "fail");
    assertEquals(
      mon.evidence.map((e) => e.subject),
      ["m1"],
    );
    assertEquals(got(v.controls.find((c) => c.control.id === "CHG-03")).status, "pass");
    assertEquals(
      staleSubjects(v).map((s) => [s.subject, s.checks]),
      [["m1", 1]],
    );
  },
);

proves(
  ["073-freshness FR-005"],
  "073: each control's evidence age: newest and oldest, timed and untimed",
  () => {
    const v = freshView(
      [
        ev({ subject: "m1", observedAt: ago(1 * H) }),
        ev({ subject: "m2", observedAt: ago(5 * H) }),
        ev({ source: "repository", subject: "example/fleet" }),
      ],
      undefined,
      { now: NOW },
    );
    const f = got(v.controls.find((c) => c.control.id === "CRY-07")).freshness;
    assertEquals(
      [f.newestAgeMs, f.oldestAgeMs, f.timed, f.untimed, f.stale],
      [1 * H, 5 * H, 2, 1, 0],
    );
    assertEquals(f.newest, ago(1 * H));
    assertEquals(v.asOf, new Date(NOW).toISOString());
    const none = controlFreshness(got(v.controls.find((c) => c.control.id === "BCD-02")), NOW);
    assertEquals([none.newest, none.timed], [undefined, 0]);
    // --json carries the ages.
    const json = JSON.parse(JSON.stringify(v)) as {
      controls: Array<{ control: { id: string }; freshness: { oldestAgeMs?: number } }>;
    };
    assertEquals(
      json.controls.find((c) => c.control.id === "CRY-07")?.freshness.oldestAgeMs,
      5 * H,
    );
  },
);

proves(
  ["073-freshness FR-003"],
  "073: the fleet's evidence is stamped from what the console knows",
  () => {
    const now = Date.now();
    const stamped = stampEvidence(fleetEvidence(FACTS, now), FACTS);
    const alpha = got(stamped.find((e) => e.source === "managed" && e.subject === "alpha"));
    assertEquals(
      alpha.observedAt,
      got(got(FACTS.machines.find((m) => m.name === "alpha")).sync).at,
    );
    const cloud = got(stamped.find((e) => e.source === "cloud"));
    assert(cloud.connector && cloud.observedAt, "a connector's id and its observation time");
    assert(stamped.filter((e) => e.source === "repository").every((e) => !e.observedAt));
    // A day later, every managed server's evidence (30 minutes) is stale; the page says so.
    const later = fleetFreshView(FACTS, undefined, { now: now + D });
    assert(staleSubjects(later).some((s) => s.source === "managed" && s.subject === "alpha"));
    const page = compliancePage(later, undefined, "lab", undefined, new Date(now + D)).toString();
    assert(page.includes(">stale<"), "a stale pill");
    assert(page.includes("Observed"), "an Observed column");
    assert(page.includes("bun run stolos fleet status"), "the refresh command");
  },
);

// ------------------------------------------------------------------- drift

const fake: Connector = {
  id: "fakeidp",
  serviceModels: ["SaaS"],
  markets: [],
  title: "Fake IdP",
  logo: "",
  connectHelp: [],
  recipe: {},
  fields: [],
  observe: () => Promise.reject(new Error("not in tests")),
  policies: (o) => [
    check(o, {
      id: "mfa",
      title: "Everyone signs in with MFA",
      scf: ["IAC-37"],
      fact: "mfa",
      want: (v) => v === true,
      fix: "turn on MFA",
    }),
  ],
};

const observation = (at: string, mfa: boolean): Observation => ({
  at,
  provider: "fakeidp",
  account: "example.org",
  assets: [],
  posture: { mfa, note: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
  gaps: [],
});

async function git(dir: string, at: string, ...args: string[]): Promise<string> {
  const r = await proc.run(["git", ...args], {
    cwd: dir,
    stdin: "null",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_DATE: at,
    },
  });
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

async function observe(dir: string, o: Observation): Promise<void> {
  await fs.mkdir(`${dir}/fleets/lab/estate`, { recursive: true });
  await fs.writeTextFile(
    `${dir}/fleets/lab/estate/fakeidp.ts`,
    `// GENERATED\nimport type { Observation } from "@intellectual-frontiers/stolos/archon/connect/connector";\n\nexport const observed: Observation = ${tsLiteral(
      o as unknown as Literal,
    )};\n`,
  );
}

proves(
  ["073-freshness FR-006"],
  "073: drift: what changed between a past commit and now, worse first",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const t1 = "2026-11-10T08:00:00Z";
      await git(dir, t1, "init", "-q", "-b", "main");
      await git(dir, t1, "config", "user.name", "T");
      await git(dir, t1, "config", "user.email", "t@example.org");
      await observe(dir, observation(t1, true));
      await git(dir, t1, "add", "-A");
      await git(dir, t1, "commit", "-q", "-m", "observe");
      const first = await git(dir, t1, "rev-parse", "HEAD");
      // Now: MFA is off.
      const t2 = "2026-11-15T11:00:00Z";
      await observe(dir, observation(t2, false));
      const d = await drift({
        repo: dir,
        fleet: "lab",
        since: first,
        now: NOW,
        connectors: [fake],
        cadences: resolveCadences(),
      });
      assert(!("error" in d), JSON.stringify(d));
      assertEquals(d.since, { rev: first, at: "2026-11-10T08:00:00.000Z" });
      const iac = got(d.changes.find((c) => c.id === "IAC-37"));
      assertEquals([iac.from, iac.to, iac.worse], ["pass", "fail", true]);
      assertEquals(
        iac.evidence.map((e) => [e.subject, e.from, e.to]),
        [["Fake IdP (example.org)", "pass", "fail"]],
      );
      // By date: the last commit before it.
      const byDate = await drift({
        repo: dir,
        fleet: "lab",
        since: "2026-11-12",
        now: NOW,
        connectors: [fake],
      });
      assert(!("error" in byDate) && byDate.since.rev === first);
      const none = await drift({
        repo: dir,
        fleet: "lab",
        since: "2020-01-01",
        connectors: [fake],
      });
      assert("error" in none);
      // Evidence that went stale is drift too: MFA still on, but observed 5 days ago.
      await observe(dir, observation(t1, true));
      const stale = await drift({
        repo: dir,
        fleet: "lab",
        since: first,
        now: NOW,
        connectors: [fake],
      });
      assert(!("error" in stale));
      const mon = got(stale.changes.find((c) => c.id === "MON-02"));
      assertEquals([mon.from, mon.to], ["no evidence", "fail"]);
      assert(mon.evidence[0]?.stale);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["073-freshness FR-006"],
  "073: compareViews: an unchanged control is not drift; a better one is not worse",
  () => {
    const before = complianceView([ev({ status: "fail" })]);
    const after = complianceView([ev({ status: "pass" })]);
    assertEquals(compareViews(after, after), []);
    const c = got(compareViews(before, after)[0]);
    assertEquals([c.id, c.from, c.to, c.worse], ["CRY-07", "fail", "pass", false]);
  },
);

proves(
  ["073-freshness FR-006"],
  "073: the drift message for the fleet's mailbox has no secret and no detail",
  async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const before = complianceView([ev({ detail: "fine" })]);
    const after = complianceView([ev({ status: "fail", detail: `off; token=${secret}` })]);
    const ev1 = driftEvent({
      fleet: "lab",
      since: { rev: "0123456789abcdef", at: "2026-11-14T12:00:00.000Z" },
      now: { at: "2026-11-15T12:00:00.000Z" },
      changes: compareViews(before, after),
    });
    assertEquals(ev1.level, "fail");
    assert(ev1.what.includes("CRY-07"), ev1.what);
    assert(ev1.what.includes("m1 (adopted): The disk is encrypted: pass -> fail"), ev1.what);
    assert(!ev1.what.includes(secret) && !ev1.what.includes("off;"), "no detail in the body");
    const dir = await fs.makeTempDir();
    try {
      const site: Site = {
        role: "boot",
        name: "pc",
        credential: `${dir}/mail.json`,
        spool: dir,
        status: `${dir}/status.json`,
        to: "fleet@example.org",
        relay: "smtp.example.org:465",
        ipv4: true,
        timezone: "UTC",
      };
      const q = await compose(site, ev1, [secret]);
      for (const part of [q.subject, q.text, q.html]) assert(!part.includes(secret));
      assert(q.text.includes("What to do:") && q.text.includes("bun run stolos compliance"));
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

/** The value the test expects to be there. */
function got<T>(value: T | undefined | null, what = "a value"): T {
  assertExists(value, `${what} is missing`);
  return value;
}
