/**
 * Spec 074: compliance impact at the point of change: which SCF controls a model change weakens
 * or strengthens (Stolos's declarations, each tested here), the comment, the gate, the workflow.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { askpassHelper, sandbox } from "./sandbox.ts";
import { fleet as lab } from "../examples/fleets/lab/fleet.ts";
import { foundation } from "../src/archon/capabilities/mod.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { usersFor } from "../src/archon/model/load.ts";
import type { Capability, FleetDef, HostDef } from "../src/archon/model/types.ts";
import {
  affectedControls,
  compareFacts,
  FLEET_IMPLEMENTATIONS,
  type FleetFacts,
  fleetFacts,
  HOST_IMPLEMENTATIONS,
  type HostFacts,
  hostFacts,
  type Impact,
  impactMarkdown,
  IMPLEMENTATIONS,
  judge,
  type ModelChange,
  parseApproval,
  sshPasswordNetworks,
} from "../src/archon/compliance/impact.ts";
import { isScfId, SCF } from "../src/archon/compliance/scf.ts";
import type { ScfCatalog } from "../src/archon/compliance/catalog.ts";
import type { ControlChange } from "../src/archon/compliance/drift.ts";
import { repoEvidence } from "../src/archon/compliance/drift.ts";
import type { RepoReader } from "../src/archon/estate/snapshot.ts";
import {
  IMPACT_ACTIONS,
  IMPACT_AFFECTED_MARKER,
  IMPACT_COMMENT_MARKER,
  IMPACT_WORKFLOW_PATH,
  IMPACT_WORKFLOW_TEXT,
} from "../src/archon/compliance/workflow.ts";
import { scaffoldFiles } from "../src/archon/fleet/scaffold.ts";

// ------------------------------------------------------------- fixtures

const host = (o: Partial<HostDef> = {}): HostDef => ({
  name: "alpha",
  arch: "amd64",
  capabilities: foundation(),
  spec: "004-install",
  ...o,
});

/** foundation() without the capability of one spec. */
function without(spec: string): Capability[] {
  const h = host();
  const ctx = { host: h, fleet: lab, users: usersFor(lab, h) };
  const out = foundation().filter((c) => c(ctx).spec !== spec);
  assertEquals(out.length, foundation().length - 1, `foundation() has ${spec}`);
  return out;
}

const opens =
  (port: number): Capability =>
  () => ({
    spec: "999-test",
    ports: [{ port, protocol: "tcp", spec: "999-test" }],
  });

const facts = (h: HostDef, f: FleetDef = lab): Promise<HostFacts> => hostFacts(resolvePlan(h, f));
const fleetOf = (f: FleetDef, h: HostDef = host()): Promise<FleetFacts> => fleetFacts(f, [h]);

/** For each declaration: a strong side and a weak side, and the words the weakening says. */
const CASES: Record<
  string,
  () => Promise<{ strong: HostFacts | FleetFacts; weak: HostFacts | FleetFacts; says: string }>
> = {
  updates: async () => ({
    strong: await facts(host()),
    weak: await facts(host({ capabilities: without("009-updates") })),
    says: "turns off unattended upgrades",
  }),
  "ssh-passwords": async () => ({
    // (passwordFrom [] also closes what only local networks reach, a NET-02 change of its own.)
    strong: await facts(host(), { ...lab, ssh: { passwordFrom: ["10.0.0.0/16"] } }),
    weak: await facts(host(), { ...lab, ssh: { passwordFrom: ["10.0.0.0/16", "0.0.0.0/0"] } }),
    says: "accepts SSH passwords from 0.0.0.0/0 too",
  }),
  firewall: async () => ({
    strong: await facts(host()),
    weak: await facts(host({ capabilities: without("008-firewall") })),
    says: "turns off the host firewall (ufw)",
  }),
  "firewall-ports": async () => ({
    strong: await facts(host()),
    weak: await facts(host({ capabilities: [...foundation(), opens(8443)] })),
    says: "opens 8443/tcp",
  }),
  backup: async () => ({
    strong: await facts(host()),
    weak: await facts(host({ capabilities: without("016-backups") })),
    says: "removes the host from backups",
  }),
  "backup-scope": async () => ({
    strong: await facts(host()),
    weak: await facts(host({ backup: { paths: ["/etc"], keep: 7 } })),
    says: "no longer backs up /home",
  }),
  osquery: async () => ({
    strong: await facts(host()),
    weak: await facts(host({ capabilities: without("042-sql") })),
    says: "removes osquery",
  }),
  etckeeper: async () => ({
    strong: await facts(host()),
    weak: await facts(host({ capabilities: without("033-etckeeper") })),
    says: "stops recording /etc changes (etckeeper)",
  }),
  admins: async () => ({
    strong: await facts(host()),
    weak: await facts(
      host({
        users: [
          {
            name: "bob",
            fullName: "Bob Example",
            personas: ["operator"],
            admin: true,
            sshKeys: [],
            spec: "006-accounts",
          },
        ],
      }),
    ),
    says: "makes bob administrator",
  }),
  "agent-tier": async () => ({
    strong: await fleetOf({ ...lab, mcp: { maxTier: "read" } }),
    weak: await fleetOf({ ...lab, mcp: { maxTier: "mutate" } }),
    says: "raises the agents' tier from read to mutate",
  }),
  cadence: async () => ({
    strong: await fleetOf(lab),
    weak: await fleetOf({ ...lab, compliance: { cadence: { adopted: { every: "3d" } } } }),
    says: "observes adopted every 3d (stale after 6d) instead of 1d (2d)",
  }),
};

