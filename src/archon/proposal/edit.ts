/**
 * Spec 095-proposals: turning an accepted proposal into a model change. The
 * structured edits become one `adopted({...})` in the host's `capabilities`
 * (bare keys, written by `tsLiteral`), with its import. Before anything is
 * written, each edit is compared with the model as it is now: what the model
 * already does is left out, and what the model does otherwise (a unit it
 * sets, a file it writes) is a **conflict**, named with the spec that owns
 * it, never guessed at.
 *
 * ```mermaid
 * flowchart TD
 *   p["accepted proposal: structured edits"] --> c{"compared with the model now"}
 *   c -->|"already so"| skip["left out (named)"]
 *   c -->|"the model says otherwise"| conflict["a conflict: named, nothing written<br/>(--skip it, or change that capability by hand)"]
 *   c -->|new| add["adopted({...}) in host.ts<br/>+ a draft spec + the decision"]
 *   add --> build["stolos build, then you run stolos apply"]
 * ```
 *
 * @module
 */

import { tsLiteral } from "../core/ts-literal.ts";
import type { AdoptedDef } from "../capabilities/adopted.ts";
import type { HostPlan, SpecId } from "../model/types.ts";
import { type Edit, editText, type Proposal, type ProposalItem } from "./types.ts";

/** One edit compared with the model now. */
export interface EditCheck {
  /** The item it belongs to. */
  key: string;
  /** The edit. */
  edit: Edit;
  /** new: to add; already: the model does it; conflict: the model says otherwise. */
  status: "new" | "already" | "conflict";
  /** Why, for already and conflict. */
  why?: string;
}

/** Compare each adopt item's edits with the plan as it is now. */
export function checkEdits(plan: HostPlan, items: ProposalItem[]): EditCheck[] {
  const out: EditCheck[] = [];
  for (const it of items.filter((i) => i.action === "adopt")) {
    for (const e of it.edits) {
      const c = (status: EditCheck["status"], why?: string) =>
        out.push({ key: it.key, edit: e, status, ...(why ? { why } : {}) });
      switch (e.op) {
        case "packages.add": {
          const src = e.source ?? "apt";
          const p = plan.packages.find((x) => x.name === e.name && (x.source ?? "apt") === src);
          if (p) c("already", `the model installs ${e.name} (spec ${p.spec})`);
          else c("new");
          break;
        }
        case "units.enable":
        case "units.disable":
        case "units.mask": {
          const want = e.op === "units.enable"
            ? "enabled"
            : e.op === "units.disable"
            ? "disabled"
            : "masked";
          const u = plan.units.find((x) => x.unitName === e.unit);
          if (!u) c("new");
          else if (u.state === want) c("already", `the model already sets ${e.unit} ${want}`);
          else {
            c(
              "conflict",
              `the model sets ${e.unit} ${u.state} (spec ${u.spec}); the proposal wants it ${want}: change it in that spec's capability by hand, or --skip ${it.key}`,
            );
          }
          break;
        }
        case "ports.open": {
          const p = plan.ports.find((x) => x.port === e.port && x.protocol === e.protocol);
          if (p) c("already", `the model opens ${e.protocol}/${e.port} (spec ${p.spec})`);
          else c("new");
          break;
        }
        case "files.override": {
          const f = plan.files.find((x) => x.path === e.path);
          if (!f) c("new");
          else if (f.content === e.content) {
            c("already", `the model writes ${e.path} with this content`);
          } else {
            c(
              "conflict",
              `the model writes ${e.path} (spec ${f.spec}): change it in that spec's capability by hand, or --skip ${it.key}`,
            );
          }
          break;
        }
      }
    }
  }
  return out;
}

