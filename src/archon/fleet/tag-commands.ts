/**
 * Spec 108-tags: `stolos tag add | remove | list`, on the controller PC. A change to a machine's tags is a change to the fleet
 * repository, in the machine's own file (`decisions.ts` of a managed host, `machine.ts` of an adopted machine), and it is sent the
 * way every change is: one signed commit through `stolos apply` (`--no-apply` leaves it for the next apply). Tags are defined by
 * editing `fleets/<fleet>/tags.ts` in the spec loop, so there is no command that defines one: `tag list` says where.
 *
 * ```mermaid
 * flowchart LR
 *   add["stolos tag add alpha env:prod pilot"] --> check["tags.ts defines it?<br/>a lookalike of a defined tag?"]
 *   check --> write["decisions.ts or machine.ts"]
 *   write --> apply["stolos apply: one signed commit, push"]
 * ```
 *
 * @module
 */
// Spec: 108-tags FR-006, FR-007, FR-015

import { stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import {
  addAssigned,
  classifyTag,
  type ResolvedTag,
  removeAssigned,
  tokensOf,
} from "../model/tags.ts";
import {
  chosen,
  loadFleetTags,
  originWords,
  selectionFromArgs,
  selectionText,
  tagRecord,
  taggingView,
  type TagMachine,
  tagWord,
  writeAssignment,
} from "./tags.ts";
import { porcelainPath } from "./records.ts";

/** What a command is given besides the machine: where the change is sent. */
export interface TagChangeOptions {
  /** The machine. */
  machine: string;
  /** The tags (`env:prod`, or a free-form word): a list, or the command line's values joined by newlines or commas. */
  tags: string | readonly string[];
  /** Read every word as a free-form tag (a word that is also a dimension's or a tag's own name). */
  custom?: boolean;
  /** Write the change, but do not send it (`stolos apply` sends it later). */
  noApply?: boolean;
  /** Replaces the commit's message. */
  message?: string;
}

/** What a change needs from outside (a test passes its own apply). */
export interface TagChangeDeps {
  /** Sends the change: `stolos apply` with the message. */
  apply?: (message: string) => Promise<number>;
}

/** The tags given, as words. */
const wordsOf = (t: string | readonly string[]): string[] =>
  typeof t === "string" ? tokensOf(t) : t.flatMap((x) => tokensOf(x));

const fail = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** The uncommitted files other than the ones this change writes (a tag commit holds the tag change only). */
async function otherChanges(file: string): Promise<string[]> {
  const rel = file.slice(P.repo.length + 1).replace(/\\/g, "/");
  return (await run(["git", "-C", P.repo, "status", "--porcelain", "--untracked-files=all"])).stdout
    .split("\n")
    .filter(Boolean)
    .map(porcelainPath)
    .filter((f) => f !== rel);
}

/** Find the machine, or say which exist. */
async function findMachine(
  c: ReturnType<typeof ui.phase>,
  name: string,
): Promise<{ ft: Awaited<ReturnType<typeof loadFleetTags>>; machine: TagMachine } | undefined> {
  const ft = await loadFleetTags();
  if (ft.error) {
    c.fail(ft.error, `fix ${P.fleetId ? `fleets/${P.fleetId}/` : ""}tags.ts, then run this again`);
    return undefined;
  }
  const machine = ft.machines.find((m) => m.name === name);
  if (!machine) {
    c.fail(
      `no machine named ${name} in this fleet`,
      ft.machines.length
        ? `one of: ${ft.machines.map((m) => m.name).join(", ")}`
        : "add one first (stolos host add, stolos pair)",
    );
    return undefined;
  }
  return { ft, machine };
}

/** Send what was written: one signed commit through `stolos apply`, unless `--no-apply`. */
async function send(o: TagChangeOptions, deps: TagChangeDeps, message: string): Promise<number> {
  const text = o.message ?? message;
  if (o.noApply) {
    ui.next.push(`send it: bun run stolos apply -m ${JSON.stringify(text)}`);
    return fail();
  }
  const apply =
    deps.apply ?? (async (m: string) => (await import("./apply.ts")).fleetApply({ message: m }));
  return (await apply(text)) || fail();
}

/** `stolos tag add <machine> <tag...>` (spec 108-tags FR-006): give a machine tags, and send the change. */
export async function tagAdd(opts: TagChangeOptions, deps: TagChangeDeps = {}): Promise<number> {
  const o = { ...opts, tags: wordsOf(opts.tags) };
  const c = ui.phase("Tags");
  if (!o.tags.length) {
    c.fail(
      "no tag given",
      "stolos tag add <machine> env:prod pilot (stolos tag list shows the tags)",
    );
    return fail();
  }
  const found = await findMachine(c, o.machine);
  if (!found) return fail();
  const { ft, machine } = found;
  const tokens = o.tags.map((t) => classifyTag(ft.set, t, o.custom));
  const bad = tokens.flatMap((t) => (t.kind === "bad" ? [t] : []));
  if (bad.length) {
    for (const b of bad) c.fail(b.why, b.fix);
    return fail();
  }
  const { assigned, replaced } = addAssigned(
    ft.set ?? { dimensions: {} },
    machine.assigned,
    tokens,
  );
  const same =
    assigned.tags.join() === machine.assigned.tags.join() &&
    assigned.customTags.join() === machine.assigned.customTags.join();
  if (same) {
    c.done(`${machine.name} already holds ${o.tags.join(", ")}: nothing to change`);
    return 0;
  }
  if (!o.noApply) {
    const others = await otherChanges(machine.home.file);
    if (others.length) {
      c.fail(
        `uncommitted changes (${others.slice(0, 3).join(", ")}${others.length > 3 ? ", ..." : ""}): a tag commit holds the tag change only`,
        "bun run stolos apply (or set them aside), then run this again; or --no-apply to write it now and send it later",
      );
      return fail();
    }
  }
  await writeAssignment(machine, assigned);
  for (const r of replaced)
    c.note(`${r.by} replaces ${r.was} (a machine holds one value of this dimension)`);
  const what = tokens.map((t) => (t.kind === "custom" ? `${t.id} (custom)` : t.id)).join(", ");
  c.done(
    `${machine.name}: ${what} written to ${machine.home.file.slice(P.repo.length + 1).replace(/\\/g, "/")}`,
  );
  return await send(o, deps, `108-tags: tag ${machine.name} ${tokens.map((t) => t.id).join(" ")}`);
}

/** `stolos tag remove <machine> <tag...>` (spec 108-tags FR-006): take tags a person gave off a machine, and send the change. */
export async function tagRemove(opts: TagChangeOptions, deps: TagChangeDeps = {}): Promise<number> {
  const o = { ...opts, tags: wordsOf(opts.tags) };
  const c = ui.phase("Tags");
  if (!o.tags.length) {
    c.fail("no tag given", "stolos tag remove <machine> env:prod pilot");
    return fail();
  }
  const found = await findMachine(c, o.machine);
  if (!found) return fail();
  const { machine } = found;
  const { assigned, missing } = removeAssigned(machine.assigned, o.tags);
  if (missing.length) {
    for (const t of missing) {
      const held = machine.resolved.tags.find((x) => x.id === t.toLowerCase());
      c.fail(
        held
          ? `${machine.name} holds ${t} from ${originWords(held)}, not from a person`
          : `${machine.name} does not hold ${t}`,
        held
          ? "change the rule or group in tags.ts, or give the machine another value of its dimension (a person's tag wins)"
          : `stolos tag list ${machine.name}`,
      );
    }
    return fail();
  }
  if (!o.noApply) {
    const others = await otherChanges(machine.home.file);
    if (others.length) {
      c.fail(
        `uncommitted changes (${others.slice(0, 3).join(", ")}): a tag commit holds the tag change only`,
        "bun run stolos apply (or set them aside), then run this again; or --no-apply",
      );
      return fail();
    }
  }
  await writeAssignment(machine, assigned);
  c.done(
    `${machine.name}: ${o.tags.join(", ")} removed from ${machine.home.file.slice(P.repo.length + 1).replace(/\\/g, "/")}`,
  );
  return await send(o, deps, `108-tags: untag ${machine.name} ${o.tags.join(" ")}`);
}

/** One machine's tags as the records `--json` and evidence carry. */
export function machineRecord(
  m: Pick<TagMachine, "name" | "kind" | "resolved">,
): Record<string, unknown> {
  return {
    machine: m.name,
    kind: m.kind,
    tags: m.resolved.tags.map(tagRecord),
    ...(m.resolved.dropped.length ? { overridden: m.resolved.dropped } : {}),
  };
}

/** `stolos tag list [<machine>] [--tag t ...] [--any-tag t ...] [--select expr]` (spec 108-tags FR-007). */
export async function tagList(
  o: {
    machine?: string;
    tag?: string;
    anyTag?: string;
    select?: string;
  },
  json = false,
): Promise<number> {
  const c = ui.phase("Tags");
  const ft = await loadFleetTags();
  if (ft.error) {
    c.fail(ft.error, "fix fleets/<fleet>/tags.ts");
    return fail();
  }
  const sel = selectionFromArgs({ tag: o.tag, "any-tag": o.anyTag, select: o.select }, ft.set);
  if (sel.error) {
    c.fail(
      sel.error,
      "for example: --tag env:prod, --any-tag role:nas --any-tag role:web, --select 'env:prod and not role:database'",
    );
    return fail();
  }
  const out = (t: string): void => {
    stdio.stdout.writeSync(`${t}\n`);
  };
  const where = `fleets/${P.fleetId}/tags.ts`;
  if (o.machine) {
    const m = ft.machines.find((x) => x.name === o.machine);
    if (!m) {
      c.fail(
        `no machine named ${o.machine} in this fleet`,
        ft.machines.length ? `one of: ${ft.machines.map((x) => x.name).join(", ")}` : "none yet",
      );
      return fail();
    }
    if (json) {
      out(JSON.stringify(machineRecord(m), null, 2));
      return 0;
    }
    c.done(`${m.name}: ${m.resolved.tags.length} tag(s)`);
    out(`\n${m.name} (${m.kind})`);
    if (!m.resolved.tags.length) out("  no tags");
    for (const t of m.resolved.tags) out(tagDetail(t));
    for (const d of m.resolved.dropped) {
      out(`  overridden: ${d.id} (${originWords(d)}) by ${d.by}`);
    }
    for (const p of m.resolved.problems) c.warn(p, `fix ${where} or the machine's tags`);
    return 0;
  }
  const machines = chosen(ft.machines, sel.selection);
  if (json) {
    out(
      JSON.stringify(
        {
          where,
          defined: ft.set !== undefined,
          selection: sel.selection ? selectionText(sel.selection) : null,
          machines: machines.map(machineRecord),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (!sel.selection) {
    const view = taggingView(
      ft.set,
      undefined,
      machines.map((m) => ({ tags: m.resolved.tags })),
    );
    if (!view.configured) {
      c.warn(
        `this fleet defines no tags: there is no ${where}`,
        "write it (a new fleet gets a starter kit), then stolos build; free-form tags work without it",
      );
    } else {
      out(
        `Defined in ${where}: edit it in the spec loop (an environment, a role, a site, an owner, a criticality, a data class are the starter kit), then stolos build.\n`,
      );
      for (const d of view.dimensions) {
        out(
          `${d.id} (${d.label}, ${d.cardinality === "one-of" ? "one of" : "many of"}): ${d.description}`,
        );
        for (const t of d.tags) {
          out(
            `  ${t.id.padEnd(22)} ${t.colour.padEnd(7)} ${String(t.count).padStart(3)}  ${t.label}: ${t.description}`,
          );
        }
      }
      out("");
    }
    if (view.custom.length) {
      out(
        `custom (free-form, never defined): ${view.custom.map((x) => `${x.id} (${x.count})`).join(", ")}\n`,
      );
    }
  } else {
    c.status(`chosen: ${selectionText(sel.selection)}`);
  }
  const { table } = await import("../state/query.ts");
  out(
    table(
      machines.map((m) => ({
        machine: m.name,
        kind: m.kind,
        tags: m.resolved.tags
          .filter((t) => t.standing !== "custom")
          .map(tagWord)
          .join(" "),
        custom: m.resolved.tags
          .filter((t) => t.standing === "custom")
          .map((t) => t.id)
          .join(" "),
      })),
    ),
  );
  c.done(
    sel.selection
      ? `${machines.length} of ${ft.machines.length} machine(s) chosen by ${selectionText(sel.selection)}`
      : `${ft.machines.length} machine(s)`,
  );
  return sel.selection && !machines.length ? 1 : 0;
}

/** One tag of `tag list <machine>`: its id, label, origin, and a mark where it is custom or not defined. */
function tagDetail(t: ResolvedTag): string {
  const mark =
    t.standing === "custom" ? "  [custom]" : t.standing === "unknown" ? "  [not defined]" : "";
  return `  ${t.id.padEnd(22)} ${t.label.padEnd(16)} ${originWords(t)}${mark}`;
}
