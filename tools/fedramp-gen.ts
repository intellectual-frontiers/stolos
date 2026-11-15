/**
 * `bun run fedramp` (spec 076): the FedRAMP 20x Key Security Indicators (KSI), and the rules that
 * say which apply to Class A and Class B and how often, as TypeScript, generated from FedRAMP's own
 * machine-readable Consolidated Rules (vendor/fedramp/<release>/, pinned by commit and SHA-256).
 * Nothing is typed by hand: a KSI added, renamed, or moved to another class by FedRAMP reaches
 * Stolos by vendoring the new release and running this again. The module is formatted by
 * `bun fmt`, so this tool runs on Bun.
 *
 * ```sh
 * bun run fedramp            # check the SHA-256, write src/archon/fedramp/rules.auto.ts
 * bun run fedramp --check    # fail when the generated module differs from what is written
 * ```
 *
 * @module
 */
import { sha256 } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path, proc, stdio } from "@intellectual-frontiers/ifc-ts/runtime";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const say = (line: string): void => {
  stdio.stderr.writeSync(`${line}\n`);
};

const RELEASE = "2026.11.02.01";
const COMMIT = "64fa769510416fa75fd00a4689466094265b8083";
const SHA256 = "782faecae3eee4aa2aa9d32cdb0de4c929524f2e41dc1f3d143a94a9ca64c4e3";
const SDR_SCHEMA =
  "https://fedramp.gov/schemas/fedramp-security-decision-record-schema-2026-06-24.json";
const SRC = path.join(ROOT, `vendor/fedramp/${RELEASE}/fedramp-consolidated-rules.json`);
const OUT = path.join(ROOT, "src/archon/fedramp/rules.auto.ts");

interface Variant {
  statement?: string;
  force?: string;
  timeframe_type?: string;
  timeframe_num?: number;
  following_information?: string[];
}
interface Entry extends Variant {
  name: string;
  controls?: string[];
  varies_by_class?: Record<string, Variant>;
  related?: string[];
}
interface Rules {
  info: { title: string; version: string; last_updated: string };
  KSI: Record<
    string,
    {
      id: string;
      name: string;
      short_name: string;
      status: string;
      indicators: Record<string, Entry>;
    }
  >;
  FRR: Record<string, { data: Record<string, Record<string, Record<string, Entry>>> }>;
}

const bytes = await fs.readFile(SRC);
const got = await sha256(bytes);
if (got !== SHA256) {
  say(`${SRC}: SHA-256 ${got}, expected ${SHA256}: not the pinned release`);
  proc.exit(1);
}
// FedRAMP's own file, pinned by its SHA-256 above.
const rules = JSON.parse(new TextDecoder().decode(bytes)) as Rules;
if (rules.info.version !== RELEASE) {
  say(`the rules say version ${rules.info.version}, expected ${RELEASE}`);
  proc.exit(1);
}

/** A rule (FRR) by its id, wherever it is in the tree. */
function rule(id: string): Entry {
  for (const p of Object.values(rules.FRR)) {
    for (const bucket of Object.values(p.data)) {
      for (const subset of Object.values(bucket)) if (subset[id]) return subset[id];
    }
  }
  throw new Error(`no rule ${id} in the Consolidated Rules ${RELEASE}`);
}
/** A rule's text for a class (a or b): its class variant, or the rule itself. */
function forClass(id: string, cls: "a" | "b") {
  const r = rule(id);
  const v = r.varies_by_class?.[cls] ?? r;
  if (!v.statement) throw new Error(`${id} has no statement for class ${cls}`);
  return {
    rule: id,
    name: r.name,
    statement: v.statement,
    force: v.force ?? "",
    ...(v.timeframe_type ? { every: { unit: v.timeframe_type, count: v.timeframe_num ?? 0 } } : {}),
    ...(v.following_information ? { items: v.following_information } : {}),
  };
}

