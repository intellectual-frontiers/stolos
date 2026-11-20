/**
 * Spec 115-compatibility: the contract between a PC and its machines, in seams with versions of their own. The parts that touch a machine
 * run for real: the probe script under `sh`, `archon state` in a host root, `stolos fleet status`, `compat`, `build` and a signed `apply`
 * of a copy of the example lab, the real `tools/compat-digest.ts`, and real Git repositories for `git ls-remote`. The servers are
 * stand-ins only where the transport is: an `ssh` on the PATH answering newline-delimited JSON-RPC with what the real `archon state`
 * printed (as spec 048's and 112's tests have it).
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { CODE_LISTS } from "../ontology/stolos/mod.ts";
import { terms as auditTerms } from "../ontology/stolos/audit.ts";
import { stolos as stolosTerms } from "../ontology/stolos/vocabulary.ts";
import { COMPAT_STATUSES, SEAM_IDS } from "../src/archon/ontology.auto.ts";
import {
  compareSemVer,
  describeCompat,
  judgeMachine,
  judgeSeam,
  MACHINE_SEAMS,
  ownReport,
  parseSemVer,
  PROBE_SEAMS,
  SEAMS,
  seamRuleProblems,
} from "../src/archon/core/compat.ts";
import { VERSION, versionLine } from "../src/archon/version.ts";
import { TAG_PREFIX } from "../src/archon/version.ts";
import { reportFromProbe, sanitizeCompat, sanitizeReport } from "../src/archon/model/reported.ts";
import { keepReport, lastReport } from "../src/archon/state/reported.ts";
import { parseProbe, PROBE_SCRIPT, PROBE_VERSION } from "../src/archon/adopt/probe.ts";
import { policies } from "../src/archon/adopt/policy.ts";
import { machineSource, toObserved, type AdoptedDef } from "../src/archon/adopt/adopt.ts";
import { fleetEvidence } from "../src/archon/compliance/report.ts";
import { loadScf } from "../src/archon/compliance/catalog.ts";
import {
  applyWarnings,
  compatOf,
  contractOfProbeVersion,
  fleetCompat,
} from "../src/archon/observe/compat.ts";
import { compatReport } from "../src/archon/observe/compat-command.ts";
import {
  DIGESTED_SEAMS,
  formatDigests,
  modelShape,
  parseDigests,
  queryShape,
  reconcileDigests,
  sha256,
  shapeText,
} from "../src/archon/observe/compat-shapes.ts";
import { mcpShape } from "../src/archon/mcp/compat-shape.ts";
import {
  checkEngineTags,
  describeHold,
  ENGINE_TAG,
  engineHoldProblems,
  engineUrl,
  HOLD_MAX_DAYS,
  holdExpired,
  holdFor,
  holdProblems,
} from "../src/archon/fleet/engine-holds.ts";
import { EXPLAIN } from "../src/archon/core/explain.ts";
import {
  machinePage,
  machinesCsv,
  machinesPage,
  stolosOverview,
  evidence,
} from "../src/archon/console/stolos-pages.ts";
import type { PcCompat, PcFacts } from "../src/archon/console/pc.ts";
import { VIEWS } from "../src/archon/state/store.ts";
import type { EngineHoldBy } from "../src/archon/model/holds.ts";
import { DIGEST_FILE, main as digestMain, shapes } from "../tools/compat-digest.ts";
import { FACTS } from "./console/serve-stolos.ts";
import { engineRepo } from "./lab-fleet.ts";
import { fleet as sandboxFleet } from "./lab-fleet.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

const AT = "2026-11-18T10:00:00Z";

/** The JSON object in a command's output (stdout and stderr are joined: a runtime may add a warning after it). */
function jsonIn(out: string): string {
  const from = out.search(/^\{$/m);
  const to = out.lastIndexOf("\n}");
  assert(from >= 0 && to > from, `no JSON in: ${out}`);
  return out.slice(from, to + 2);
}

/** What a machine of this PC's own engine reports of its seams. */
const own = () => ownReport();

/** A report of a machine's seams, from `current` for each of a kind's seams, with a minimum each. */
const said = (
  current: Partial<Record<(typeof SEAM_IDS)[number], string>>,
  minimum = "1.0.0",
  engine = "0.148.0",
) => ({
  engine,
  seams: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, { current: v, minimum }])),
});

const managed = (over: Partial<Record<(typeof SEAM_IDS)[number], string>> = {}) =>
  said({ model: "1.0.0", "signed-records": "1.0.0", query: "1.0.0", mcp: "1.0.0", ...over });

// ------------------------------------------------------------------------------ the ontology

proves(
  ["115-compatibility FR-001", "115-compatibility FR-007"],
  "115: the seams and the statuses are code lists of the ontology, mapped to SKOS (no new unaligned term), and the code imports their unions",
  () => {
    assertEquals(SEAM_IDS, ["model", "signed-records", "probe-facts", "query", "mcp"]);
    assertEquals(COMPAT_STATUSES, ["compatible", "too-old", "newer", "unknown"]);
    assertEquals(Object.keys(CODE_LISTS.Seam.list), SEAM_IDS.slice());
    for (const local of ["Seam", "CompatStatus"] as const) {
      assert(local in stolosTerms, `${local} is defined`);
      const rec = auditTerms.find((t) => t.iri.endsWith(`term-stolos-${local}`));
      assert(rec !== undefined, `${local} has an audit record`);
      const json = JSON.stringify(rec.values);
      assertStringIncludes(json, "http://www.w3.org/2004/02/skos/core#ConceptScheme");
      assert(!json.includes("Decision pending"), `${local} is mapped, not unaligned`);
    }
    // Each member cites this spec (check:trace holds it too).
    for (const list of [CODE_LISTS.Seam.list, CODE_LISTS.CompatStatus.list]) {
      for (const m of Object.values(list)) {
        assertStringIncludes(JSON.stringify(m), "115-compatibility");
      }
    }
  },
);

// ------------------------------------------------------------------------------ FR-001, FR-002: the seams

proves(
  ["115-compatibility FR-001", "115-compatibility FR-002"],
  "115: every seam has a current and a minimum that are Semantic Versions, minimum never above current and never of a newer major; a broken table is found; the numbers are written once",
  async () => {
    assertEquals(seamRuleProblems(), []);
    for (const id of SEAM_IDS) {
      assert(parseSemVer(SEAMS[id].current) && parseSemVer(SEAMS[id].minimum), id);
    }
    // The table's first numbers (the spec's Decisions), and the machine's and the probe's seams.
    assertEquals(
      Object.fromEntries(SEAM_IDS.map((s) => [s, `${SEAMS[s].current} >= ${SEAMS[s].minimum}`])),
      {
        model: "1.0.0 >= 1.0.0",
        "signed-records": "1.0.0 >= 1.0.0",
        "probe-facts": "3.1.0 >= 1.0.0",
        query: "1.0.0 >= 1.0.0",
        mcp: "1.0.0 >= 1.0.0",
      },
    );
    assertEquals([...MACHINE_SEAMS, ...PROBE_SEAMS].sort(), [...SEAM_IDS].sort());
    // A table that breaks the rules is said, seam by seam.
    const bad = {
      ...SEAMS,
      model: { current: "1.0.0", minimum: "1.1.0" },
      query: { current: "1.4.0", minimum: "2.0.0" },
      mcp: { current: "one", minimum: "1.0.0" },
    };
    const problems = seamRuleProblems(bad);
    assertEquals(problems.length, 3);
    assertStringIncludes(problems.join("\n"), "model: minimum 1.1.0 is above current 1.0.0");
    assertStringIncludes(problems.join("\n"), "query: minimum 2.0.0 is above current 1.4.0");
    assertStringIncludes(problems.join("\n"), "mcp: current one");
    // Precedence is by number, not by text.
    assertEquals(compareSemVer([1, 10, 0], [1, 9, 0]), 1);
    assertEquals(parseSemVer("1.2.3.4"), undefined);
    assertEquals(parseSemVer("1.2.3-rc1"), undefined);
    assertEquals(parseSemVer("123456.0.0"), undefined);
    // The numbers are written in one place: no other source file writes a seam's version as a literal pair.
    const src = path.join(ENGINE_ROOT, "src", "archon");
    const hits: string[] = [];
    for (const f of ["core/compat.ts", "observe/compat.ts", "observe/compat-shapes.ts"]) {
      const text = await fs.readTextFile(path.join(src, f));
      if (f !== "core/compat.ts" && /current: "\d+\.\d+\.\d+"/.test(text)) hits.push(f);
    }
    assertEquals(hits, []);
    // The model's hold type spells the engine tag as the version module does.
    assert(ENGINE_TAG.test(`${TAG_PREFIX}0.150.0`));
    const types = await fs.readTextFile(path.join(src, "model/types.ts"));
    assertStringIncludes(types, "type EngineTag = `stolos-v${number}.${number}.${number}`");
    assertEquals(TAG_PREFIX, "stolos-v");
  },
);