// --------------------------------------------------------- declarations

proves(
  ["074-change-impact FR-001"],
  "074: every declaration names an SCF control of scf.ts, and has a case here",
  () => {
    const ids = IMPLEMENTATIONS.map((d) => d.id);
    assertEquals(new Set(ids).size, ids.length, "ids are unique");
    for (const d of IMPLEMENTATIONS) {
      assert(isScfId(d.scf), `${d.id}: ${d.scf} is in scf.ts`);
      assert(d.setting && d.weakens, `${d.id} says where and which way`);
    }
    assertEquals(Object.keys(CASES).sort(), [...ids].sort(), "each declaration is tested");
    // The ones the issue names, with the right ids (VPM-08, not the issue's starter VPM-05).
    const by = (id: string) => got(IMPLEMENTATIONS.find((d) => d.id === id)).scf;
    assertEquals(by("updates"), "VPM-08");
    assertEquals(by("ssh-passwords"), "IAC-14");
    assertEquals(by("firewall-ports"), "NET-02");
    assertEquals(by("backup"), "BCD-24");
  },
);

for (const d of IMPLEMENTATIONS) {
  proves(
    ["074-change-impact FR-001", "074-change-impact FR-002"],
    `074: ${d.id} (${d.scf}): the weak side weakens it, the strong side strengthens it`,
    async () => {
      const c = await got(CASES[d.id], d.id)();
      const cmp = d.compare as (a: unknown, b: unknown) => ReturnType<typeof d.compare>;
      const down = cmp(c.strong, c.weak);
      assertEquals(down?.direction, "weakens", `${d.id}: strong -> weak`);
      assertStringIncludes(got(down).what, c.says);
      assertEquals(cmp(c.weak, c.strong)?.direction, "strengthens", `${d.id}: weak -> strong`);
      assertEquals(cmp(c.strong, c.strong), undefined, `${d.id}: no change, no finding`);
      // No other declaration fires on a change that only touches this setting.
      const others = (d.scope === "host" ? HOST_IMPLEMENTATIONS : FLEET_IMPLEMENTATIONS).filter(
        (x) =>
          x.id !== d.id &&
          (x.compare as (a: unknown, b: unknown) => ReturnType<typeof d.compare>)(c.strong, c.weak),
      );
      // Removing a backup also empties what it holds; that is the same change, reported once.
      assertEquals(
        others.map((x) => x.id),
        [],
        `${d.id}: only it fires`,
      );
    },
  );
}

proves(
  ["074-change-impact FR-002"],
  "074: sshd's drop-in: keys only, a Match block, and passwords anywhere",
  () => {
    assertEquals(sshPasswordNetworks("PasswordAuthentication no\n"), []);
    assertEquals(
      sshPasswordNetworks(
        "PasswordAuthentication no\nMatch Address 10.0.0.0/16,192.168.0.0/16\n    PasswordAuthentication yes\n",
      ),
      ["10.0.0.0/16", "192.168.0.0/16"],
    );
    assertEquals(sshPasswordNetworks("PasswordAuthentication yes\n"), ["anywhere"]);
  },
);

