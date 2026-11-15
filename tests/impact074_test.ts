// Spec 074: compliance impact at the point of change: which SCF controls a model change weakens
// or strengthens (Stolos's declarations, each tested here), the comment, the gate, the workflow.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";
import { sandbox } from "./sandbox.ts";
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

const opens = (port: number): Capability => () => ({
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
    weak: await facts(host({
      users: [{
        name: "bob",
        fullName: "Bob Example",
        personas: ["operator"],
        admin: true,
        sshKeys: [],
        spec: "006-accounts",
      }],
    })),
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

Deno.test("074: every declaration names an SCF control of scf.ts, and has a case here", () => {
  const ids = IMPLEMENTATIONS.map((d) => d.id);
  assertEquals(new Set(ids).size, ids.length, "ids are unique");
  for (const d of IMPLEMENTATIONS) {
    assert(isScfId(d.scf), `${d.id}: ${d.scf} is in scf.ts`);
    assert(d.setting && d.weakens, `${d.id} says where and which way`);
  }
  assertEquals(Object.keys(CASES).sort(), [...ids].sort(), "each declaration is tested");
  // The ones the issue names, with the right ids (VPM-08, not the issue's starter VPM-05).
  const by = (id: string) => IMPLEMENTATIONS.find((d) => d.id === id)!.scf;
  assertEquals(by("updates"), "VPM-08");
  assertEquals(by("ssh-passwords"), "IAC-14");
  assertEquals(by("firewall-ports"), "NET-02");
  assertEquals(by("backup"), "BCD-24");
});

for (const d of IMPLEMENTATIONS) {
  Deno.test(`074: ${d.id} (${d.scf}): the weak side weakens it, the strong side strengthens it`, async () => {
    const c = await CASES[d.id]();
    // deno-lint-ignore no-explicit-any
    const cmp = d.compare as (a: any, b: any) => ReturnType<typeof d.compare>;
    const down = cmp(c.strong, c.weak);
    assertEquals(down?.direction, "weakens", `${d.id}: strong -> weak`);
    assertStringIncludes(down!.what, c.says);
    assertEquals(cmp(c.weak, c.strong)?.direction, "strengthens", `${d.id}: weak -> strong`);
    assertEquals(cmp(c.strong, c.strong), undefined, `${d.id}: no change, no finding`);
    // No other declaration fires on a change that only touches this setting.
    const others = (d.scope === "host" ? HOST_IMPLEMENTATIONS : FLEET_IMPLEMENTATIONS)
      // deno-lint-ignore no-explicit-any
      .filter((x) => x.id !== d.id && (x.compare as any)(c.strong, c.weak));
    // Removing a backup also empties what it holds; that is the same change, reported once.
    assertEquals(others.map((x) => x.id), [], `${d.id}: only it fires`);
  });
}

Deno.test("074: sshd's drop-in: keys only, a Match block, and passwords anywhere", () => {
  assertEquals(sshPasswordNetworks("PasswordAuthentication no\n"), []);
  assertEquals(
    sshPasswordNetworks(
      "PasswordAuthentication no\nMatch Address 10.0.0.0/16,192.168.0.0/16\n    PasswordAuthentication yes\n",
    ),
    ["10.0.0.0/16", "192.168.0.0/16"],
  );
  assertEquals(sshPasswordNetworks("PasswordAuthentication yes\n"), ["anywhere"]);
});

Deno.test("074: SSH: more networks weaken, fewer strengthen; Stolos not configuring sshd weakens", async () => {
  const d = HOST_IMPLEMENTATIONS.find((x) => x.id === "ssh-passwords")!;
  const lan = await facts(host(), { ...lab, ssh: { passwordFrom: ["10.0.0.0/16"] } });
  const more = await facts(host(), { ...lab, ssh: { passwordFrom: ["10.0.0.0/16", "0.0.0.0/0"] } });
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
});

Deno.test("074: compareFacts: per host on both sides, the fleet's own, hosts added and removed", async () => {
  const before: FleetFacts = await fleetFacts(lab, [host(), host({ name: "beta" })]);
  const after: FleetFacts = await fleetFacts(
    { ...lab, mcp: { maxTier: "repo" } },
    [host({ capabilities: without("009-updates") }), host({ name: "gamma" })],
  );
  const r = compareFacts(before, after);
  assertEquals(r.added, ["gamma"]);
  assertEquals(r.removed, ["beta"]);
  assertEquals(
    r.changes.map((c) => `${c.subject} ${c.implementation} ${c.scf} ${c.direction}`),
    ["alpha updates VPM-08 weakens", "fleet agent-tier IAC-30 strengthens"],
  );
});

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

Deno.test("074: the comment names each control, its change, and its framework requirements", () => {
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
});

Deno.test("074: the comment without the catalog says so; nothing affected is said too", () => {
  const changes = [weakens];
  const i = impactOf({
    changes,
    controls: affectedControls(changes, []),
    catalog: {
      missing: "the SCF catalog is not cached here (deno task stolos compliance catalog)",
    },
  });
  const text = impactMarkdown(i);
  assertStringIncludes(text, "- **VPM-08** Software & Firmware Patching");
  assert(!text.includes("requirements:"));
  assertStringIncludes(text, "Framework requirements are not shown: the SCF catalog is not cached");
  const none = impactMarkdown(impactOf({ changes: [] }));
  assert(!none.includes(IMPACT_AFFECTED_MARKER));
  assertStringIncludes(none, "no control is affected.");
});

Deno.test("074: an observed change is listed under its control", () => {
  const ev: ControlChange = {
    id: "END-07",
    name: "Software Firewall",
    from: "pass",
    to: "fail",
    worse: true,
    evidence: [{
      source: "adopted",
      subject: "laptop-1",
      check: "Firewall on",
      from: "pass",
      to: "fail",
    }],
  };
  const text = impactMarkdown(impactOf({ changes: [], evidence: [ev] }));
  assertStringIncludes(text, "- **END-07** Software Firewall\n  - observed: pass -> fail");
  assertStringIncludes(text, "    - laptop-1 (adopted): Firewall on: pass -> fail");
});

// ----------------------------------------------------------------- gate

Deno.test("074: the gate: never by default; with weakens it blocks, and allow, a risk, an approval let it through", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  assertEquals(judge({ changes: [weakens], now }).blocked, false, "default never");
  const gate = { block: "weakens" as const };
  assertEquals(judge({ gate, changes: [strengthens], now }).blocked, false, "only weakenings");
  const blocked = judge({ gate, changes: [weakens, strengthens], now });
  assert(blocked.blocked);
  assertEquals(blocked.items.map((i) => i.keys), [["updates", "updates/beta", "VPM-08"]]);
  // gate.allow: by declaration, by subject, by SCF id.
  for (const k of ["updates", "updates/beta", "VPM-08"]) {
    assertEquals(judge({ gate: { ...gate, allow: [k] }, changes: [weakens], now }).blocked, false);
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
    ok.items[0].allowedBy!,
    "accepted risk (impact/updates/beta): alice until 2026-12-31",
  );
  assertEquals(
    judge({ gate, changes: [weakens], accepted: [{ ...risk, until: "2026-11-01" }], now }).blocked,
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
  assertEquals(approved.items[0].allowedBy, "approved by alice-daily (aaaaaaaaaa)");
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
});

Deno.test("074: a blocked change's comment says how to let it through", () => {
  const changes = [weakens];
  const text = impactMarkdown(
    impactOf({ changes, gate: judge({ gate: { block: "weakens" }, changes }) }),
  );
  assertStringIncludes(text, "**The fleet's gate blocks this change**");
  assertStringIncludes(text, "Compliance-Approved: <key>");
  assertStringIncludes(text, "- **blocked**: beta: turns off unattended upgrades (VPM-08)");
});

// ------------------------------------------------- evidence: control packs

Deno.test("074: repoEvidence keeps the fleet's control packs' results when given them", async () => {
  const reader: RepoReader = {
    read: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    lastCommit: () => Promise.resolve(undefined),
  };
  const v = await repoEvidence(reader, "lab", {
    now: Date.parse("2026-11-15T12:00:00Z"),
    connectors: [],
    packs: () =>
      Promise.resolve([{
        pack: { id: "acme", title: "Acme rules", version: "1.0.0" },
        results: [{
          id: "acme/zones",
          title: "Zones are signed",
          scf: ["NET-13"],
          status: "fail",
          detail: "none signed",
          subject: "across systems",
          control: "zones",
        }],
      }]),
  });
  const net13 = v.controls.find((c) => c.control.id === "NET-13")!;
  assertEquals(net13.status, "fail");
  assertEquals(net13.evidence[0].source, "control pack");
  // Without packs, as drift calls it, they are not read.
  const plain = await repoEvidence(reader, "lab", { now: Date.now(), connectors: [] });
  assertEquals(plain.controls.find((c) => c.control.id === "NET-13")!.evidence, []);
});

// ------------------------------------------------------------- workflow

Deno.test("074: the pull request workflow: pinned actions, least permissions, one comment, the gate", () => {
  const w = IMPACT_WORKFLOW_TEXT;
  assertEquals(scaffoldFiles("v1.0.0")[IMPACT_WORKFLOW_PATH], w, "fleet init writes it");
  assertStringIncludes(w, "on:\n  pull_request:\n");
  assert(!w.includes("pull_request_target"), "never runs with the base's secrets on a fork's code");
  assertStringIncludes(w, "permissions:\n  contents: read\n  pull-requests: write\n");
  const uses = [...w.matchAll(/uses: (\S+)@(\S+)/g)].map((m) => [m[1], m[2]]);
  assertEquals(uses.map(([a]) => a).sort(), ["actions/checkout", "denoland/setup-deno"]);
  for (const [a, ref] of uses) {
    assert(/^[0-9a-f]{40}$/.test(ref), `${a} is pinned to a commit`);
    assertEquals(ref, IMPACT_ACTIONS[a].sha);
  }
  assertStringIncludes(w, "persist-credentials: false");
  assertStringIncludes(w, "fetch-depth: 0");
  // The token is given only to the step that comments.
  assertEquals(w.split("GH_TOKEN:").length - 1, 1);
  assertEquals(w.split("github.token").length - 1, 1);
  assert(!/secrets\./.test(w), "no repository secret");
  assertStringIncludes(
    w,
    'deno task -q stolos compliance impact --base "$BASE" --head "$HEAD" --markdown',
  );
  assertStringIncludes(w, IMPACT_COMMENT_MARKER);
  assertStringIncludes(w, IMPACT_AFFECTED_MARKER);
  assertStringIncludes(w, "repos/$REPO/issues/comments/$id");
  assertStringIncludes(w, "::error::the fleet's compliance gate blocks this change");
  // Untrusted values reach shell steps only through the environment.
  for (const line of w.split("\n").filter((l) => /^\s+(run:|\S.*\$\{\{)/.test(l))) {
    if (line.includes("${{")) assert(/^\s+[A-Z_]+: \$\{\{|^\s+(ref|group):/.test(line), line);
  }
  assert(!w.includes("\u2014"), "no em dash");
});

// ------------------------------------------------------- end to end (CLI)

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await new Deno.Command("git", {
    args: ["-c", "user.name=Alice Example", "-c", "user.email=alice@example.net", ...args],
    cwd: dir,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}

const json = (out: string) => JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));

Deno.test("074: stolos compliance impact on a fleet repository: blocked, then accepted, then approved by a signed commit", async () => {
  const sb = await sandbox("stolos-impact-");
  try {
    const repo = join(sb.home, "fleet");
    await Deno.mkdir(join(repo, "fleets"), { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await new Deno.Command("cp", {
      args: ["-r", "examples/fleets/lab", join(repo, "fleets", "lab")],
    })
      .output();
    // A daily signer whose key is made here; the base's fleet.ts turns the gate on.
    const key = join(sb.home, "alice-daily");
    const kg = await new Deno.Command("ssh-keygen", {
      args: ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key],
      stdout: "null",
      stderr: "null",
    }).output();
    assert(kg.success);
    const pub = (await Deno.readTextFile(`${key}.pub`)).trim();
    await Deno.writeTextFile(
      join(repo, "fleets/lab/signers.ts"),
      `export default [\n  {\n    name: "alice-daily",\n    role: "daily",\n    key: ${
        JSON.stringify(pub)
      },\n    added: "2026-11-13",\n  },\n];\n`,
    );
    const fleetTs = join(repo, "fleets/lab/fleet.ts");
    await Deno.writeTextFile(
      fleetTs,
      (await Deno.readTextFile(fleetTs)).replace(
        '  timezone: "America/New_York",',
        '  timezone: "America/New_York",\n  compliance: { gate: { block: "weakens" } },',
      ),
    );
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "lab: base");
    const base = await git(repo, "rev-parse", "HEAD");

    // The change: beta without unattended upgrades (updates() is foundation()'s fifth).
    const beta = join(repo, "fleets/lab/hosts/beta/host.ts");
    await Deno.writeTextFile(
      beta,
      (await Deno.readTextFile(beta)).replace(
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
    assertEquals(i1.changes, [{
      implementation: "updates",
      scf: "VPM-08",
      subject: "beta",
      direction: "weakens",
      what: "turns off unattended upgrades",
    }]);
    assertEquals(i1.controls[0].name, "Software & Firmware Patching");
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
    const accepted = join(repo, "fleets/lab/controls/accepted.ts");
    await Deno.writeTextFile(
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
      json(r2.out).gate.items[0].allowedBy,
      "accepted risk (impact/updates/beta)",
    );
    await Deno.remove(accepted);

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
    assert(json(r3.out).problems.some((p: string) => p.startsWith("approval not counted")));
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
    assertStringIncludes(i4.gate.items[0].allowedBy, "approved by alice-daily");

    // A change cannot turn off the gate that judges it: the base's gate applies.
    await Deno.writeTextFile(
      fleetTs,
      (await Deno.readTextFile(fleetTs)).replace('block: "weakens"', 'block: "never"'),
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
    await Deno.remove(sb.home, { recursive: true }).catch(() => {});
  }
});

Deno.test("074: SCF names in the declarations' controls come from scf.ts", () => {
  for (const d of IMPLEMENTATIONS) assert(SCF.some((c) => c.id === d.scf), d.id);
});
