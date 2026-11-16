/**
 * Spec 077: people controls as code: joiners and leavers, access reviews, policies, training.
 *
 * @module
 */
import { array, type Decoder, json, object, string } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path as paths, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
  the,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import type { Observation } from "../src/archon/connect/connector.ts";
import type { Account, Person } from "../src/archon/connect/entities.ts";
import { fixtureEstate, testControl } from "../src/archon/controls/testing.ts";
import { isScfId } from "../src/archon/compliance/scf.ts";
import { loadScf } from "../src/archon/compliance/catalog.ts";
import { nameProblems } from "../src/archon/schema/vocabulary.ts";
import {
  acksControl,
  deprovisionControl,
  joinersControl,
  LEAVERS,
  onLeaveControl,
  peopleControls,
  type PeopleFacts,
  peoplePack,
  policyReviewControl,
  requiredSystems,
  reviewsControl,
  screeningControl,
  trainingControl,
} from "../src/archon/people/controls.ts";
import {
  accountActivity,
  gitIn,
  quarterReviews,
  reviewEvidence,
  verifiedAcks,
} from "../src/archon/people/git.ts";
import {
  frontMatter,
  isQuarter,
  parsePolicy,
  PERSON_RECORD,
  previousQuarter,
  quarterDays,
  quarterOf,
  quartersIn,
  readPeopleFiles,
} from "../src/archon/people/records.ts";
import { reviewFiles, reviewTicks } from "../src/archon/people/reviews.ts";
import { acksSource, peopleResults } from "../src/archon/people/commands.ts";
import { gitReader } from "../src/archon/estate/snapshot.ts";
import type { SignerDef } from "../src/archon/model/types.ts";
import { linkEngine, sandbox } from "./sandbox.ts";

const NOW = new Date("2026-11-15T12:00:00Z");

const obs = (
  provider: string,
  at: string,
  entities: Observation["entities"],
  records?: Observation["records"],
): Observation => ({
  at,
  provider,
  account: `${provider}.example`,
  assets: [],
  posture: {},
  gaps: [],
  ...(entities ? { entities } : {}),
  ...(records ? { records } : {}),
});

const person = (email: string, p: Partial<Person> = {}): Person => ({
  email,
  status: "active",
  type: "employee",
  start: "2024-01-01",
  ...p,
});

const account = (system: string, who: string, active = true, admin = false): Account => ({
  system,
  id: who,
  name: system === "google" ? `${who}@example.org` : who,
  email: `${who}@example.org`,
  active,
  admin,
});

/** The roster: carol manages bob and frank; bob manages alice, dave (left), and erin (on leave). */
const PEOPLE: Person[] = [
  person("alice@example.org", { manager: "bob@example.org" }),
  person("bob@example.org", { manager: "carol@example.org" }),
  person("carol@example.org"),
  person("dave@example.org", {
    status: "terminated",
    end: "2026-10-01",
    manager: "bob@example.org",
  }),
  person("erin@example.org", { status: "leave", manager: "bob@example.org" }),
  person("frank@example.org", {
    start: "2026-11-10",
    type: "contractor",
    manager: "carol@example.org",
  }),
];

const google = (at: string, daveActive: boolean) =>
  obs("google", at, {
    accounts: [
      account("google", "alice"),
      account("google", "bob"),
      account("google", "carol"),
      account("google", "dave", daveActive),
      account("google", "erin"),
    ],
  });
const github = obs("github", "2026-11-14T00:00:00Z", {
  accounts: [account("github", "alice", true, true), account("github", "bob")],
});

const estateWith = (daveActive: boolean) =>
  fixtureEstate(
    {
      sources: [
        {
          connector: "bamboohr",
          observation: obs("bamboohr", "2026-11-14T00:00:00Z", { people: PEOPLE }),
        },
        { connector: "google", observation: google("2026-11-14T00:00:00Z", daveActive) },
        { connector: "github", observation: github },
      ],
    },
    NOW,
  );

const facts = (f: Partial<PeopleFacts> = {}): PeopleFacts => ({
  reviewQuarter: "2026-Q3",
  policies: [],
  acks: [],
  activity: new Map(),
  ...f,
});