proves(
  ["074-change-impact FR-002"],
  "074: SSH: more networks weaken, fewer strengthen; Stolos not configuring sshd weakens",
  async () => {
    const d = got(HOST_IMPLEMENTATIONS.find((x) => x.id === "ssh-passwords"));
    const lan = await facts(host(), { ...lab, ssh: { passwordFrom: ["10.0.0.0/16"] } });
    const more = await facts(host(), {
      ...lab,
      ssh: { passwordFrom: ["10.0.0.0/16", "0.0.0.0/0"] },
    });
    const none = await facts(host(), { ...lab, ssh: { passwordFrom: [] } });
    assertEquals(d.compare(lan, more), {
      direction: "weakens",
      what: "accepts SSH passwords from 0.0.0.0/0 too",
    });
    assertEquals(d.compare(lan, none), {
      direction: "strengthens",
      what: "turns off SSH password authentication (keys only)",
    });
    const unmanaged = await facts(host({ capabilities: without("007-ssh") }));
    assertEquals(unmanaged.sshPasswords, undefined);
    assertEquals(d.compare(lan, unmanaged)?.direction, "weakens");
  },
);

proves(
  ["074-change-impact FR-002"],
  "074: compareFacts: per host on both sides, the fleet's own, hosts added and removed",
  async () => {
    const before: FleetFacts = await fleetFacts(lab, [host(), host({ name: "beta" })]);
    const after: FleetFacts = await fleetFacts({ ...lab, mcp: { maxTier: "repo" } }, [
      host({ capabilities: without("009-updates") }),
      host({ name: "gamma" }),
    ]);
    const r = compareFacts(before, after);
    assertEquals(r.added, ["gamma"]);
    assertEquals(r.removed, ["beta"]);
    assertEquals(
      r.changes.map((c) => `${c.subject} ${c.implementation} ${c.scf} ${c.direction}`),
      ["alpha updates VPM-08 weakens", "fleet agent-tier IAC-30 strengthens"],
    );
  },
);

// -------------------------------------------------------------- comment

const weakens: ModelChange = {
  implementation: "updates",
  scf: "VPM-08",
  subject: "beta",
  direction: "weakens",
  what: "turns off unattended upgrades",
};
const strengthens: ModelChange = {
  implementation: "firewall-ports",
  scf: "NET-02",
  subject: "alpha",
  direction: "strengthens",
  what: "closes 445/tcp",
};

const catalog: ScfCatalog = {
  format: 1,
  version: "2026.3",
  controls: {
    "VPM-08": {
      domain: "Vulnerability & Patch Management",
      name: "Software & Firmware Patching",
      description: "",
      maps: {
        soc2: ["CC7.1", "CC7.1-POF3"],
        hipaa: ["164.308(a)(5)(ii)(B)"],
        pci: ["6.3.3"],
        cmmc: [],
        nist80053: ["SI-2"],
        nist800171: [],
        fedramp: ["SI-2"],
      },
    },
  },
};

function impactOf(o: Partial<Impact> & { changes: ModelChange[] }): Impact {
  const evidence = o.evidence ?? [];
  return {
    fleet: "lab",
    base: "1234567890abcdef1234567890abcdef12345678",
    head: "working tree",
    hosts: { added: [], removed: [] },
    evidence,
    controls: affectedControls(o.changes, evidence, "catalog" in o ? undefined : catalog),
    catalog: { version: "2026.3" },
    gate: judge({ changes: o.changes, evidence }),
    problems: [],
    ...o,
  };
}

proves(
  ["074-change-impact FR-004"],
  "074: the comment names each control, its change, and its framework requirements",
  () => {
    const text = impactMarkdown(impactOf({ changes: [weakens, strengthens] }));
    assert(text.startsWith(IMPACT_AFFECTED_MARKER), "marked as affecting a control");
    assertStringIncludes(text, "### Compliance impact: fleet `lab`");
    assertStringIncludes(text, "1 control(s) weakened, 1 strengthened.");
    assertStringIncludes(text, "#### Weakened\n\n- **VPM-08** Software & Firmware Patching");
    assertStringIncludes(text, "  - weakens: `beta` turns off unattended upgrades (`updates`)");
    assertStringIncludes(
      text,
      "  - requirements: SOC 2 CC7.1; HIPAA 164.308(a)(5)(ii)(B); PCI DSS 6.3.3; 800-53 SI-2; FedRAMP SI-2",
    );
    assertStringIncludes(text, "#### Strengthened\n\n- **NET-02** Network Security Controls (NSC)");
    assertStringIncludes(text, "SCF 2026.3");
    assert(!text.includes("#### Gate"), "the gate is off: no gate section");
    assert(!text.includes("\u2014"), "no em dash");
  },
);