// ------------------------------------------------------------------------------ FR-007, FR-008: the judgement and its words

proves(
  ["115-compatibility FR-007"],
  "115: a seam is compatible, too old, newer or unknown by the machine's current and minimum against the PC's; the engine's number takes no part",
  () => {
    const pc = SEAMS.model;
    assertEquals(
      judgeSeam("model", { current: pc.current, minimum: pc.minimum }).status,
      "compatible",
    );
    // A machine ahead by a minor, with the same major, is compatible (an addition a reader may ignore).
    assertEquals(judgeSeam("model", { current: "1.7.0", minimum: "1.0.0" }).status, "compatible");
    // Below the PC's minimum: too old, and it says which seam and what is needed.
    const old = judgeSeam("model", { current: "0.9.0", minimum: "0.9.0" });
    assertEquals(old.status, "too-old");
    assertEquals(old.why, "model is 0.9.0, this PC needs 1.0.0");
    // The machine no longer reads what this PC sends (its minimum is above the PC's current): newer.
    const newer = judgeSeam("model", { current: "1.9.0", minimum: "1.5.0" });
    assertEquals(newer.status, "newer");
    assertStringIncludes(newer.why ?? "", "needs a PC at 1.5.0, this PC has 1.0.0");
    // A higher major than this PC reads is newer even when the machine still reads this PC.
    assertEquals(judgeSeam("model", { current: "2.0.0", minimum: "1.0.0" }).status, "newer");
    // Not reported, or not a version: unknown, never an error.
    assertEquals(judgeSeam("model", undefined).status, "unknown");
    assertEquals(judgeSeam("model", { current: "latest" }).status, "unknown");
    assertEquals(judgeSeam("model", { current: "1.0" }).status, "unknown");
    // The edge: exactly the PC's minimum is compatible, one patch below is not (when the PC has a patch to go below).
    assertEquals(judgeSeam("probe-facts", { current: "1.0.0" }).status, "compatible");
    assertEquals(judgeSeam("probe-facts", { current: "0.9.9" }).status, "too-old");
    // Whole machines: too old comes before newer, then unknown, then compatible; the engine takes no part.
    const mix = judgeMachine("managed", managed({ model: "0.1.0", mcp: "3.0.0" }));
    assertEquals(mix.status, "too-old");
    assertEquals(judgeMachine("managed", managed({ mcp: "3.0.0" })).status, "newer");
    const partial = judgeMachine("managed", {
      engine: "0.148.0",
      seams: { model: { current: "1.0.0" } },
    });
    assertEquals(partial.status, "unknown");
    assertEquals(judgeMachine("managed", undefined).status, "unknown");
    assertEquals(judgeMachine("managed", { seams: {} }).status, "unknown");
    const a = judgeMachine("managed", managed({}));
    const b = judgeMachine("managed", { ...managed({}), engine: "0.1.0" });
    const c = judgeMachine("managed", { ...managed({}), engine: "99.0.0" });
    assertEquals([a.status, b.status, c.status], ["compatible", "compatible", "compatible"]);
    // An adopted machine has the probe's seam only; a managed machine's seams do not count for it.
    assertEquals(
      judgeMachine("adopted", { seams: { "probe-facts": { current: "3.0.0" } } }).status,
      "compatible",
    );
    assertEquals(judgeMachine("adopted", managed({})).status, "unknown");
    assertEquals(
      judgeMachine("adopted", managed({})).seams.map((s) => s.seam),
      ["probe-facts"],
    );
    assertEquals(judgeMachine("managed", managed({})).seams.length, 4);
    // What this engine reports of itself is what it judges compatible.
    assertEquals(judgeMachine("managed", own()).status, "compatible");
    assertEquals(own().engine, VERSION);
  },
);

proves(
  ["115-compatibility FR-008"],
  "115: each status is said in plain words, with its fix as one command, from one function",
  () => {
    const ok = describeCompat("alpha", "managed", judgeMachine("managed", managed()), "0.152.0");
    assertEquals(ok.headline, "compatible");
    assertEquals(ok.detail, "alpha runs engine 0.148.0, compatible with this PC's 0.152.0");
    assertEquals(ok.fix, undefined);
    assertEquals(ok.code, undefined);
    const same = describeCompat(
      "alpha",
      "managed",
      judgeMachine("managed", managed({}) && { ...managed(), engine: "0.152.0" }),
      "0.152.0",
    );
    assertEquals(same.detail, "alpha runs engine 0.152.0, the same as this PC");
    const old = describeCompat(
      "alpha",
      "managed",
      judgeMachine("managed", managed({ model: "0.9.0" })),
    );
    assertEquals(old.headline, "too old for this PC: run archon update on alpha");
    assertEquals(old.fix, "ssh alpha archon update");
    assertEquals(old.code, "E115-TOO-OLD");
    assertStringIncludes(old.detail, "model is 0.9.0, this PC needs 1.0.0");
    const newer = describeCompat(
      "alpha",
      "managed",
      judgeMachine("managed", managed({ mcp: "3.0.0" })),
    );
    assertEquals(newer.headline, "newer than this PC: run bun run stolos update");
    assertEquals(newer.fix, "bun run stolos update");
    assertEquals(newer.code, "E115-NEWER");
    const unknown = describeCompat("alpha", "managed", judgeMachine("managed", undefined));
    assertEquals(unknown.headline, "unknown (not reported yet)");
    assertEquals(unknown.fix, "bun run stolos fleet status");
    assertEquals(unknown.code, "P115-UNKNOWN");
    // An adopted machine's fix is the command that installs the current probe, and its observe.
    const probe = describeCompat(
      "nas",
      "adopted",
      judgeMachine("adopted", { seams: { "probe-facts": { current: "0.5.0" } } }),
    );
    assertEquals(probe.fix, "bun run stolos host adopt nas");
    assertStringIncludes(probe.headline, "install the current probe on nas");
    assertEquals(
      describeCompat("nas", "adopted", judgeMachine("adopted", undefined)).fix,
      "bun run stolos host observe nas",
    );
    // Every code is one `stolos explain` knows, and no sentence names a secret.
    for (const code of ["E115-TOO-OLD", "E115-NEWER", "P115-UNKNOWN"]) {
      assert(EXPLAIN[code] !== undefined, code);
    }
    for (const w of [ok, same, old, newer, unknown, probe]) {
      assert(!/key|token|secret|password/i.test(`${w.headline} ${w.detail}`), w.detail);
    }
  },
);