/** The adopted() definition for the new edits. */
export function adoptedDef(proposal: string, spec: SpecId, edits: Edit[]): AdoptedDef {
  const packages: string[] = [], snaps: string[] = [];
  const enable: string[] = [], disable: string[] = [], mask: string[] = [];
  const ports: NonNullable<AdoptedDef["ports"]> = [];
  const files: NonNullable<AdoptedDef["files"]> = [];
  for (const e of edits) {
    if (e.op === "packages.add") (e.source === "snap" ? snaps : packages).push(e.name);
    else if (e.op === "units.enable") enable.push(e.unit);
    else if (e.op === "units.disable") disable.push(e.unit);
    else if (e.op === "units.mask") mask.push(e.unit);
    else if (e.op === "ports.open") ports.push({ port: e.port, protocol: e.protocol });
    else if (e.op === "files.override") {
      files.push({
        path: e.path,
        content: e.content,
        mode: e.mode,
        owner: e.owner,
        ...(e.group ? { group: e.group } : {}),
      });
    }
  }
  const some = <T>(k: string, v: T[]) => (v.length ? { [k]: v } : {});
  return {
    proposal,
    spec,
    ...some("packages", packages),
    ...some("snaps", snaps),
    ...some("enable", enable),
    ...some("disable", disable),
    ...some("mask", mask),
    ...some("ports", ports),
    ...some("files", files),
  };
}

/** Where the matching `]` of the `[` at `open` is (strings and comments skipped), or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") depth++;
    if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) return c === "]" ? i : -1;
    }
  }
  return -1;
}

/**
 * host.ts with `adopted({...})` added to its `capabilities` and its import, or
 * the reason it cannot be edited safely. `capabilities: foundation(),` becomes
 * a list that spreads it; an existing list gets one more entry.
 */
export function addAdopted(
  source: string,
  d: AdoptedDef,
  comment: string,
): { text: string } | { problem: string } {
  const call = `    // ${comment}\n    adopted(${tsLiteral(d, 2)}),\n`;
  let text: string;
  const simple = /^(\s*)capabilities:\s*foundation\(\),\s*$/m.exec(source);
  if (simple) {
    text = source.slice(0, simple.index) +
      `${simple[1]}capabilities: [\n    ...foundation(),\n${call}  ],` +
      source.slice(simple.index + simple[0].length);
  } else {
    const m = /^\s*capabilities:\s*\[/m.exec(source);
    if (!m) {
      return {
        problem:
          "host.ts has no `capabilities: foundation(),` or `capabilities: [...]` to add to: add the adopted({...}) shown by stolos proposal show by hand",
      };
    }
    const open = m.index + m[0].length - 1;
    const end = closing(source, open);
    if (end < 0) return { problem: "host.ts's capabilities list could not be read" };
    let before = source.slice(0, end).replace(/\s*$/, "");
    if (!before.endsWith(",") && !before.endsWith("[")) before += ",";
    text = `${before}\n${call}  ` + source.slice(end);
  }
  return { text: withImport(text) };
}

/** Add `adopted` to the import from the engine's capabilities (or a new import). */
function withImport(text: string): string {
  if (/\badopted\b[^(]*\bfrom\s+"[^"]*capabilities\/(mod|adopted)\.ts"/.test(text)) return text;
  const m = /import\s*\{([^}]*)\}\s*from\s*"([^"]*capabilities\/mod\.ts)";/.exec(text);
  if (m) {
    const names = [...new Set([...m[1].split(",").map((s) => s.trim()).filter(Boolean), "adopted"])]
      .sort((a, b) => a.localeCompare(b));
    return text.slice(0, m.index) + `import { ${names.join(", ")} } from "${m[2]}";` +
      text.slice(m.index + m[0].length);
  }
  const imports = [...text.matchAll(/^import .*;$/gm)];
  const at = imports.length
    ? imports[imports.length - 1].index! + imports[imports.length - 1][0].length
    : 0;
  return text.slice(0, at) + `\nimport { adopted } from "@stolos/archon/capabilities/mod.ts";` +
    text.slice(at);
}

/** A unified-looking diff of two texts: the changed middle, with a little context. */
export function lineDiff(a: string, b: string, context = 2): string {
  const x = a.split("\n"), y = b.split("\n");
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  if (s === x.length && s === y.length) return "";
  const out = [`@@ line ${s + 1} @@`];
  for (let i = Math.max(0, s - context); i < s; i++) out.push(`  ${x[i]}`);
  for (let i = s; i < x.length - e; i++) out.push(`- ${x[i]}`);
  for (let i = s; i < y.length - e; i++) out.push(`+ ${y[i]}`);
  for (let i = y.length - e; i < Math.min(y.length, y.length - e + context); i++) {
    out.push(`  ${y[i]}`);
  }
  return out.join("\n");
}