proves(
  ["074-change-impact FR-004"],
  "074: the comment without the catalog says so; nothing affected is said too",
  () => {
    const changes = [weakens];
    const i = impactOf({
      changes,
      controls: affectedControls(changes, []),
      catalog: {
        missing: "the SCF catalog is not cached here (bun run stolos compliance catalog)",
      },
    });
    const text = impactMarkdown(i);
    assertStringIncludes(text, "- **VPM-08** Software & Firmware Patching");
    assert(!text.includes("requirements:"));
    assertStringIncludes(
      text,
      "Framework requirements are not shown: the SCF catalog is not cached",
    );
    const none = impactMarkdown(impactOf({ changes: [] }));
    assert(!none.includes(IMPACT_AFFECTED_MARKER));
    assertStringIncludes(none, "no control is affected.");
  },
);

proves(["074-change-impact FR-003"], "074: an observed change is listed under its control", () => {
  const ev: ControlChange = {
    id: "END-07",
    name: "Software Firewall",
    from: "pass",
    to: "fail",
    worse: true,
    evidence: [
      {
        source: "adopted",
        subject: "laptop-1",
        check: "Firewall on",
        from: "pass",
        to: "fail",
      },
    ],
  };
  const text = impactMarkdown(impactOf({ changes: [], evidence: [ev] }));
  assertStringIncludes(text, "- **END-07** Software Firewall\n  - observed: pass -> fail");
  assertStringIncludes(text, "    - laptop-1 (adopted): Firewall on: pass -> fail");
});

// ----------------------------------------------------------------- gate

proves(
  ["074-change-impact FR-007", "074-change-impact FR-008"],
  "074: the gate: never by default; with weakens it blocks, and allow, a risk, an approval let it through",
  () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    assertEquals(judge({ changes: [weakens], now }).blocked, false, "default never");
    const gate = { block: "weakens" as const };
    assertEquals(judge({ gate, changes: [strengthens], now }).blocked, false, "only weakenings");
    const blocked = judge({ gate, changes: [weakens, strengthens], now });
    assert(blocked.blocked);
    assertEquals(
      blocked.items.map((i) => i.keys),
      [["updates", "updates/beta", "VPM-08"]],
    );
    // gate.allow: by declaration, by subject, by SCF id.
    for (const k of ["updates", "updates/beta", "VPM-08"]) {
      assertEquals(
        judge({ gate: { ...gate, allow: [k] }, changes: [weakens], now }).blocked,
        false,
      );
    }
    assertEquals(
      judge({ gate: { ...gate, allow: ["updates/alpha"] }, changes: [weakens], now }).blocked,
      true,
    );
    // An accepted risk, until a date; after it, it blocks again.
    const risk = {
      policy: "impact/updates/beta",
      reason: "beta is a lab box",
      by: "alice",
      until: "2026-12-31",
    };
    const ok = judge({ gate, changes: [weakens], accepted: [risk], now });
    assertEquals(ok.blocked, false);
    assertStringIncludes(
      got(ok.items[0]?.allowedBy),
      "accepted risk (impact/updates/beta): alice until 2026-12-31",
    );
    assertEquals(
      judge({ gate, changes: [weakens], accepted: [{ ...risk, until: "2026-11-01" }], now })
        .blocked,
      true,
    );
    // An approval: a signed commit's trailer.
    const ap = {
      commit: "a".repeat(40),
      signer: "alice-daily",
      covers: parseApproval("VPM-08, NET-02"),
    };
    const approved = judge({ gate, changes: [weakens], approvals: [ap], now });
    assertEquals(approved.blocked, false);
    assertEquals(approved.items[0]?.allowedBy, "approved by alice-daily (aaaaaaaaaa)");
    assertEquals(
      judge({ gate, changes: [weakens], approvals: [{ ...ap, covers: ["all"] }], now }).blocked,
      false,
    );
    assertEquals(
      judge({ gate, changes: [weakens], approvals: [{ ...ap, covers: ["NET-02"] }], now }).blocked,
      true,
    );
    // Observed evidence turning to fail blocks only with gate.evidence.
    const ev: ControlChange = {
      id: "END-07",
      name: "Software Firewall",
      from: "pass",
      to: "fail",
      worse: true,
      evidence: [],
    };
    assertEquals(judge({ gate, changes: [], evidence: [ev], now }).blocked, false);
    assertEquals(
      judge({ gate: { ...gate, evidence: true }, changes: [], evidence: [ev], now }).blocked,
      true,
    );
  },
);