// ------------------------------------------------------------------------------ FR-003: the digests

proves(
  ["115-compatibility FR-003"],
  "115: the committed digests equal the code's shapes at the versions they are recorded under (the golden test); a change of shape under an unchanged version is refused",
  async () => {
    const file = path.join(ENGINE_ROOT, DIGEST_FILE);
    const recorded = parseDigests(await fs.readTextFile(file));
    assertEquals(
      recorded.map((e) => e.seam),
      [...DIGESTED_SEAMS],
    );
    const now = await shapes();
    for (const e of recorded) {
      assertEquals(
        e.version,
        SEAMS[e.seam].current,
        `${e.seam}: the recorded version is the seam's`,
      );
      assertEquals(
        e.digest,
        now[e.seam],
        `the shape of ${e.seam} changed: raise its version in src/archon/core/compat.ts (the major for a change that breaks a reader, the minor for an addition), then run bun run compat:digest`,
      );
    }
    // The file is exactly what the tool writes, and the tool's own check agrees.
    assertEquals(await fs.readTextFile(file), formatDigests(recorded));
    assertEquals(await digestMain(["--check"]), 0);
    // The shapes are derived: the views of the state store, the MCP tools served at mutate, the model's types.
    assertEquals(sha256(queryShape()), now.query);
    assertStringIncludes(queryShape(), "archon_tags(dimension,host,set_at,set_by,source,value)");
    assert(Object.keys(VIEWS).every((v) => queryShape().includes(`${v}(`)));
    const mcp = mcpShape();
    assertStringIncludes(mcp, "archon_state read (");
    assert(
      !mcp.split("\n").some((l) => l.startsWith("archon_compat ")),
      "a PC command is not a machine's tool",
    );
    assertStringIncludes(await modelShape(), "interface HostDef");
    // Comments and layout do not move the model's digest; a field does.
    const a = "export interface A {\n  /** x */\n  name: string; // y\n  n?: number;\n}";
    const b = "export interface A { name: string; n?: number }";
    assertEquals(shapeText(a), shapeText("export interface A { name: string; n?: number; }"));
    assert(shapeText(a) !== shapeText(b.replace("n?:", "m?:")), "a renamed field is a change");
    assertEquals(
      shapeText('const u = "https://x.example/a"; // c'),
      'const u = "https://x.example/a";',
    );
    // The one rule, in every direction.
    const cur = (m: string, q: string, c: string) => ({
      model: { current: m },
      query: { current: q },
      mcp: { current: c },
      "signed-records": { current: "1.0.0" },
      "probe-facts": { current: "3.1.0" },
    });
    const rec = (m = "1.0.0", q = "1.0.0", c = "1.0.0") =>
      [
        { seam: "model", version: m, digest: "a".repeat(64) },
        { seam: "query", version: q, digest: "b".repeat(64) },
        { seam: "mcp", version: c, digest: "c".repeat(64) },
      ] as const;
    const same = { model: "a".repeat(64), query: "b".repeat(64), mcp: "c".repeat(64) };
    assertEquals(reconcileDigests(rec(), same, cur("1.0.0", "1.0.0", "1.0.0")).changed, false);
    const refused = reconcileDigests(
      rec(),
      { ...same, query: "d".repeat(64) },
      cur("1.0.0", "1.0.0", "1.0.0"),
    );
    assertEquals(refused.problems.length, 1);
    assertStringIncludes(refused.problems[0] ?? "", "the shape of query changed");
    assertStringIncludes(
      refused.problems[0] ?? "",
      "the major for a change that breaks a reader, the minor for an addition",
    );
    // A raised version records the new digest; a raised version with the same shape is recorded too.
    const raised = reconcileDigests(
      rec(),
      { ...same, query: "d".repeat(64) },
      cur("1.0.0", "1.1.0", "1.0.0"),
    );
    assertEquals(raised.problems, []);
    assertEquals(raised.next.find((e) => e.seam === "query")?.version, "1.1.0");
    assertEquals(reconcileDigests(rec(), same, cur("1.2.0", "1.0.0", "1.0.0")).changed, true);
    // A lowered version is not a raise.
    assertEquals(
      reconcileDigests(
        rec("1.3.0"),
        { ...same, model: "e".repeat(64) },
        cur("1.2.0", "1.0.0", "1.0.0"),
      ).problems.length,
      1,
    );
    // No record yet: recorded as it is.
    assertEquals(reconcileDigests([], same, cur("1.0.0", "1.0.0", "1.0.0")).problems, []);
  },
  { timeout: 180_000 },
);