proves(
  ["077-people-controls FR-001"],
  "077: a leaver with active accounts fails (the estate's own leavers control)",
  () => {
    const [r] = testControl(LEAVERS, { estate: estateWith(true), now: NOW });
    assertExists(r);
    assertEquals(r.status, "fail");
    assertStringIncludes(r.detail, "dave@example.org in google");
    assertEquals(r.subjects, ["google:google.example:dave"]);
    const [off] = testControl(LEAVERS, { estate: estateWith(false), now: NOW });
    assertExists(off);
    assertEquals(off.status, "pass");
    // people status runs it first, under its own id, beside the people controls.
    const all = peopleResults(estateWith(true), facts(), { now: NOW });
    assertEquals(the(all[0]).id, "leavers");
    assertEquals(the(all[0]).status, "fail");
    assert(!peopleControls(facts()).some((c) => c.id === "leavers"), "not repeated");
  },
);

proves(
  ["077-people-controls FR-002", "077-people-controls FR-003"],
  "077: a joiner without the accounts their role needs is named; on leave too",
  () => {
    const roles = { "*": ["google"], employee: ["github"], contractor: ["slack"] };
    assertEquals(requiredSystems(roles, ["employee"]), ["github", "google"]);
    const [r] = testControl(joinersControl(facts({ roles })), {
      estate: estateWith(false),
      now: NOW,
    });
    assertExists(r);
    assertEquals(r.status, "warn");
    // carol (an employee) has no github account; frank (a contractor, 5 days in) has nothing.
    // slack is not connected, so it is not asked for.
    assertStringIncludes(r.detail, "carol@example.org needs github");
    assertStringIncludes(r.detail, "frank@example.org needs google (started 5 day(s) ago)");
    assert(!r.detail.includes("alice"), r.detail);
    assertEquals(r.subjects, ["person:carol@example.org", "person:frank@example.org"]);
    // Without roles.ts, it does not apply.
    assertEquals(testControl(joinersControl(facts()), { estate: estateWith(false), now: NOW }), []);
    const [leave] = testControl(onLeaveControl(), { estate: estateWith(false), now: NOW });
    assertExists(leave);
    assertEquals(leave.status, "warn");
    assertStringIncludes(leave.detail, "erin@example.org in google");
  },
);

proves(
  ["077-people-controls FR-004"],
  "077: time to deprovision, from the history of the observations",
  () => {
    // dave's google account: active on 09-20 and 10-04 (after his end date, 10-01), off on 10-06.
    const versions = [
      { connector: "google", observation: google("2026-10-06T10:00:00Z", false) },
      { connector: "google", observation: google("2026-09-20T10:00:00Z", true) },
      { connector: "google", observation: google("2026-10-04T10:00:00Z", true) },
      // erin's account disappears from a later observation: gone counts as off.
      {
        connector: "google",
        observation: obs("google", "2026-10-08T10:00:00Z", {
          accounts: [account("google", "alice"), account("google", "dave", false)],
        }),
      },
    ];
    const activity = accountActivity(versions);
    assertEquals(activity.get("google:google.example:dave"), {
      lastActive: "2026-10-04T10:00:00Z",
      offBy: "2026-10-06T10:00:00Z",
    });
    assertEquals(activity.get("google:google.example:erin")?.offBy, "2026-10-08T10:00:00Z");
    const [r] = testControl(deprovisionControl(facts({ activity })), {
      estate: estateWith(false),
      now: NOW,
    });
    assertExists(r);
    assertEquals(r.status, "warn");
    assertStringIncludes(r.detail, "dave@example.org in google, 3 day(s)");
    // Within two days' target it passes.
    const [ok] = testControl(deprovisionControl(facts({ activity, deprovisionDays: 3 })), {
      estate: estateWith(false),
      now: NOW,
    });
    assertExists(ok);
    assertEquals(ok.status, "pass");
    assertStringIncludes(ok.detail, "the slowest after 3 day(s)");
  },
);