proves(
  ["074-change-impact FR-007"],
  "074: a blocked change's comment says how to let it through",
  () => {
    const changes = [weakens];
    const text = impactMarkdown(
      impactOf({ changes, gate: judge({ gate: { block: "weakens" }, changes }) }),
    );
    assertStringIncludes(text, "**The fleet's gate blocks this change**");
    assertStringIncludes(text, "Compliance-Approved: <key>");
    assertStringIncludes(text, "- **blocked**: beta: turns off unattended upgrades (VPM-08)");
  },
);

// ------------------------------------------------- evidence: control packs

proves(
  ["074-change-impact FR-003"],
  "074: repoEvidence keeps the fleet's control packs' results when given them",
  async () => {
    const reader: RepoReader = {
      read: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      lastCommit: () => Promise.resolve(undefined),
    };
    const v = await repoEvidence(reader, "lab", {
      now: Date.parse("2026-11-15T12:00:00Z"),
      connectors: [],
      packs: () =>
        Promise.resolve([
          {
            pack: { id: "acme", title: "Acme rules", version: "1.0.0" },
            results: [
              {
                id: "acme/zones",
                title: "Zones are signed",
                scf: ["NET-13"],
                status: "fail",
                detail: "none signed",
                subject: "across systems",
                control: "zones",
              },
            ],
          },
        ]),
    });
    const net13 = got(v.controls.find((c) => c.control.id === "NET-13"));
    assertEquals(net13.status, "fail");
    assertEquals(net13.evidence[0]?.source, "control pack");
    // Without packs, as drift calls it, they are not read.
    const plain = await repoEvidence(reader, "lab", { now: Date.now(), connectors: [] });
    assertEquals(got(plain.controls.find((c) => c.control.id === "NET-13")).evidence, []);
  },
);

// ------------------------------------------------------------- workflow