/** Plain JSDoc text: no comment terminators, no tags, no Markdown emphasis. */
const doc = (s: string) =>
  s.replace(/\*\//g, "* /").replace(/@/g, "(at)").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

const themes = Object.values(rules.KSI).map((t) => ({
  id: t.short_name,
  name: t.name,
  status: t.status,
}));
const ksis = Object.values(rules.KSI).flatMap((t) =>
  Object.entries(t.indicators).map(([id, k]) => {
    const a = k.varies_by_class?.["a"]?.statement ?? k.statement;
    const b = k.varies_by_class?.["b"]?.statement ?? k.statement;
    return {
      id,
      theme: t.short_name,
      name: k.name,
      statement: k.statement ?? k.varies_by_class?.["c"]?.statement ?? b ?? "",
      classes: {
        ...(a ? { A: a } : {}),
        ...(b ? { B: b } : {}),
      },
      optionalIn: [
        ...(a?.startsWith("**Optional:**") ? ["A"] : []),
        ...(b?.startsWith("**Optional:**") ? ["B"] : []),
      ],
      controls: k.controls ?? [],
    };
  }),
);
const mfr = rule("FRC-CLA-MFR");
const classA = (mfr.following_information ?? [])
  .map((l) => l.match(/^Key Security Indicators: (KSI-[A-Z]{3}-[A-Z]{3})\b/)?.[1])
  .filter((x): x is string => !!x);
for (const id of classA) {
  if (!ksis.some((k) => k.id === id)) throw new Error(`FRC-CLA-MFR names ${id}, not a KSI`);
  if (!mfr.related?.includes(id)) throw new Error(`FRC-CLA-MFR lists ${id} but not as related`);
}
const minMethods = (s: string) => Number(s.match(/at least (\d+) automated method/)?.[1] ?? 0);
const cadence = (cls: "a" | "b") => {
  const vvk = forClass("FRC-CSX-VVK", cls);
  return {
    automation: { ...vvk, minMethods: minMethods(vvk.statement) },
    machineValidation: forClass("VDR-TFR-MVX", cls),
    packageMaintenance: forClass("CPO-CSX-CPM", cls),
    metrics: forClass("SDR-CSX-KMT", cls),
    documentation: forClass("SDR-CSX-KSI", cls),
  };
};

const j = (x: unknown) => JSON.stringify(x, null, 2);
const out = [
  "/**",
  " * Spec 076: FedRAMP 20x's Key Security Indicators (KSI), each with the NIST SP 800-53",
  " * controls FedRAMP maps it to, which apply to Class A and Class B, and the cadences the",
  " * rules set for each class, all from FedRAMP's own Consolidated Rules for 2026.",
  " *",
  ` * GENERATED by \`bun run fedramp\` (tools/fedramp-gen.ts) from FedRAMP/rules ${RELEASE}`,
  ` * (commit ${COMMIT}, SHA-256 ${SHA256}), vendored in`,
  ` * vendor/fedramp/${RELEASE}/. A work of the United States Government. Never edit by hand.`,
  " *",
  " * @module",
  " */",
  "",
  "/** The FedRAMP rules release these are from, and where it is. */",
  `export const FEDRAMP_RULES = ${j({
    title: rules.info.title,
    version: rules.info.version,
    lastUpdated: rules.info.last_updated,
    repository: "https://github.com/FedRAMP/rules",
    commit: COMMIT,
    url: `https://raw.githubusercontent.com/FedRAMP/rules/${COMMIT}/fedramp-consolidated-rules.json`,
    sha256: SHA256,
    sdrSchema: SDR_SCHEMA,
  })} as const;`,
  "",
  "/** A FedRAMP 20x certification class Stolos writes a package for. */",
  'export type FedrampClass = "A" | "B";',
  "",
  "/** A KSI theme (FedRAMP's grouping). */",
  "export interface KsiTheme {",
  "  /** Its short name (CED, IAM, ...). */",
  "  id: string;",
  "  /** Its name. */",
  "  name: string;",
  "  /** FedRAMP's status for it (stable, placeholder, empty). */",
  "  status: string;",
  "}",
  "",
  "/** The KSI themes. */",
  `export const KSI_THEMES: readonly KsiTheme[] = ${j(themes)};`,
  "",
  "/** Every KSI id. */",
  `export type KsiId =\n${ksis.map((k) => `  | ${JSON.stringify(k.id)}`).join("\n")};`,
  "",
  "/** One Key Security Indicator, as FedRAMP writes it. */",
  "export interface Ksi {",
  "  /** Its id (KSI-THEME-KEY). */",
  "  id: KsiId;",
  "  /** Its theme's short name. */",
  "  theme: string;",
  "  /** Its name. */",
  "  name: string;",
  "  /** What it asks, in FedRAMP's words (the strictest class's, when it varies). */",
  "  statement: string;",
  "  /** What it asks of each class, when it applies to that class (Markdown, FedRAMP's). */",
  "  classes: Partial<Record<FedrampClass, string>>;",
  '  /** The classes for which FedRAMP marks it "Optional". */',
  "  optionalIn: readonly FedrampClass[];",
  "  /** The NIST SP 800-53 Rev 5 controls FedRAMP maps it to (OSCAL ids: ac-2.1). */",
  "  controls: readonly string[];",
  "}",
  "",
  "/** Every KSI, in FedRAMP's order. */",
  "export const KSIS: readonly Ksi[] = [",
  ...ksis.map(
    (k) =>
      `  /** ${k.id} ${doc(k.name)}: ${doc(k.statement)} */\n  ${j(k).replace(/\n/g, "\n  ")},`,
  ),
  "];",
  "",
  "/** The KSIs a Class A package must address (FRC-CLA-MFR, Mandatory FedRAMP Rules for Class A). */",
  `export const CLASS_A_KSIS: readonly KsiId[] = ${j(classA)};`,
  "",
  "/** A rule's requirement for one class. */",
  "export interface ClassRule {",
  "  /** The rule's id (FRC-CSX-VVK). */",
  "  rule: string;",
  "  /** Its name. */",
  "  name: string;",
  "  /** What it says for this class. */",
  "  statement: string;",
  "  /** MUST, SHOULD, or MAY. */",
  "  force: string;",
  "  /** How often, when the rule sets a cadence. */",
  "  every?: { unit: string; count: number };",
  "  /** What it lists, when it lists something. */",
  "  items?: readonly string[];",
  "}",
  "",
  "/** What the rules ask of each class's package, and how often. */",
  "export interface ClassCadence {",
  "  /** FRC-CSX-VVK: automated validation of each KSI, with the minimum number of methods. */",
  "  automation: ClassRule & { minMethods: number };",
  "  /** VDR-TFR-MVX: how often machine-based resources are verified and validated. */",
  "  machineValidation: ClassRule;",
  "  /** CPO-CSX-CPM: how often the certification package is brought up to date. */",
  "  packageMaintenance: ClassRule;",
  "  /** SDR-CSX-KMT: historical metrics in the Security Decision Record. */",
  "  metrics: ClassRule;",
  "  /** SDR-CSX-KSI: what the Security Decision Record says for each KSI. */",
  "  documentation: ClassRule;",
  "}",
  "",
  "/** The cadences and expectations for Class A and Class B, from the rules. */",
  `export const CLASS_RULES: Record<FedrampClass, ClassCadence> = ${j({
    A: cadence("a"),
    B: cadence("b"),
  })};`,
  "",
].join("\n");

/** The module as `bun fmt` writes it (the engine's bunfig.toml: width 100). */
async function formatted(text: string): Promise<string> {
  const bun = proc.runtimeName() === "bun" ? proc.execPath() : "bun";
  return fs.withTempDir(
    async (dir) => {
      const file = path.join(dir, "rules.auto.ts");
      await fs.writeTextFile(file, text);
      const r = await proc.output([bun, "fmt", file], { cwd: ROOT, stdin: "null" });
      if (r.code !== 0) throw new Error("bun fmt refused the generated module");
      return fs.readTextFile(file);
    },
    { prefix: "stolos-fedramp-" },
  );
}
const text = await formatted(out);

if (proc.args.includes("--check")) {
  const old = (await fs.readTextOr(OUT)) ?? "";
  if (old !== text) {
    say(`${OUT} is stale: bun run fedramp`);
    proc.exit(1);
  }
  say(`FedRAMP ${RELEASE}: unchanged`);
} else {
  await fs.writeTextFile(OUT, text);
  say(
    `FedRAMP ${RELEASE}: ${ksis.length} KSIs in ${themes.length} themes; Class A: ${classA.length}`,
  );
}