proves(
  ["115-compatibility FR-003"],
  "115: bun run compat:digest (the real tool) writes the file, checks it, and refuses a recorded shape that changed under the same version, on real files",
  async () => {
    const root = await fs.makeTempDir({ prefix: "archon-digest115-" });
    try {
      await fs.ensureDir(path.join(root, "tests"));
      const file = path.join(root, DIGEST_FILE);
      // No file: --check fails and says what to run; writing makes it, and then the check passes.
      assertEquals(await digestMain(["--check"], root), 1);
      assertEquals(await digestMain([], root), 0);
      assertEquals(
        await fs.readTextFile(file),
        await fs.readTextFile(path.join(ENGINE_ROOT, DIGEST_FILE)),
      );
      assertEquals(await digestMain(["--check"], root), 0);
      // A shape that differs from the record, under the same version: refused, and the file is not touched.
      const was = await fs.readTextFile(file);
      const tampered = was.replace(/^(model 1\.0\.0 )[0-9a-f]{64}$/m, `$1${"f".repeat(64)}`);
      assert(tampered !== was);
      await fs.writeTextFile(file, tampered);
      assertEquals(await digestMain([], root), 1);
      assertEquals(await digestMain(["--check"], root), 1);
      assertEquals(await fs.readTextFile(file), tampered);
      // The same recorded under an older version: the code's version is higher, so the new shape is recorded.
      await fs.writeTextFile(file, tampered.replace("model 1.0.0", "model 0.9.0"));
      assertEquals(await digestMain([], root), 0);
      assertEquals(await fs.readTextFile(file), was);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

// ------------------------------------------------------------------------------ FR-004: the probe

/** The probe, run under sh with its sources pointed at a folder the test controls. */
async function probeFacts(root: string, script = PROBE_SCRIPT): Promise<string> {
  const file = path.join(root, "probe.sh");
  await fs.writeTextFile(
    file,
    script
      .replaceAll("/etc/machine-info", path.join(root, "machine-info"))
      .replaceAll("/sys/class/dmi/id", path.join(root, "dmi")),
  );
  const r = await proc.run(["sh", file], {
    env: { PATH: proc.env.get("PATH") ?? "", SSH_ORIGINAL_COMMAND: "facts", HOME: root },
    signal: AbortSignal.timeout(60_000),
  });
  assertEquals(r.code, 0, r.stderr);
  return r.stdout;
}

proves(
  ["115-compatibility FR-004"],
  "115: the probe (run by sh, and the PowerShell script as text) reports the version of its facts in @compat, its own version is the major, and the PC reads a probe without the section as <version>.0.0",
  async () => {
    const root = await fs.makeTempDir({ prefix: "archon-probe115-" });
    try {
      const section = parseProbe(await probeFacts(root))["compat"];
      assertEquals(section?.["probe_facts"], SEAMS["probe-facts"].current);
      assertEquals(section?.["probe_minimum"], "1.0.0");
      // Its own version is the seam's major.
      assertEquals(String(parseSemVer(SEAMS["probe-facts"].current)?.[0]), PROBE_VERSION);
      assertEquals(parseProbe(await probeFacts(root))["probe"]?.["version"], PROBE_VERSION);
      // The PowerShell probe says the same numbers (it is read as text here; a Windows machine runs it).
      const ps = await fs.readTextFile(path.join(ENGINE_ROOT, "bin/stolos-probe.ps1"));
      assertStringIncludes(ps, "'@compat'");
      assertStringIncludes(ps, `kv probe_facts '${SEAMS["probe-facts"].current}'`);
      assertStringIncludes(ps, "kv probe_minimum '1.0.0'");
      assertStringIncludes(ps, `$version = '${PROBE_VERSION}'`);
      // The PC reads it as the seam, with the minimum it states.
      const r = reportFromProbe(undefined, AT, { compat: section, version: PROBE_VERSION });
      assertEquals(r?.compat?.seams["probe-facts"], { current: "3.1.0", minimum: "1.0.0" });
      assertEquals(r?.compat?.engine, undefined, "a probe has no engine");
      // A probe before @compat: its version is the major.
      assertEquals(reportFromProbe({}, AT, { version: "2" })?.compat?.seams["probe-facts"], {
        current: "2.0.0",
      });
      assertEquals(reportFromProbe(undefined, AT, { version: "?" }), undefined);
      // A hostile section says nothing of the seam and breaks nothing.
      assertEquals(
        reportFromProbe(undefined, AT, { compat: { probe_facts: "$(touch x)" }, version: "x" }),
        undefined,
      );
      assertEquals(contractOfProbeVersion("3")?.seams["probe-facts"]?.current, "3.0.0");
      assertEquals(contractOfProbeVersion("?"), undefined);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
  {
    skip: proc.build.os === "windows" && "the POSIX probe is Linux's and macOS's",
    timeout: 180_000,
  },
);

// ------------------------------------------------------------------------------ FR-006: the PC's cache, untrusted input

proves(
  ["115-compatibility FR-006"],
  "115: what a machine reports of its engine and seams is kept bounded in the PC's cache: only versions and the ontology's seams survive, hostile words are dropped and break nothing, an unreachable machine keeps its last",
  async () => {
    const hostile = {
      at: AT,
      compat: {
        engine: "0.148.0; rm -rf /",
        seams: {
          model: { current: "1.0.0", minimum: "$(id)" },
          query: { current: "1.0", minimum: "1.0.0" },
          mcp: { current: "999999.0.0" },
          "signed-records": { current: "1.2.3", extra: "x".repeat(10_000) },
          "made-up-seam": { current: "1.0.0" },
          __proto__: { current: "1.0.0" },
        },
      },
    };
    const clean = sanitizeCompat(hostile.compat);
    assertEquals(clean, {
      seams: { model: { current: "1.0.0" }, "signed-records": { current: "1.2.3" } },
    });
    assertEquals(sanitizeCompat("nope"), undefined);
    assertEquals(sanitizeCompat({ seams: 5 }), undefined);
    assertEquals(sanitizeCompat({ engine: "1.2.3" }), { engine: "1.2.3", seams: {} });
    const dir = await fs.makeTempDir({ prefix: "archon-cache115-" });
    try {
      assertEquals(await keepReport("alpha", { ...hostile, compat: managed() }, dir), true);
      const kept = await lastReport("alpha", dir);
      assertEquals(kept?.compat?.engine, "0.148.0");
      assertEquals(Object.keys(kept?.compat?.seams ?? {}).sort(), [
        "mcp",
        "model",
        "query",
        "signed-records",
      ]);
      // It sits beside what the machine says of its tags (one record), and a later report replaces it.
      assertEquals(
        sanitizeReport({
          at: AT,
          tags: [{ dimension: "env", value: "prod", source: "local" }],
          compat: managed(),
        })?.tags?.length,
        1,
      );
      // fleetCompat reads the cache: reported, unreported, and an adopted machine's probe from its observation.
      const hosts = [{ name: "alpha" }, { name: "beta" }] as never;
      const list = await fleetCompat({
        hosts,
        adopted: [
          { machine: { name: "nas" }, observed: { probe: "3" } },
          { machine: { name: "old" }, observed: { probe: "?" } },
        ],
        dir,
        fleetPin: undefined,
      });
      assertEquals(
        list.map((m) => `${m.name}:${m.judgement.status}`),
        ["alpha:compatible", "beta:unknown", "nas:compatible", "old:unknown"],
      );
      assertEquals(list[0]?.reportedAt, AT);
      // A report with a seam too old, kept over the last one: the cache says the newest.
      await keepReport("alpha", { at: AT, compat: managed({ model: "0.1.0" }) }, dir);
      assertEquals(
        (await fleetCompat({ hosts, dir })).find((m) => m.name === "alpha")?.judgement.status,
        "too-old",
      );
      // A cache that is garbage is read as nothing, never as a failure.
      await fs.writeTextFile(path.join(dir, "archon.sql"), "not sql at all");
      assertEquals(
        (await fleetCompat({ hosts, dir })).map((m) => m.judgement.status),
        ["unknown", "unknown"],
      );
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

// ------------------------------------------------------------------------------ FR-010: the finding, FR-011: the warning

proves(
  ["115-compatibility FR-010"],
  "115: a machine that is not compatible is a failing finding (CHG-03, CFG-04) with its fix; compatible passes; unreported gives none; an adopted machine's is a policy of its pack",
  async () => {
    const compat = (status: PcCompat["status"], fix?: string): PcCompat => ({
      status,
      headline: status,
      detail: `alpha says ${status}`,
      ...(fix ? { fix } : {}),
      reportedAt: AT,
      seams: [],
    });
    const mk = (name: string, c?: PcCompat) =>
      ({
        ...FACTS.machines[0],
        name,
        kind: "server",
        ...(c ? { compat: c } : { compat: undefined }),
      }) as (typeof FACTS.machines)[number];
    const f = {
      ...FACTS,
      machines: [
        mk("alpha", compat("too-old", "ssh alpha archon update")),
        mk("beta", compat("compatible")),
        mk("gamma", compat("unknown")),
        mk("delta", compat("newer", "bun run stolos update")),
        mk("epsilon"),
      ],
      adopted: [],
    };
    const ev = fleetEvidence(f).filter((e) => e.check === "Speaks this PC's contract");
    assertEquals(
      ev.map((e) => `${e.subject}:${e.status}`),
      ["alpha:fail", "beta:pass", "delta:fail"],
    );
    assertEquals(ev[0]?.scf, ["CHG-03", "CFG-04"]);
    assertEquals(ev[0]?.fix, "ssh alpha archon update");
    assertEquals(ev[1]?.fix, undefined);
    assertEquals(ev[0]?.observedAt, AT);
    // The adopted pack: the probe's version in its observation decides (host check), with the probe's own fix.
    const machine: AdoptedDef = {
      name: "nas",
      ssh: { user: "alice", address: "10.0.0.9" },
      hostKeys: [],
      adopted: "2026-11-01",
    };
    const obs = (probe: string) =>
      toObserved(
        parseProbe(
          `@probe\nversion=${probe}\nat=${AT}\n@os\nkernel=Linux\nfamily=ubuntu\nversion=26.04\n`,
        ),
      );
    const result = (probe: string) =>
      policies(machine, obs(probe), Date.parse(AT)).find((r) => r.id === "speaks-contract");
    assertEquals(result("3")?.status, "pass");
    assertEquals(result("1")?.status, "pass", "every probe ever released is read");
    assertEquals(result("?"), undefined, "an unknown probe gives no evidence either way");
    assertEquals(result("3")?.scf, ["CHG-03", "CFG-04"]);
    assertEquals(result("9")?.status, "fail");
    assertEquals(result("9")?.fix, "bun run stolos update");
    assertStringIncludes(result("9")?.detail ?? "", "newer than this PC");
    // The SCF controls are SCF's, with SCF's names (the pinned workbook, when this machine has it cached; CI requires it).
    const catalog = await loadScf().catch(() => undefined);
    if (catalog === undefined) {
      assert(
        proc.env.get("STOLOS_REQUIRE_SCF") === undefined,
        "STOLOS_REQUIRE_SCF is set (CI) but the SCF catalog is not cached",
      );
      return;
    }
    assertEquals(catalog.controls["CHG-03"]?.name, "Configuration Change Control");
    assertEquals(catalog.controls["CFG-04"]?.name, "Secure Baseline Configurations");
  },
);

// ------------------------------------------------------------------------------ the console

proves(
  ["115-compatibility FR-009"],
  "115: the console says the contract in a column of the machines table, a card on the machine's page, the Overview and the CSV and evidence JSON",
  () => {
    const c = (status: PcCompat["status"], extra: Partial<PcCompat> = {}): PcCompat => ({
      status,
      headline:
        status === "too-old"
          ? "too old for this PC: run archon update on alpha"
          : status === "newer"
            ? "newer than this PC: run bun run stolos update"
            : status,
      detail: `alpha runs engine 0.148.0, ${status}: <b>x</b>`,
      engine: "0.148.0",
      seams: [
        { seam: "model", status, machine: "0.9.0", pc: "1.0.0", needs: "1.0.0" },
        { seam: "mcp", status: "compatible", machine: "1.0.0", pc: "1.0.0", needs: "1.0.0" },
      ],
      ...(status === "too-old" ? { fix: "ssh alpha archon update", code: "E115-TOO-OLD" } : {}),
      ...extra,
    });
    const f: PcFacts = {
      ...FACTS,
      machines: FACTS.machines.map((m, i) =>
        i === 0
          ? {
              ...m,
              compat: c("too-old", { held: "held at stolos-v0.150.0 (fleet pin stolos-v0.152.0)" }),
            }
          : i === 1
            ? { ...m, compat: c("compatible") }
            : m,
      ),
    };
    const table = machinesPage(f).toString();
    assertStringIncludes(table, "<th>Contract</th>");
    assertStringIncludes(table, 'data-contract="too-old"');
    assertStringIncludes(table, ">too old</span");
    assertStringIncludes(table, 'data-contract="compatible"');
    // The detail is a title attribute: escaped, never markup.
    assert(!table.includes("<b>x</b>"), "a machine's words are escaped");
    const first = FACTS.machines[0]?.name ?? "alpha";
    const page = machinePage(f, first)?.toString() ?? "";
    assertStringIncludes(page, "Contract with this PC");
    assertStringIncludes(page, "too old for this PC: run archon update on alpha");
    assertStringIncludes(page, "ssh alpha archon update");
    assertStringIncludes(page, "stolos explain E115-TOO-OLD");
    assertStringIncludes(page, "held at stolos-v0.150.0 (fleet pin stolos-v0.152.0)");
    assertStringIncludes(page, "0.9.0");
    assertStringIncludes(page, "the engine may differ: only these seams decide");
    const over = stolosOverview(f).toString();
    assertStringIncludes(over, "too old for this PC: run archon update on alpha");
    assertStringIncludes(over, `/machines/${encodeURIComponent(first)}#contract`);
    assertStringIncludes(
      over.replace(/\s+/g, " "),
      "1 of 2 machine(s) that reported are compatible",
    );
    // The CSV and the evidence carry it.
    const csv = machinesCsv(f).split("\r\n");
    assertStringIncludes(csv[0] ?? "", ",engine,contract");
    assertStringIncludes(csv[1] ?? "", "0.148.0,too-old");
    const ev = JSON.stringify(evidence(f));
    assertStringIncludes(ev, '"contract":{"status":"too-old"');
    assertStringIncludes(ev, '"statement":"too old for this PC: run archon update on alpha"');
    // A machine with no contract (a cloud server) shows no card, and nothing breaks.
    const cloud = f.machines.find((m) => m.kind === "cloud");
    if (cloud)
      assert(!(machinePage(f, cloud.name)?.toString() ?? "").includes("Contract with this PC"));
  },
);

// ------------------------------------------------------------------------------ FR-013, FR-014, FR-015: holds

proves(
  ["115-compatibility FR-013", "115-compatibility FR-014", "115-compatibility FR-015"],
  "115: a hold is typed (tag form, reason, a date at most 180 days away), a host's own wins over a group's, an expired hold is ignored and said, and the words never claim the machine runs it",
  () => {
    const today = new Date("2026-11-18T12:00:00Z");
    const ok = { tag: "stolos-v0.150.0" as const, reason: "a pilot", until: "2026-12-31" };
    assertEquals(holdProblems(ok, today), []);
    assertEquals(HOLD_MAX_DAYS, 180);
    for (const [hold, said] of [
      [{ ...ok, tag: "v0.150.0" }, "not an engine tag"],
      [{ ...ok, tag: "stolos-v0.150" }, "not an engine tag"],
      [{ ...ok, tag: "stolos-v0.150.0-rc1" }, "not an engine tag"],
      [{ ...ok, reason: "" }, "needs a reason"],
      [{ ...ok, until: "soon" }, "not a date"],
      [{ ...ok, until: "2026-02-30" }, "not a date"],
      [{ ...ok, until: "2027-06-01" }, "more than 180 days away"],
    ] as const) {
      assertStringIncludes(holdProblems(hold as never, today).join("; "), said);
    }
    // 180 days is still allowed, 181 is not.
    assertEquals(holdProblems({ ...ok, until: "2027-05-17" }, today), []);
    assertEquals(holdProblems({ ...ok, until: "2027-05-18" }, today).length, 1);
    // Expiry is by the day.
    assertEquals(holdExpired(ok, today), false);
    assertEquals(holdExpired({ ...ok, until: "2026-11-18" }, today), false);
    assertEquals(holdExpired({ ...ok, until: "2026-11-17" }, today), true);
    // Resolution: the host's own wins over a group's; the first group that chooses the host wins over the later.
    const fleet = {
      engineHolds: [
        {
          select: "env:lab",
          tag: "stolos-v0.149.0" as const,
          reason: "first",
          until: "2026-12-31",
        },
        {
          select: "env:lab or env:prod",
          tag: "stolos-v0.148.0" as const,
          reason: "second",
          until: "2026-12-31",
        },
        {
          select: "env:dev",
          tag: "stolos-v0.147.0" as const,
          reason: "ended",
          until: "2026-11-01",
        },
      ],
    };
    const lab = new Set(["env:lab"]);
    assertEquals(holdFor({}, fleet, lab, today)?.tag, "stolos-v0.149.0");
    assertEquals(holdFor({}, fleet, new Set(["env:prod"]), today)?.tag, "stolos-v0.148.0");
    assertEquals(holdFor({}, fleet, new Set(["env:stage"]), today), undefined);
    assertEquals(holdFor({ enginePin: ok }, fleet, lab, today)?.source, "host");
    assertEquals(holdFor({ enginePin: ok }, fleet, lab, today)?.tag, "stolos-v0.150.0");
    assertEquals(holdFor({}, fleet, lab, today)?.source, "group");
    const ended = holdFor({}, fleet, new Set(["env:dev"]), today);
    assertEquals(ended?.expired, true);
    assertStringIncludes(
      describeHold(ended as never, "stolos-v0.152.0"),
      "ended 2026-11-01: it follows the fleet pin stolos-v0.152.0 again",
    );
    // The words: held at X (fleet pin Y), and that the machine is not made to run it yet.
    const w = describeHold(
      holdFor({ enginePin: ok }, fleet, lab, today) as never,
      "stolos-v0.152.0",
    );
    assertStringIncludes(w, "held at stolos-v0.150.0 (fleet pin stolos-v0.152.0)");
    assertStringIncludes(w, "not enforced on the machine yet");
    // The model's problems for a fleet: a bad hold, an expression that does not parse, a tag nobody defines.
    const set = {
      dimensions: {
        env: {
          label: "E",
          description: "d",
          cardinality: "one-of",
          tags: { lab: { label: "L", colour: "green", description: "d" } },
        },
      },
    } as never;
    const first = fleet.engineHolds[0] as EngineHoldBy;
    const problems = engineHoldProblems(
      {
        engineHolds: [
          { ...first, select: "env:lab and" },
          { ...first, select: "env:nope" },
          { ...ok, select: "env:lab", reason: "" },
        ],
      },
      [{ name: "alpha", enginePin: { ...ok, tag: "latest" as never } }, { name: "beta" }],
      set,
      today,
    );
    const text = problems.map((p) => `${p.where}: ${p.message}`).join("\n");
    assertStringIncludes(text, 'hosts/alpha.enginePin: the tag "latest" is not an engine tag');
    assertStringIncludes(
      text,
      'fleet.engineHolds[0]: select "env:lab and" is not a tag expression',
    );
    assertStringIncludes(text, "fleet.engineHolds[1]: select: env:nope is not defined");
    assertStringIncludes(text, "fleet.engineHolds[2]: a hold needs a reason");
    for (const p of problems) assert(p.fix.length > 0, p.message);
    assertEquals(engineHoldProblems({}, [{ name: "alpha" }], set, today), []);
    // The engine's URL: GitHub for a github: source, the URL itself for a git+ source.
    assertEquals(
      engineUrl({ source: "github:intellectual-frontiers/stolos", tag: "stolos-v0.1.0" }),
      "https://github.com/intellectual-frontiers/stolos.git",
    );
    assertEquals(engineUrl({ source: "git+file:///tmp/e", tag: "stolos-v0.1.0" }), "file:///tmp/e");
    assertEquals(engineUrl({ source: "github:a/b/c", tag: "stolos-v0.1.0" }), undefined);
    // compatOf puts the hold's words beside the contract's.
    const cm = compatOf(
      "alpha",
      "managed",
      { at: AT, compat: managed() },
      { hold: holdFor({ enginePin: ok }, fleet, lab, today), fleetPin: "stolos-v0.152.0" },
    );
    assertStringIncludes(cm.holdWords ?? "", "held at stolos-v0.150.0 (fleet pin stolos-v0.152.0)");
  },
);

proves(
  ["115-compatibility FR-014"],
  "115: a held tag is checked with git ls-remote against a real repository: it exists, it is missing, and an unreachable repository is not a missing tag",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-holds115-" });
    try {
      const sh = async (cwd: string, ...a: string[]): Promise<string> => {
        const r = await proc.output(a, {
          cwd,
          stdin: "null",
          signal: AbortSignal.timeout(120_000),
        });
        if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
        return new TextDecoder().decode(r.stdout).trim();
      };
      const repo = path.join(dir, "engine");
      await fs.ensureDir(repo);
      await sh(repo, "git", "init", "-q", "-b", "main");
      await fs.writeTextFile(path.join(repo, "package.json"), "{}\n");
      await sh(repo, "git", "add", "-A");
      await sh(
        repo,
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "--no-gpg-sign",
        "-m",
        "engine",
      );
      // CI runners have no global Git identity: an annotated tag names one.
      await sh(
        repo,
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "tag",
        "-a",
        "-m",
        "release",
        "stolos-v0.150.0",
      );
      await sh(repo, "git", "tag", "stolos-v0.149.0");
      const url = path.toFileUrl(repo).href;
      const found = await checkEngineTags(
        ["stolos-v0.150.0", "stolos-v0.149.0", "stolos-v9.9.9"],
        url,
      );
      assertEquals(
        [...found],
        [
          ["stolos-v0.150.0", "exists"],
          ["stolos-v0.149.0", "exists"],
          ["stolos-v9.9.9", "missing"],
        ],
      );
      // An unreachable repository is not a missing tag.
      const gone = await checkEngineTags(
        ["stolos-v0.150.0"],
        path.toFileUrl(path.join(dir, "nowhere")).href,
        20_000,
      );
      assertEquals([...gone], [["stolos-v0.150.0", "not-checked"]]);
      // The command's data takes the check as given: a hold on a missing tag is a finding of the report.
      const machines = [
        compatOf(
          "alpha",
          "managed",
          { at: AT, compat: managed() },
          {
            hold: {
              tag: "stolos-v9.9.9",
              reason: "x",
              until: "2999-01-01",
              source: "host",
              expired: false,
            },
          },
        ),
      ];
      const r = await compatReport({ machines, checkTags: (tags) => checkEngineTags(tags, url) });
      assertEquals(r.machines[0]?.hold?.exists, "missing");
      assertEquals(
        r.seams.map((s) => s.seam),
        [...SEAM_IDS],
      );
      assertEquals(r.pc.engine, VERSION);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

proves(
  ["115-compatibility FR-015"],
  "115: the install side of a hold is not built, and the design with its exact blocker is in tasks.md",
  async () => {
    const tasks = await fs.readTextFile(path.join(ENGINE_ROOT, "specs/115-compatibility/tasks.md"));
    assertStringIncludes(tasks, "L001 **The install side of a hold**");
    assertStringIncludes(tasks, "--frozen-lockfile");
    assertStringIncludes(tasks, "The exact blocker");
    const spec = await fs.readTextFile(path.join(ENGINE_ROOT, "specs/115-compatibility/spec.md"));
    assertStringIncludes(spec, "not enforced on the machine yet");
    // No code path installs a held engine: nothing outside the model and the display reads a hold.
    const reconcile = await fs.readTextFile(
      path.join(ENGINE_ROOT, "src/archon/reconcile/reconcile.ts"),
    );
    assert(!reconcile.includes("enginePin") && !reconcile.includes("engineHold"));
  },
);

// ------------------------------------------------------------------------------ the whole way, for real

/** The example lab as a fleet repository in a sandbox, with a stand-in ssh that answers what a server's `archon state` printed. */
async function lab() {
  const f = await sandboxFleet();
  const { sb } = f;
  const servers = path.join(sb.home, "servers");
  const bin = path.join(sb.home, "bin");
  await fs.mkdir(servers, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  const realSsh = proc.which("ssh") ?? "ssh";
  // An adopted machine's probe is the real script, with its two sources pointed at a folder the test controls.
  const probeRoot = path.join(sb.home, "probe-root");
  await fs.ensureDir(path.join(probeRoot, "dmi"));
  const probeScript = path.join(sb.home, "probe.sh");
  await fs.writeTextFile(
    probeScript,
    PROBE_SCRIPT.replaceAll("/etc/machine-info", path.join(probeRoot, "machine-info")).replaceAll(
      "/sys/class/dmi/id",
      path.join(probeRoot, "dmi"),
    ),
  );
  await fs.writeTextFile(
    path.join(bin, "ssh"),
    `#!/bin/sh
D='${servers}'
for a; do last="$a"; done
case "$last" in facts|version) SSH_ORIGINAL_COMMAND="$last" exec sh '${probeScript}';; esac
case "$last" in ops@*) ;; *) exec '${realSsh}' "$@";; esac
h=\${last#*@}; h=\${h%%.*}
[ -f "$D/answer.$h" ] || { echo "ssh: connect to host $h port 22: No route to host" >&2; exit 255; }
while read -r l; do case "$l" in *'"id":2'*) cat "$D/answer.$h"; exit 0;; esac; done
`,
  );
  await fs.chmod(path.join(bin, "ssh"), 0o755);
  const answer = async (h: string, text: string): Promise<void> => {
    await fs.writeTextFile(
      path.join(servers, `answer.${h}`),
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } })}\n`,
    );
  };
  const env = { PATH: `${bin}:${proc.env.get("PATH")}` };
  // Root's side of alpha: a host root with the machine's own files.
  const root = path.join(sb.home, "alpha-root");
  await fs.ensureDir(path.join(root, "etc", "archon"));
  await fs.ensureDir(path.join(root, "var", "lib", "archon"));
  await fs.writeTextFile(path.join(root, "etc", "archon", "host"), "alpha\n");
  await fs.writeTextFile(path.join(root, "etc", "archon", "fleet"), "lab\n");
  const archon = (...args: string[]) =>
    sb.run("src/archon/main.ts", args, "", {
      ...f.env,
      ...env,
      ARCHON_REPO: f.repo,
      ARCHON_FLEET: "lab",
      ARCHON_ROOT: root,
    });
  const stolos = (args: string[], extra: Record<string, string> = {}) =>
    f.stolos(args, { ...env, ...extra });
  return { ...f, stolos, servers, bin, answer, env, root, archon, probeRoot };
}

proves(
  [
    "115-compatibility FR-005",
    "115-compatibility FR-006",
    "115-compatibility FR-007",
    "115-compatibility FR-008",
    "115-compatibility FR-009",
    "115-compatibility FR-011",
    "115-compatibility FR-012",
    "115-compatibility FR-016",
    "115-compatibility FR-017",
  ],
  "115: archon state carries the engine and seams, fleet status keeps them (no commit) and says each status in plain words with its code, stolos apply warns and sends anyway, stolos compat reports (--json, exit code)",
  async () => {
    const l = await lab();
    try {
      const { archon, stolos, sh, repo, origin } = l;
      // The machine: archon state says its engine and every seam it has (text and --json).
      let r = await archon("--host", "alpha", "--json", "state");
      assertEquals(r.code, 0, r.out);
      const state = JSON.parse(jsonIn(r.out)) as {
        compat: { engine: string; seams: Record<string, { current: string; minimum: string }> };
      };
      assertEquals(state.compat.engine, VERSION);
      assertEquals(Object.keys(state.compat.seams).sort(), [...MACHINE_SEAMS].sort());
      for (const s of MACHINE_SEAMS) assertEquals(state.compat.seams[s], SEAMS[s]);
      r = await archon("--host", "alpha", "--verbose", "state");
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, `engine ${VERSION}`);
      assertStringIncludes(r.out, "model 1.0.0");
      // The version lines are unchanged.
      r = await stolos(["--version"]);
      assertEquals(r.out.trim().split("\n").pop(), versionLine());
      r = await archon("--version");
      assertEquals(r.out.trim().split("\n").pop(), versionLine());
      const headBefore = await sh(repo, "git", "rev-parse", "HEAD");
      // A compatible machine on another engine: said in plain words, no problem, no commit.
      const withState = (c: unknown) => JSON.stringify({ ...state, compat: c });
      await l.answer("alpha", withState({ ...managed(), engine: "0.148.0" }));
      r = await stolos(["fleet", "status", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(
        r.out,
        `alpha runs engine 0.148.0, compatible with this PC's ${VERSION}`,
      );
      assertEquals(await sh(repo, "git", "rev-parse", "HEAD"), headBefore, "no commit per run");
      assertEquals(await sh(repo, "git", "status", "--porcelain"), "");
      r = await stolos(["compat", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "alpha");
      assertStringIncludes(r.out, "compatible");
      assertStringIncludes(r.out, "probe-facts");
      // Too old: a warning with its fix and code, and the explanation exists.
      await l.answer("alpha", withState(managed({ model: "0.9.0" })));
      r = await stolos(["fleet", "status"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "too old for this PC");
      assertStringIncludes(r.out, "model is 0.9.0, this PC needs 1.0.0");
      assertStringIncludes(r.out, "ssh alpha archon update");
      assertStringIncludes(r.out, "E115-TOO-OLD");
      r = await stolos(["explain", "E115-TOO-OLD"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "too old");
      // stolos compat: exit 1, the same words; --json is the same data.
      r = await stolos(["compat"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "too old for this PC");
      r = await stolos(["compat", "--json"]);
      assertEquals(r.code, 1, r.out);
      const rep = JSON.parse(jsonIn(r.out)) as {
        pc: { engine: string };
        seams: Array<{ seam: string }>;
        machines: Array<{ name: string; status: string; fix?: string; code?: string }>;
      };
      assertEquals(rep.pc.engine, VERSION);
      assertEquals(
        rep.seams.map((s) => s.seam),
        [...SEAM_IDS],
      );
      const alpha = rep.machines.find((m) => m.name === "alpha");
      assertEquals(alpha?.status, "too-old");
      assertEquals(alpha?.fix, "ssh alpha archon update");
      assertEquals(alpha?.code, "E115-TOO-OLD");
      assertEquals(rep.machines.find((m) => m.name === "beta")?.status, "unknown");
      r = await stolos(["compat", "--quiet"]);
      assertEquals(r.code, 1, r.out);
      // stolos apply warns before it signs, names the machine and the fix, and still sends.
      await fs.writeTextFile(
        path.join(repo, "NOTES.md"),
        "a change that every machine would receive\n",
      );
      r = await stolos(["apply", "-m", "115: a change"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "alpha may not be able to read this change");
      assertStringIncludes(r.out, "ssh alpha archon update");
      assertEquals(await sh(origin, "git", "log", "-1", "--format=%s", "main"), "115: a change");
      // Newer than this PC: the fix is on the PC.
      await l.answer("alpha", withState(managed({ mcp: "4.0.0" })));
      r = await stolos(["fleet", "status"]);
      assertStringIncludes(r.out, "newer than this PC");
      assertStringIncludes(r.out, "bun run stolos update");
      assertStringIncludes(r.out, "E115-NEWER");
      // An engine from before this check answers and says nothing of its engine: a thing to do, not a failure.
      const bare = JSON.parse(withState(undefined)) as Record<string, unknown>;
      delete bare["compat"];
      await l.answer("alpha", JSON.stringify(bare));
      r = await stolos(["fleet", "status"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "answered without reporting its engine");
      assertStringIncludes(r.out, "P115-UNKNOWN");
      // A machine that cannot be reached keeps its last report: alpha was newer, then unknown (it said nothing), so the cache holds its last words.
      await fs.remove(path.join(l.servers, "answer.alpha"));
      r = await stolos(["compat", "--json"]);
      const last = JSON.parse(jsonIn(r.out)) as {
        machines: Array<{ name: string; status: string }>;
      };
      assertEquals(last.machines.find((m) => m.name === "alpha")?.status, "unknown");
      // Warnings never block: the apply with nothing known says nothing about compatibility.
      const none = await applyWarnings({
        hosts: [{ name: "zeta" }] as never,
        dir: await fs.makeTempDir({ prefix: "archon-none115-" }),
      });
      assertEquals(none, []);
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script", timeout: 180_000 },
);

proves(
  ["115-compatibility FR-013", "115-compatibility FR-014", "115-compatibility FR-016"],
  "115: stolos build refuses a hold that is not typed right, accepts a sound one, and stolos compat shows it with the check against the engine's repository (a real git repository)",
  async () => {
    const l = await lab();
    try {
      const { stolos, repo, sh, sb } = l;
      const hostFile = path.join(repo, "fleets", "lab", "hosts", "alpha", "host.ts");
      const original = await fs.readTextFile(hostFile);
      const pin = (text: string) =>
        original.replace('spec: "004-install",', `spec: "004-install",\n  enginePin: ${text},`);
      // Refused: the tag is not the engine's spelling, and there is no reason; nothing is built.
      await fs.writeTextFile(
        hostFile,
        pin(`{ tag: "v0.150.0" as never, reason: "", until: "soon" }`),
      );
      let r = await stolos(["build"]);
      assertEquals(r.code === 0, false, r.out);
      assertStringIncludes(r.out, "hosts/alpha.enginePin");
      assertStringIncludes(r.out, "is not an engine tag");
      assertStringIncludes(r.out, "needs a reason");
      assertStringIncludes(r.out, "is not a date");
      // A sound hold builds; the PC says it, and says it is not enforced.
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      await fs.writeTextFile(
        hostFile,
        pin(`{ tag: "stolos-v0.150.0", reason: "a pilot", until: "${until}" }`),
      );
      r = await stolos(["build"]);
      assertEquals(r.code, 0, r.out);
      // The engine's repository is a real Git repository holding the tag; the fleet pins it by a git+file URL.
      const engine = path.join(sb.home, "engine-repo");
      await engineRepo(sh, engine);
      await sh(engine, "git", "tag", "stolos-v0.150.0");
      await fs.writeTextFile(
        path.join(repo, "package.json"),
        JSON.stringify({
          dependencies: {
            "@intellectual-frontiers/stolos": `git+${path.toFileUrl(engine).href}#stolos-v${VERSION}`,
          },
        }) + "\n",
      );
      r = await stolos(["compat", "--json"]);
      let rep = JSON.parse(jsonIn(r.out)) as {
        pc: { pin?: string };
        machines: Array<{
          name: string;
          hold?: { tag: string; exists?: string; source: string };
          holdWords?: string;
        }>;
      };
      assertEquals(rep.pc.pin, `stolos-v${VERSION}`);
      const a = rep.machines.find((m) => m.name === "alpha");
      assertEquals(a?.hold?.tag, "stolos-v0.150.0");
      assertEquals(a?.hold?.exists, "exists");
      assertEquals(a?.hold?.source, "host");
      assertStringIncludes(
        a?.holdWords ?? "",
        `held at stolos-v0.150.0 (fleet pin stolos-v${VERSION})`,
      );
      assertStringIncludes(a?.holdWords ?? "", "not enforced on the machine yet");
      // A hold on a tag that does not exist is a problem of the report, with exit 1.
      await fs.writeTextFile(
        hostFile,
        pin(`{ tag: "stolos-v9.9.9", reason: "a pilot", until: "${until}" }`),
      );
      r = await stolos(["compat"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "stolos-v9.9.9, which is not a tag of the engine's repository");
      // A group's hold, by tags (the lab's alpha is in env:lab by rule).
      await fs.writeTextFile(hostFile, original);
      const fleetFile = path.join(repo, "fleets", "lab", "fleet.ts");
      const fleetText = await fs.readTextFile(fleetFile);
      await fs.writeTextFile(
        fleetFile,
        fleetText.replace(
          "  admin: {",
          `  engineHolds: [{ select: "env:lab", tag: "stolos-v0.150.0", reason: "lab first", until: "${until}" }],\n  admin: {`,
        ),
      );
      r = await stolos(["build"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["compat", "--json"]);
      rep = JSON.parse(jsonIn(r.out)) as typeof rep;
      const held = rep.machines.filter((m) => m.hold?.source === "group").map((m) => m.name);
      assert(held.length >= 1, `a group hold reaches a machine: ${r.out}`);
      // A group's expression naming a tag the fleet does not define is refused at build.
      await fs.writeTextFile(
        fleetFile,
        fleetText.replace(
          "  admin: {",
          `  engineHolds: [{ select: "env:nowhere", tag: "stolos-v0.150.0", reason: "x", until: "${until}" }],\n  admin: {`,
        ),
      );
      r = await stolos(["build"]);
      assertEquals(r.code === 0, false, r.out);
      assertStringIncludes(r.out, "engineHolds[0]");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script", timeout: 180_000 },
);

proves(
  [
    "115-compatibility FR-004",
    "115-compatibility FR-006",
    "115-compatibility FR-009",
    "115-compatibility FR-010",
  ],
  "115: host observe reads an adopted machine's probe (the real script), keeps its facts version in the PC's cache with no commit, host check says it speaks this PC's contract, and an old probe is still read",
  async () => {
    const l = await lab();
    try {
      const { stolos, sh, repo, sb, probeRoot } = l;
      const dir = path.join(repo, "fleets", "lab", "adopted", "laptop");
      await fs.ensureDir(dir);
      await fs.writeTextFile(
        path.join(dir, "machine.ts"),
        machineSource({
          name: "laptop",
          owner: "alice",
          ssh: { user: "alice", address: "10.0.1.9" },
          hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexample"],
          adopted: AT,
          joined: "integrated",
        }),
      );
      const key = path.join(sb.home, "config", "stolos", "secrets", "lab", "adopted", "laptop");
      await fs.ensureDir(key);
      await fs.writeTextFile(
        path.join(key, "probe_key"),
        "not a key: the stand-in ssh ignores it\n",
      );
      assert(probeRoot.length > 0);
      let r = await stolos(["host", "observe", "laptop"]);
      assertEquals(r.code, 0, r.out);
      const changed = (
        await sh(repo, "git", "status", "--porcelain", "--untracked-files=all")
      ).split("\n");
      assert(
        changed.every((x) => x.includes("adopted/laptop/")),
        changed.join("\n"),
      );
      r = await stolos(["compat", "--json"]);
      assertEquals(r.code, 0, r.out);
      const rep = JSON.parse(jsonIn(r.out)) as {
        machines: Array<{
          name: string;
          kind: string;
          status: string;
          seams: Array<{ seam: string; machine?: string }>;
        }>;
      };
      const laptop = rep.machines.find((m) => m.name === "laptop");
      assertEquals(laptop?.kind, "adopted");
      assertEquals(laptop?.status, "compatible");
      assertEquals(
        laptop?.seams.map((s) => `${s.seam} ${s.machine}`),
        [`probe-facts ${SEAMS["probe-facts"].current}`],
      );
      r = await stolos(["host", "check", "laptop", "--json"]);
      const from = r.out.search(/^\[$/m);
      const to = r.out.indexOf("\n]", from);
      const checks = JSON.parse(r.out.slice(from, to + 2)) as Array<{
        results: Array<{ id: string; status: string; scf: string[] }>;
      }>;
      const mine = checks[0]?.results.find((x) => x.id === "speaks-contract");
      assertEquals(mine?.status, "pass");
      assertEquals(mine?.scf, ["CHG-03", "CFG-04"]);
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script", timeout: 180_000 },
);