proves(
  ["074-change-impact FR-010"],
  "074: the pull request workflow: pinned actions, least permissions, one comment, the gate",
  () => {
    const w = IMPACT_WORKFLOW_TEXT;
    assertEquals(scaffoldFiles("v1.0.0")[IMPACT_WORKFLOW_PATH], w, "fleet init writes it");
    assertStringIncludes(w, "on:\n  pull_request:\n");
    assert(
      !w.includes("pull_request_target"),
      "never runs with the base's secrets on a fork's code",
    );
    assertStringIncludes(w, "permissions:\n  contents: read\n  pull-requests: write\n");
    const uses = [...w.matchAll(/uses: (\S+)@(\S+)/g)].map(([, a = "", ref = ""]) => [a, ref]);
    assertEquals(uses.map(([a]) => a).sort(), ["actions/checkout", "oven-sh/setup-bun"]);
    for (const [a = "", ref = ""] of uses) {
      assert(/^[0-9a-f]{40}$/.test(ref), `${a} is pinned to a commit`);
      assertEquals(ref, IMPACT_ACTIONS[a]?.sha);
    }
    assertStringIncludes(w, "persist-credentials: false");
    assertStringIncludes(w, "fetch-depth: 0");
    // The token is given only to the step that comments.
    assertEquals(w.split("GH_TOKEN:").length - 1, 1);
    assertEquals(w.split("github.token").length - 1, 1);
    assert(!/secrets\./.test(w), "no repository secret");
    assertStringIncludes(
      w,
      'bun run --silent stolos compliance impact --base "$BASE" --head "$HEAD" --markdown',
    );
    assertStringIncludes(w, "bun install --frozen-lockfile");
    assertStringIncludes(w, IMPACT_COMMENT_MARKER);
    assertStringIncludes(w, IMPACT_AFFECTED_MARKER);
    assertStringIncludes(w, "repos/$REPO/issues/comments/$id");
    assertStringIncludes(w, "::error::the fleet's compliance gate blocks this change");
    // Untrusted values reach shell steps only through the environment.
    for (const line of w.split("\n").filter((l) => /^\s+(run:|\S.*\$\{\{)/.test(l))) {
      if (line.includes("${{")) assert(/^\s+[A-Z_]+: \$\{\{|^\s+(ref|group):/.test(line), line);
    }
    assert(!w.includes("\u2014"), "no em dash");
  },
);

// ------------------------------------------------------- end to end (CLI)

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await proc.run(
    ["git", "-c", "user.name=Alice Example", "-c", "user.email=alice@example.net", ...args],
    { cwd: dir, stdin: "null", env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const ENGINE = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** A fleet repository depends on the engine, and the engine on IFC TypeScript, by name. */
async function linkEngine(repo: string): Promise<void> {
  const scope = path.join(repo, "node_modules", "@intellectual-frontiers");
  await fs.mkdir(scope, { recursive: true });
  await fs.symlink(ENGINE, path.join(scope, "stolos"));
  await fs.symlink(
    path.join(ENGINE, "node_modules", "@intellectual-frontiers", "ifc-ts"),
    path.join(scope, "ifc-ts"),
  );
}

const json = (out: string): ImpactJson =>
  JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as ImpactJson;

/** What `stolos compliance impact --json` prints, as these tests read it. */
type ImpactJson = {
  head: string;
  changes: unknown[];
  controls: Array<{ id: string; name: string; direction: string }>;
  gate: { blocked: boolean; block: string; items: Array<{ allowedBy?: string }> };
  problems: string[];
};

proves(
  ["074-change-impact FR-005", "074-change-impact FR-008", "074-change-impact FR-009"],
  "074: stolos compliance impact on a fleet repository: blocked, then accepted, then approved by a signed commit",
  async () => {
    const sb = await sandbox("stolos-impact-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await git(repo, "init", "-q", "-b", "main");
      await fs.copy("examples/fleets/lab", path.join(repo, "fleets", "lab"));
      await linkEngine(repo);
      await fs.writeTextFile(path.join(repo, ".gitignore"), "node_modules/\n");
      // A daily signer whose key is made here; the base's fleet.ts turns the gate on.
      const key = path.join(sb.home, "alice-daily");
      const kg = await proc.run(
        ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key],
        {
          stdin: "null",
        },
      );
      assert(kg.code === 0, kg.stderr);
      const pub = (await fs.readTextFile(`${key}.pub`)).trim();
      await fs.writeTextFile(
        path.join(repo, "fleets/lab/signers.ts"),
        `export default [\n  {\n    name: "alice-daily",\n    role: "daily",\n    key: ${JSON.stringify(
          pub,
        )},\n    added: "2026-11-13",\n  },\n];\n`,
      );
      const fleetTs = path.join(repo, "fleets/lab/fleet.ts");
      await fs.writeTextFile(
        fleetTs,
        (await fs.readTextFile(fleetTs)).replace(
          '  timezone: "America/New_York",',
          '  timezone: "America/New_York",\n  compliance: { gate: { block: "weakens" } },',
        ),
      );
      await git(repo, "add", "-A");
      await git(repo, "commit", "-q", "-m", "lab: base");
      const base = await git(repo, "rev-parse", "HEAD");

      // The change: beta without unattended upgrades (updates() is foundation()'s fifth).
      const beta = path.join(repo, "fleets/lab/hosts/beta/host.ts");
      await fs.writeTextFile(
        beta,
        (await fs.readTextFile(beta)).replace(
          "capabilities: foundation(),",
          "capabilities: foundation().filter((_, i) => i !== 4),",
        ),
      );
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      const r1 = await sb.run(
        "src/stolos/main.ts",
        ["compliance", "impact", "--base", base, "--json"],
        "",
        env,
      );
      assertEquals(r1.code, 1, r1.out);
      const i1 = json(r1.out);
      assertEquals(i1.head, "working tree");
      assertEquals(i1.changes, [
        {
          implementation: "updates",
          scf: "VPM-08",
          subject: "beta",
          direction: "weakens",
          what: "turns off unattended upgrades",
        },
      ]);
      assertEquals(i1.controls[0]?.name, "Software & Firmware Patching");
      assert(i1.gate.blocked);

      // The pull request comment, from the CLI.
      const md = await sb.run(
        "src/stolos/main.ts",
        ["compliance", "impact", "--base", base, "--markdown"],
        "",
        env,
      );
      assertEquals(md.code, 1);
      assertStringIncludes(md.out, IMPACT_AFFECTED_MARKER);
      assertStringIncludes(md.out, "- **VPM-08** Software & Firmware Patching");
      assertStringIncludes(md.out, "- **blocked**: beta: turns off unattended upgrades (VPM-08)");

      // An accepted risk lets it through.
      const accepted = path.join(repo, "fleets/lab/controls/accepted.ts");
      await fs.writeTextFile(
        accepted,
        'export const accepted = [{ policy: "impact/updates/beta", reason: "beta is a lab box", by: "alice", until: "2099-12-31" }];\n',
      );
      const r2 = await sb.run(
        "src/stolos/main.ts",
        ["compliance", "impact", "--base", base, "--json"],
        "",
        env,
      );
      assertEquals(r2.code, 0, r2.out);
      assertStringIncludes(
        got(json(r2.out).gate.items[0]?.allowedBy),
        "accepted risk (impact/updates/beta)",
      );
      await fs.remove(accepted);

      // An unsigned approval is not counted; a commit signed by the base's signer is.
      await git(repo, "add", "-A");
      await git(repo, "commit", "-q", "-m", "lab: beta", "-m", "Compliance-Approved: updates/beta");
      const r3 = await sb.run(
        "src/stolos/main.ts",
        ["compliance", "impact", "--base", base, "--head", "HEAD", "--json"],
        "",
        env,
      );
      assertEquals(r3.code, 1, r3.out);
      assert(json(r3.out).problems.some((p) => p.startsWith("approval not counted")));
      await git(
        repo,
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${key}`,
        "commit",
        "-q",
        "--amend",
        "-S",
        "--no-edit",
      );
      const r4 = await sb.run(
        "src/stolos/main.ts",
        ["compliance", "impact", "--base", base, "--head", "HEAD", "--json"],
        "",
        env,
      );
      assertEquals(r4.code, 0, r4.out);
      const i4 = json(r4.out);
      assertEquals(i4.head, await git(repo, "rev-parse", "HEAD"));
      assertStringIncludes(got(i4.gate.items[0]?.allowedBy), "approved by alice-daily");

      // A change cannot turn off the gate that judges it: the base's gate applies.
      await fs.writeTextFile(
        fleetTs,
        (await fs.readTextFile(fleetTs)).replace('block: "weakens"', 'block: "never"'),
      );
      await git(repo, "commit", "-q", "-a", "-m", "lab: gate off, unsigned");
      const r5 = await sb.run(
        "src/stolos/main.ts",
        ["compliance", "impact", "--base", base, "--head", "HEAD", "--json"],
        "",
        env,
      );
      assertEquals(json(r5.out).gate.block, "weakens");
    } finally {
      await fs.remove(sb.home, { recursive: true }).catch(() => {});
    }
  },
);

proves(
  ["074-change-impact FR-004"],
  "074: SCF names in the declarations' controls come from scf.ts",
  () => {
    for (const d of IMPLEMENTATIONS)
      assert(
        SCF.some((c) => c.id === d.scf),
        d.id,
      );
  },
);

/** The value the test expects to be there. */
function got<T>(value: T | undefined | null, what = "a value"): T {
  assertExists(value, `${what} is missing`);
  return value;
}

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

proves(
  ["074-change-impact FR-011"],
  "074: the compliance guide has a section on change impact, with a Mermaid diagram",
  async () => {
    const { engineFile } = await import("../src/archon/core/assets.ts");
    const { guideDef } = await import("../src/archon/core/guides.ts");
    assertEquals(guideDef("compliance")?.module, "src/archon/compliance/mod.ts");
    const s = guideSection(
      engineFile("docs/compliance.md"),
      "## Compliance impact at the point of change",
    );
    assertStringIncludes(s, "```mermaid\n");
    for (const w of ["stolos apply", "stolos compliance impact", "### The gate", "pull request"]) {
      assertStringIncludes(s, w);
    }
  },
);

proves(
  ["074-change-impact FR-006"],
  "074: stolos apply shows Compliance impact after Changes; the gate blocks the commit; --approve writes the trailer",
  async () => {
    const { linkEngine } = await import("./sandbox.ts");
    const PASS = "correct horse battery staple";
    const sb = await sandbox("stolos-apply-impact-");
    try {
      const home = sb.home;
      const askpass = await askpassHelper(home, PASS);
      const gitconfig = path.join(home, "gitconfig");
      await fs.writeTextFile(gitconfig, "[user]\n\tname = t\n\temail = t@example.invalid\n");
      const env: Record<string, string> = {
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: "1",
        ARCHON_TEST_PASSPHRASE: PASS,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: ":0",
        SSH_AUTH_SOCK: path.join(home, "no-agent"),
      };
      const sh = async (cwd: string, ...a: string[]): Promise<string> => {
        const r = await proc.run(a, {
          cwd,
          env: { ...proc.env.toObject(), ...env, HOME: home },
          stdin: "null",
        });
        if (!r.success) throw new Error(`${a.join(" ")}: ${r.stderr}`);
        return r.stdout.trim();
      };
      const origin = path.join(home, "origin.git");
      const repo = path.join(home, "fleet");
      await sh(home, "git", "init", "-q", "--bare", "-b", "main", origin);
      await sh(home, "git", "clone", "-q", origin, repo);
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await fs.copy("examples/fleets/lab", path.join(repo, "fleets", "lab"));
      await linkEngine(repo);
      await fs.remove(path.join(repo, "fleets", "lab", "signers.ts"));
      await fs.writeTextFile(path.join(repo, ".gitignore"), "out/\nnode_modules/\n");
      await fs.writeTextFile(
        path.join(repo, "package.json"),
        // With /: bun run's shell takes a \ for an escape (a Windows path).
        JSON.stringify({
          scripts: { stolos: `bun ${path.toPosix(proc.cwd())}/src/stolos/main.ts` },
        }) + "\n",
      );
      const fleetTs = path.join(repo, "fleets/lab/fleet.ts");
      await fs.writeTextFile(
        fleetTs,
        (await fs.readTextFile(fleetTs)).replace(
          '  timezone: "America/New_York",',
          '  timezone: "America/New_York",\n  compliance: { gate: { block: "weakens" } },',
        ),
      );
      const stolos = (args: string[]) =>
        sb.run("src/stolos/main.ts", args, "", { ...env, ARCHON_REPO: repo, ARCHON_FLEET: "lab" });
      assertEquals((await stolos(["keys", "setup"])).code, 0);
      let r = await stolos(["apply", "-m", "lab: the fleet"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "the first push: nothing to compare with");
      const base = await sh(origin, "git", "rev-parse", "main");

      // A weakening (beta without unattended upgrades): shown as a warning; the gate blocks.
      const beta = path.join(repo, "fleets/lab/hosts/beta/host.ts");
      const before = await fs.readTextFile(beta);
      await fs.writeTextFile(
        beta,
        before.replace(
          "capabilities: foundation(),",
          "capabilities: foundation().filter((_, i) => i !== 4),",
        ),
      );
      r = await stolos(["apply", "-m", "lab: beta"]);
      assertEquals(r.code, 1, r.out);
      const changes = r.out.indexOf("Changes");
      const impact = r.out.indexOf("Compliance impact");
      assert(changes > 0 && impact > changes, r.out);
      assertStringIncludes(r.out, "beta: turns off unattended upgrades: VPM-08");
      assertStringIncludes(r.out, "the gate blocks: beta: turns off unattended upgrades");
      assert(!/\[ok\] Commit/.test(r.out), "nothing committed");
      assertEquals(await sh(repo, "git", "rev-parse", "HEAD"), base, "nothing committed here");
      assertEquals(await sh(origin, "git", "rev-parse", "main"), base, "nothing pushed");

      // --approve: the approval is a trailer of the one signed commit, pushed.
      r = await stolos(["apply", "-m", "lab: beta", "--approve", "updates/beta"]);
      assertEquals(r.code, 0, r.out);
      assert(r.out.indexOf("Compliance impact") < r.out.indexOf("Commit"), r.out);
      assertStringIncludes(
        await sh(origin, "git", "log", "-1", "--format=%B", "main"),
        "Compliance-Approved: updates/beta",
      );
      assertStringIncludes(r.out, "signed by a key the servers trust");

      // Turning them back on strengthens it: a pass, and nothing blocks.
      await fs.writeTextFile(beta, before);
      r = await stolos(["apply", "-m", "lab: beta again"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "0 control(s) weakened, 1 strengthened");
    } finally {
      await fs.remove(sb.home, { recursive: true }).catch(() => {});
    }
  },
);