proves(
  ["077-people-controls FR-005"],
  "077: review files, one per manager, from the estate",
  () => {
    const files = reviewFiles(estateWith(true), "2026-Q4", NOW);
    assertEquals(
      files.map((f) => f.path),
      ["people/reviews/2026-Q4/bob@example.org.md", "people/reviews/2026-Q4/carol@example.org.md"],
    );
    const bob = the(files[0]).text;
    assertStringIncludes(bob, "manager: bob@example.org");
    assertStringIncludes(
      bob,
      "## alice@example.org (employee)\n\n- [ ] github: alice (admin)\n- [ ] google: alice@example.org",
    );
    assertStringIncludes(bob, "## erin@example.org (employee, on leave)");
    assert(!bob.includes("dave"), "a leaver is not reviewed (the leavers control is his)");
    const carol = the(files[1]).text;
    assertStringIncludes(carol, "## frank@example.org (contractor)\n\n- [ ] no active accounts");
    assertEquals(the(files[0]).lines, 3);
    assertEquals(reviewTicks(bob), { ticked: 0, lines: 3 });
    assertEquals(reviewTicks(bob.replaceAll("- [ ]", "- [x]")), { ticked: 3, lines: 3 });
  },
);

proves(["077-people-controls FR-009"], "077: quarters, front matter, and policies", () => {
  assertEquals(quarterOf(NOW), "2026-Q4");
  assertEquals(previousQuarter("2026-Q1"), "2025-Q4");
  assertEquals(quarterDays("2026-Q3"), { from: "2026-07-01", to: "2026-09-30" });
  assertEquals(quartersIn("2026-02-01", "2026-07-15"), ["2026-Q1", "2026-Q2", "2026-Q3"]);
  assert(isQuarter("2026-Q4") && !isQuarter("2026-Q5"));
  assertEquals(frontMatter('---\ntitle: X\nversion: "1.0"\n---\nbody\n').meta, {
    title: "X",
    version: "1.0",
  });
  const p = parsePolicy("acceptable-use.md", "---\ntitle: Acceptable use\nversion: 1.2\n---\n");
  assertEquals(p.problems, [
    "policies/acceptable-use.md: no owner in its front matter",
    "policies/acceptable-use.md: no review in its front matter",
  ]);
  const overdue = { ...p, owner: "alice@example.org", review: "2026-11-01", problems: [] };
  const [r] = testControl(policyReviewControl(facts({ policies: [overdue] })), {
    estate: estateWith(false),
    now: NOW,
  });
  assertExists(r);
  assertEquals(r.status, "fail");
  assertStringIncludes(r.detail, "acceptable-use (2026-11-01)");
  const [fine] = testControl(
    policyReviewControl(facts({ policies: [{ ...overdue, review: "2027-06-30" }] })),
    { estate: estateWith(false), now: NOW },
  );
  assertExists(fine);
  assertEquals(fine.status, "pass");
});

proves(
  ["077-people-controls FR-011"],
  "077: training within 12 months, and screening on file, from files or a connector",
  () => {
    const training = [
      {
        email: "alice@example.org",
        course: "awareness",
        date: "2026-03-01",
        result: "passed" as const,
      },
      {
        email: "bob@example.org",
        course: "awareness",
        date: "2025-10-01",
        result: "passed" as const,
      },
      {
        email: "carol@example.org",
        course: "awareness",
        date: "2026-06-01",
        result: "failed" as const,
      },
    ];
    const [t] = testControl(trainingControl(facts({ training })), {
      estate: estateWith(false),
      now: NOW,
    });
    assertExists(t);
    assertEquals(t.status, "fail");
    assertStringIncludes(
      t.detail,
      "since 2025-11-15: bob@example.org, carol@example.org, frank@example.org",
    );
    // No records at all: it does not apply.
    assertEquals(
      testControl(trainingControl(facts()), { estate: estateWith(false), now: NOW }),
      [],
    );
    // A connector's records count too (person_record).
    assertEquals(nameProblems(PERSON_RECORD.name, PERSON_RECORD.terms), []);
    const lms = fixtureEstate(
      {
        sources: [
          {
            connector: "bamboohr",
            observation: obs("bamboohr", "2026-11-14T00:00:00Z", { people: PEOPLE.slice(0, 2) }),
          },
          {
            connector: "learning",
            observation: obs(
              "learning",
              "2026-11-14T00:00:00Z",
              undefined,
              ["alice", "bob"].map((w) => ({
                label: PERSON_RECORD.name,
                ocsf_class_uid: 5003,
                native_id: `${w}-1`,
                display_name: `${w} awareness`,
                props: {
                  email: `${w}@example.org`,
                  kind: "training",
                  subject: "awareness",
                  date: "2026-09-01",
                  result: "passed",
                },
              })),
            ),
          },
        ],
      },
      NOW,
    );
    const [c] = testControl(trainingControl(facts()), { estate: lms, now: NOW });
    assertExists(c);
    assertEquals(c.status, "pass");
    const screening = [
      {
        email: "alice@example.org",
        check: "background",
        date: "2024-01-01",
        result: "clear" as const,
      },
      {
        email: "bob@example.org",
        check: "background",
        date: "2024-01-01",
        result: "not clear" as const,
      },
    ];
    const [s] = testControl(screeningControl(facts({ screening })), {
      estate: estateWith(false),
      now: NOW,
    });
    assertExists(s);
    assertEquals(s.status, "fail");
    assertStringIncludes(s.detail, "2 without a screening: carol@example.org, frank@example.org");
    assertStringIncludes(s.detail, "not clear: bob@example.org");
    assert(!s.detail.includes("alice"), s.detail);
  },
);