/** The next free spec number in a specs folder (names start with three digits). */
export function nextSpecNumber(names: string[]): number {
  return Math.max(0, ...names.map((n) => Number(/^(\d{3})-/.exec(n)?.[1] ?? 0))) + 1;
}

/** A spec id from its number, the host, and the reason: `096-alpha-nginx-for-the-app`. */
export function specId(n: number, host: string, reason: string): SpecId {
  const words = reason.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
    .slice(0, 5).join("-");
  return `${String(n).padStart(3, "0")}-${host}-${words || "adopted"}`.slice(0, 48).replace(
    /-+$/,
    "",
  ) as SpecId;
}

/** The draft spec an acceptance writes: why (the reason), what (each edit), what stays local or by hand, and the evidence. */
export function draftSpec(
  p: Proposal,
  spec: SpecId,
  checks: EditCheck[],
  accepted: { by: string; at: string },
  skipped: string[] = [],
): string {
  const n = spec.slice(0, 3);
  const newOnes = checks.filter((c) => c.status === "new");
  const already = checks.filter((c) => c.status === "already");
  const local = p.items.filter((i) => i.action === "local");
  const revert = p.items.filter((i) => i.action === "revert");
  const byHand = p.items.filter((i) =>
    i.action === "adopt" && i.manual && !skipped.includes(i.key)
  );
  const obs = new Map(p.observations.map((o) => [o.id, o]));
  const lines = [
    `# ${n}: ${p.reason} (${p.host})`,
    "",
    `Draft written by \`stolos proposal accept\` (spec 095) from proposal \`${p.id}\`, accepted by ${accepted.by} on ${
      accepted.at.slice(0, 10)
    }. Review it, edit it, then \`stolos apply\`.`,
    "",
    "## Why",
    "",
    p.reason,
    "",
    `Proposed by ${p.by} on ${p.host} at ${
      p.at.slice(0, 16).replace("T", " ")
    } UTC, from model commit \`${p.base.slice(0, 12) || "unknown"}\`.`,
    "",
    "## Requirements",
    "",
    ...(newOnes.length
      ? newOnes.map((c, i) =>
        `- **FR-${String(i + 1).padStart(3, "0")}** ${p.host}: \`${editText(c.edit)}\` (${c.key})`
      )
      : ["- Nothing new for the model (see below)."]),
    "",
  ];
  if (already.length) {
    lines.push(
      "Already in the model:",
      "",
      ...already.map((c) => `- \`${editText(c.edit)}\`: ${c.why}`),
      "",
    );
  }
  if (local.length) {
    lines.push(
      "## Kept local",
      "",
      ...local.map((i) => `- ${i.key}, until ${i.until ?? "(no date)"}`),
      "",
    );
  }
  if (revert.length) {
    lines.push(
      "## Reverted",
      "",
      ...revert.map((i) => `- ${i.key}: ${i.manual ?? "Stolos converges it back"}`),
      "",
    );
  }
  if (byHand.length || skipped.length) {
    lines.push(
      "## By hand",
      "",
      ...byHand.map((i) => `- ${i.key}: ${i.manual}`),
      ...skipped.map((k) =>
        `- ${k}: skipped at acceptance (a conflict with the model); still flagged on the host`
      ),
      "",
    );
  }
  const flags = p.items.filter((i) => i.flag);
  if (flags.length) {
    lines.push(
      "## Constitution flags",
      "",
      ...flags.map((i) => `- ${i.key}: ${i.flag}`),
      "",
    );
  }
  lines.push("## Evidence", "");
  for (const it of p.items) {
    lines.push(
      `- ${it.key} (${it.change}${it.who ? ` by ${it.who}` : ""}, ${
        it.at.slice(0, 16).replace("T", " ")
      } UTC)`,
    );
    for (const id of it.evidence.slice(0, 5)) {
      const o = obs.get(id);
      if (o) lines.push(`  - ${o.source}: ${o.what}`);
    }
  }
  return lines.join("\n") + "\n";
}