proves(
  ["077-people-controls FR-012", "077-people-controls FR-014"],
  "077: every SCF id the people controls cite is one Stolos knows, and the pack is well formed",
  () => {
    const pack = peoplePack(facts());
    assertEquals(pack.id, "people");
    const ids = [...new Set([...LEAVERS.scf, ...pack.controls.flatMap((c) => c.scf)])].sort();
    assertEquals(ids, [
      "GOV-04.1",
      "HRS-05",
      "HRS-08",
      "HRS-08.2",
      "HRS-12",
      "IAC-04",
      "IAC-08",
      "IAC-12",
      "SAT-04",
      "SAT-10",
    ]);
    for (const id of ids) assert(isScfId(id), id);
  },
);

const catalog = await loadScf().catch(() => undefined);
proves(
  ["077-people-controls FR-014"],
  "077: every SCF id the people controls cite is in the SCF release (when the catalog is cached)",
  () => {
    for (const c of [LEAVERS, ...peopleControls(facts())]) {
      for (const id of c.scf) {
        assert(the(catalog).controls[id], `${id} is not in SCF ${the(catalog).version}`);
      }
    }
  },
  { skip: !catalog && "the SCF catalog is not cached here" },
);

// Signed commits, in a temporary Git repository.

async function sh(args: string[], cwd?: string, env: Record<string, string> = {}) {
  const r = await proc.run(args, {
    ...(cwd ? { cwd } : {}),
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  assertExists(r);
  if (!r.success) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function keyPair(dir: string, name: string): Promise<{ key: string; pub: string }> {
  const key = `${dir}/${name}`;
  await sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  return {
    key,
    pub: (await fs.readTextFile(key + ".pub")).trim().split(/\s+/).slice(0, 2).join(" "),
  };
}

const hasSsh = proc.which("ssh-keygen") !== undefined;

/** A fleet repository; `commit` makes a commit signed with a key (or unsigned). */
async function repoFixture() {
  const dir = await fs.makeTempDir();
  const keys = {
    alice: await keyPair(dir, "alice"),
    bob: await keyPair(dir, "bob"),
    carol: await keyPair(dir, "carol"),
    signer: await keyPair(dir, "ops-daily"),
    mallory: await keyPair(dir, "mallory"),
  };
  const repo = `${dir}/repo`;
  await fs.mkdir(`${repo}/fleets/lab/people`, { recursive: true });
  await sh(["git", "init", "-q", "-b", "main"], repo);
  for (const [k, v] of [
    ["user.name", "Ops"],
    ["user.email", "ops@example.org"],
    ["gpg.format", "ssh"],
  ] as const)
    await sh(["git", "config", k, v], repo);
  let tick = 0;
  const commit = async (message: string, key?: string) => {
    const date = new Date(Date.UTC(2026, 8, 1) + tick++ * 3_600_000).toISOString();
    await sh(["git", "add", "-A"], repo);
    await sh(
      [
        "git",
        ...(key
          ? ["-c", `user.signingkey=${key}`, "-c", "commit.gpgsign=true"]
          : ["-c", "commit.gpgsign=false"]),
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        message,
      ],
      repo,
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    );
    return (await sh(["git", "rev-parse", "HEAD"], repo)).trim();
  };
  const write = async (path: string, text: string) => {
    await fs.mkdir(`${repo}/${path}`.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeTextFile(`${repo}/${path}`, text);
  };
  await write(
    "fleets/lab/people/keys.ts",
    `export const keys = {\n${(["alice", "bob", "carol"] as const)
      .map((w) => `  "${w}@example.org": "${keys[w].pub}",\n`)
      .join("")}};\n`,
  );
  await commit("people: keys", keys.signer.key);
  const signers: SignerDef[] = [
    {
      name: "ops-daily",
      role: "daily",
      key: keys.signer.pub,
      added: "2026-01-01",
    },
  ];
  return { dir, repo, keys, signers, commit, write };
}

proves(
  ["077-people-controls FR-006", "077-people-controls FR-007", "077-people-controls FR-008"],
  "077: a review is approved only by a signed commit of the manager's own key or a fleet signer",
  async () => {
    const f = await repoFixture();
    try {
      const files = reviewFiles(estateWith(false), "2026-Q3", new Date("2026-09-01T00:00:00Z"));
      for (const r of files) await f.write(`fleets/lab/${r.path}`, r.text);
      await f.commit("people: access reviews for 2026-Q3", f.keys.signer.key);
      const git = gitIn(f.repo);
      const { keys } = await readPeopleFiles(gitReader(f.repo), "fleets/lab");
      const status = () => quarterReviews(git, "fleets/lab", "2026-Q3", keys, f.signers);
      let s = await status();
      assertEquals(
        s.map((x) => [x.manager, x.approvedBy, x.why]),
        [
          ["bob@example.org", undefined, "3 of 3 line(s) not ticked"],
          ["carol@example.org", undefined, "3 of 3 line(s) not ticked"],
        ],
      );
      // bob ticks every line, but mallory signs it: not an approval.
      const bobPath = "fleets/lab/people/reviews/2026-Q3/bob@example.org.md";
      await f.write(bobPath, the(files[0]).text.replaceAll("- [ ]", "- [x]"));
      await f.commit("people: bob's review", f.keys.mallory.key);
      s = await status();
      assertEquals(
        the(s[0]).why,
        "not signed by the manager's own key (people/keys.ts) or a fleet signer",
      );
      // alice's own key is good, but alice is not bob: not an approval either.
      await f.commit("people: bob's review, again", f.keys.alice.key);
      await f.write(bobPath, the(files[0]).text.replaceAll("- [ ]", "- [x]") + "\n");
      await f.commit("people: bob's review, by alice", f.keys.alice.key);
      assertEquals(the((await status())[0]).approvedBy, undefined);
      // bob signs it himself.
      await f.write(bobPath, the(files[0]).text.replaceAll("- [ ]", "- [x]"));
      const bobSha = await f.commit("people: bob approves 2026-Q3", f.keys.bob.key);
      s = await status();
      assertEquals([the(s[0]).approvedBy, the(s[0]).commit], ["bob@example.org", bobSha]);
      // The control: carol's review is missing an approval; then a fleet signer approves it as it is.
      const control = (reviews: typeof s) =>
        testControl(reviewsControl(facts({ reviews })), { estate: estateWith(false), now: NOW })[0];
      let r = control(s);
      assertExists(r);
      assertEquals(r.status, "fail");
      assertStringIncludes(
        r.detail,
        "2026-Q3: not approved: carol@example.org (3 of 3 line(s) not ticked)",
      );
      await f.commit(
        "people: carol's review\n\nAccess-Review: 2026-Q3/carol@example.org",
        f.keys.mallory.key,
      );
      assertEquals(
        the((await status())[1]).approvedBy,
        undefined,
        "mallory's trailer approves nothing",
      );
      await f.commit(
        "people: carol's review\n\nAccess-Review: 2026-Q3/carol@example.org",
        f.keys.signer.key,
      );
      s = await status();
      assertEquals(the(s[1]).approvedBy, "ops-daily");
      r = control(s);
      assertExists(r);
      assertEquals(r.status, "pass");
      assertStringIncludes(r.detail, "bob@example.org by bob@example.org");
      // A manager with no file at all fails.
      assertStringIncludes(
        control(s.slice(0, 1))?.detail ?? "",
        "2026-Q3: no review for carol@example.org",
      );
      // The evidence, by itself: each file as approved, and its raw signed commit.
      const items = await reviewEvidence(git, s);
      assertEquals(
        items.map((i) => i.kind),
        ["people", "commit", "people", "commit"],
      );
      assertStringIncludes(the(items[0]).name, "bob@example.org.md @ ");
      assertStringIncludes(the(items[0]).name, "approved by bob@example.org");
      assertStringIncludes(
        new TextDecoder().decode(the(items[0]).content),
        "- [x] github: alice (admin)",
      );
      assertStringIncludes(new TextDecoder().decode(the(items[1]).content), "BEGIN SSH SIGNATURE");
      assertEquals(the(items[1]).name, `commit ${bobSha}`);
    } finally {
      await fs.remove(f.dir, { recursive: true });
    }
  },
  { skip: !hasSsh && "needs ssh-keygen", timeout: 120_000 },
);

proves(
  ["077-people-controls FR-010"],
  "077: a policy acknowledgement is a commit signed by the person's own key",
  async () => {
    const f = await repoFixture();
    try {
      await f.write(
        "fleets/lab/policies/acceptable-use.md",
        "---\ntitle: Acceptable use\nversion: 1.2\nowner: carol@example.org\nreview: 2027-06-30\n---\n\n# Acceptable use\n",
      );
      await f.commit("policies: acceptable use 1.2", f.keys.signer.key);
      await f.write(
        "fleets/lab/policies/acks/acceptable-use.ts",
        acksSource([{ email: "alice@example.org", version: "1.2", date: "2026-09-02" }]),
      );
      await f.commit(
        "people: alice@example.org acknowledges Acceptable use 1.2\n\nAcknowledges: acceptable-use@1.2",
        f.keys.alice.key,
      );
      // mallory claims bob acknowledged; it is mallory's signature, so nothing.
      await f.commit(
        "people: bob acknowledges\n\nAcknowledges: acceptable-use@1.2",
        f.keys.mallory.key,
      );
      // An unsigned one counts for no one.
      await f.commit("people: carol acknowledges\n\nAcknowledges: acceptable-use@1.2");
      const files = await readPeopleFiles(gitReader(f.repo), "fleets/lab");
      assertEquals(
        files.policies.map((p) => [p.id, p.version, p.review]),
        [["acceptable-use", "1.2", "2027-06-30"]],
      );
      assertEquals(
        the(files.acks["acceptable-use"]).map((a) => a.email),
        ["alice@example.org"],
      );
      const acks = await verifiedAcks(gitIn(f.repo), files.keys);
      assertEquals(
        acks.map((a) => [a.email, a.policy, a.version]),
        [["alice@example.org", "acceptable-use", "1.2"]],
      );
      const estate = fixtureEstate(
        {
          sources: [
            {
              connector: "bamboohr",
              observation: obs("bamboohr", "2026-11-14T00:00:00Z", { people: PEOPLE.slice(0, 3) }),
            },
          ],
        },
        NOW,
      );
      const [r] = testControl(acksControl(facts({ policies: files.policies, acks })), {
        estate,
        now: NOW,
      });
      assertExists(r);
      assertEquals(r.status, "fail");
      assertStringIncludes(
        r.detail,
        "2 person(s) owe an acknowledgement: bob@example.org: acceptable-use 1.2, carol@example.org",
      );
      // bob and carol sign their own; then everyone has acknowledged 1.2.
      await f.commit("people: bob\n\nAcknowledges: acceptable-use@1.2", f.keys.bob.key);
      await f.commit("people: carol\n\nAcknowledges: acceptable-use@1.2", f.keys.carol.key);
      const all = await verifiedAcks(gitIn(f.repo), files.keys);
      const [ok] = testControl(acksControl(facts({ policies: files.policies, acks: all })), {
        estate,
        now: NOW,
      });
      assertExists(ok);
      assertEquals(ok.status, "pass");
      // A new version is owed again.
      const v13 = files.policies.map((p) => ({ ...p, version: "1.3" }));
      const [again] = testControl(acksControl(facts({ policies: v13, acks: all })), {
        estate,
        now: NOW,
      });
      assertExists(again);
      assertEquals(again.status, "fail");
    } finally {
      await fs.remove(f.dir, { recursive: true });
    }
  },
  { skip: !hasSsh && "needs ssh-keygen" },
);

proves(
  ["077-people-controls FR-012", "077-people-controls FR-013"],
  "077: in a temporary fleet repository: people status, people review --check, compliance",
  async () => {
    const sb = await sandbox("stolos-people-");
    try {
      const repo = paths.join(sb.home, "fleet");
      await fs.mkdir(paths.join(repo, "fleets"), { recursive: true });
      const init = await proc.output(["git", "init", "-q", repo]);
      assert(init.success);
      await linkEngine(repo);
      await proc.output(["cp", "-r", "examples/fleets/lab", paths.join(repo, "fleets", "lab")]);
      const lab = paths.join(repo, "fleets", "lab");
      await fs.mkdir(paths.join(lab, "estate"), { recursive: true });
      await fs.mkdir(paths.join(lab, "people"), { recursive: true });
      const observed = (o: Observation) =>
        `// GENERATED\nexport const observed = ${JSON.stringify(o, null, 2)};\n`;
      await fs.writeTextFile(
        paths.join(lab, "estate", "bamboohr.ts"),
        observed(obs("bamboohr", "2026-11-14T00:00:00Z", { people: PEOPLE })),
      );
      await fs.writeTextFile(
        paths.join(lab, "estate", "google.ts"),
        observed(google("2026-11-14T00:00:00Z", true)),
      );
      await fs.writeTextFile(
        paths.join(lab, "people", "roles.ts"),
        `export const roles = {\n  "*": ["google", "github"],\n};\n`,
      );
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      const jsonIn = <T>(out: string, d: Decoder<T>): T => {
        const r = json(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1), d);
        assert(r.kind === "ok", out);
        return r.value;
      };
      const st = await sb.run("src/stolos/main.ts", ["people", "status", "--json"], "", env);
      assertEquals(st.code, 1, st.out);
      const status = jsonIn(
        st.out,
        object({ results: array(object({ id: string, status: string })) }),
      );
      const byId = Object.fromEntries(status.results.map((r) => [r.id, r.status]));
      assertEquals(byId["leavers"], "fail");
      assertEquals(byId["people/on-leave"], "warn");
      assertEquals(byId["people/access-reviews"], "fail");
      const rv = await sb.run(
        "src/stolos/main.ts",
        ["people", "review", "--check", "--quarter", "2026-Q4"],
        "",
        env,
      );
      assertEquals(rv.code, 0, rv.out);
      assertStringIncludes(rv.out, "people/reviews/2026-Q4/bob@example.org.md");
      const c = await sb.run("src/stolos/main.ts", ["compliance", "--json"], "", env);
      const view = jsonIn(
        c.out,
        object({
          controls: array(
            object({
              control: object({ id: string }),
              evidence: array(object({ source: string, check: string, status: string })),
            }),
          ),
        }),
      );
      const iac12 = the(view.controls.find((x) => x.control.id === "IAC-12"));
      const e = iac12.evidence.find((x) => x.source === "control pack");
      assert(e, c.out);
      assertEquals(
        e.check,
        "People: Every manager approved last quarter's access review with a signed commit",
      );
      assertEquals(e.status, "fail");
    } finally {
      await fs.remove(sb.home, { recursive: true }).catch(() => {});
    }
  },
  { timeout: 120_000 },
);

/** A guide's section: from its heading to the next heading of its level or higher (outside code). */
function guideSection(md: string, heading: string): string {
  const lines = md.split("\n");
  const start = lines.indexOf(heading);
  assert(start >= 0, `"${heading}" in the guide`);
  const level = heading.indexOf(" ");
  let fence = false;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (!fence && new RegExp(`^#{1,${level}} `).test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

proves(["077-people-controls FR-015"], "077: the guide people is the people module's", async () => {
  const { engineFile } = await import("../src/archon/core/assets.ts");
  const { guideDef, guideMarkdown } = await import("../src/archon/core/guides.ts");
  assertEquals(guideDef("people")?.module, "src/archon/people/mod.ts");
  const md = engineFile("docs/people.md");
  assertEquals(guideMarkdown(await fs.readTextFile("src/archon/people/mod.ts")), md);
  for (const h of [
    "## Joiners and leavers",
    "## Access reviews",
    "## Policies",
    "## Training and screening",
  ]) {
    assert(guideSection(md, h).trim().length > 0, h);
  }
});
