/**
 * Spec 083: `stolos audit ...`. The writing commands (open, bundle, access,
 * request, respond, sample, close) each make one commit, signed with Git's
 * signing key (your daily key: ssh-keygen asks its passphrase in this
 * terminal), of the engagement's files only; nothing is pushed. The reading
 * ones (list, show, export, verify, portal) change nothing.
 *
 * The work is in functions that take an {@link AuditCtx} (the repository,
 * the fleet, a committer), so the tests drive them with a real repository and
 * a real key; the commands build the context from this PC.
 *
 * @module
 */

import { sha256 as sha256Hex } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path as paths, stdio, toError } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { verifyBundle } from "../evidence/bundle.ts";
import { type AuditCase, auditIds, caseProblems, loadAudit } from "./case.ts";
import {
  type Engagement,
  ENGAGEMENT_ID,
  engagementPath,
  engagementProblems,
  engagementSource,
  engagementState,
  isDay,
  parseControls,
  parseEngagement,
} from "./engagement.ts";
import { buildPackage, verifyPackage } from "./package.ts";
import { type AuditDeps, AuditLaunch } from "./portal.ts";
import { bundleView, POPULATION_IDS, POPULATION_TITLES } from "./populations.ts";
import { drawSample, SEED } from "./sample.ts";
import {
  type Committer,
  ENTRY_FILE,
  entryFile,
  entrySource,
  gitCommitter,
  trailDir,
  type TrailEntry,
} from "./trail.ts";

/** What the audit functions work with. */
export interface AuditCtx {
  /** The fleet repository. */
  repo: string;
  /** The fleet's id. */
  fleet: string;
  /** This PC's evidence directory (bundles). */
  evidenceDir: string;
  /** The fleet's signers, as allowed_signers text. */
  allowedSigners(): Promise<string>;
  /** Who is recording (a fleet signer's name, else Git's user.name). */
  who(): Promise<string>;
  /** Makes the signed commit. */
  commit: Committer;
  /** Now. */
  now(): Date;
}

/** A result: what was done, or why not. */
export type Done =
  | { ok: true; detail: string; commit?: string }
  | {
      ok: false;
      why: string;
      fix?: string;
    };

const git = (repo: string, args: string[]) => run(["git", "-C", repo, ...args]);
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The engagement as committed (HEAD); refuses one with uncommitted changes. */
async function committedEngagement(
  ctx: AuditCtx,
  id: string,
): Promise<{ e: Engagement } | { why: string; fix?: string }> {
  if (!ENGAGEMENT_ID.test(id)) return { why: `"${id}" is not an engagement id` };
  const path = engagementPath(ctx.fleet, id);
  const shown = await git(ctx.repo, ["show", `HEAD:${path}`]);
  if (!shown.ok) return { why: `no engagement ${id}`, fix: "bun run stolos audit list" };
  const now = await fs.readTextFile(paths.join(ctx.repo, path)).catch(() => undefined);
  if (now !== undefined && now !== shown.stdout) {
    return {
      why: `${path} has uncommitted changes`,
      fix: "restore it (git restore) and change it only with stolos audit commands",
    };
  }
  try {
    return { e: parseEngagement(shown.stdout) };
  } catch (e) {
    return { why: toError(e).message };
  }
}

async function writeEngagement(ctx: AuditCtx, e: Engagement, message: string): Promise<Done> {
  const problems = engagementProblems(e);
  if (problems.length) return { ok: false, why: problems.join("; ") };
  try {
    const commit = await ctx.commit(
      { [engagementPath(ctx.fleet, e.id)]: engagementSource(e) },
      message,
    );
    return { ok: true, detail: message, commit };
  } catch (x) {
    return { ok: false, why: (x as Error).message, fix: "bun run stolos keys" };
  }
}

/** What `audit open` is given. */
export interface OpenInput {
  /** The engagement's id. */
  id: string;
  /** Its title (default: from the frameworks and the period). */
  title?: string;
  /** The audit firm. */
  firm: string;
  /** The firm's people, by name ("Name <email>" or "Name"). */
  auditors: string[];
  /** The period. */
  from: string;
  /** The period's last day. */
  to: string;
  /** The frameworks. */
  frameworks: string[];
  /** The controls: "id=population,..." (default: every population, each its own control). */
  controls?: string;
  /** The last day of access. */
  expires: string;
}

/** Open an engagement: engagement.ts, in a signed commit. */
export async function auditOpen(ctx: AuditCtx, i: OpenInput): Promise<Done> {
  if (!ENGAGEMENT_ID.test(i.id)) {
    return { ok: false, why: `"${i.id}": lowercase letters, digits, and dashes` };
  }
  const path = engagementPath(ctx.fleet, i.id);
  const there = await git(ctx.repo, ["cat-file", "-e", `HEAD:${path}`]);
  if (there.ok) return { ok: false, why: `engagement ${i.id} exists already` };
  if (isDay(i.expires) && i.expires < day(ctx.now())) {
    return { ok: false, why: `access would have ended already (${i.expires})` };
  }
  const auditors = i.auditors.map((a) => {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(a.trim());
    const [, name, email] = m ?? [];
    return name !== undefined && email !== undefined ? { name, email } : { name: a.trim() };
  });
  const e: Engagement = {
    id: i.id,
    title: i.title ?? `${i.frameworks.join(", ").toUpperCase() || "Audit"}, ${i.from} to ${i.to}`,
    firm: i.firm,
    auditors,
    period: { from: i.from, to: i.to },
    frameworks: i.frameworks,
    controls: parseControls(
      i.controls ?? POPULATION_IDS.join(","),
      POPULATION_TITLES,
      i.frameworks.length === 1 ? i.frameworks[0] : undefined,
    ),
    access: { expires: i.expires },
    opened: { on: day(ctx.now()), by: await ctx.who() },
  };
  return await writeEngagement(ctx, e, `audit ${i.id}: open (${e.firm}, ${i.from} to ${i.to})`);
}

/** Pin an evidence bundle to an engagement (copied into the evidence directory). */
export async function auditBundle(ctx: AuditCtx, id: string, file: string): Promise<Done> {
  const got = await committedEngagement(ctx, id);
  if ("why" in got) return { ok: false, ...got };
  if (got.e.closed) return { ok: false, why: `engagement ${id} is closed` };
  let zip: Uint8Array;
  try {
    zip = await fs.readFile(file);
  } catch (e) {
    return { ok: false, why: `${file}: ${toError(e).message}` };
  }
  let head: string, period: { from: string; to: string };
  try {
    const v = await bundleView(zip);
    head = v.manifest.head;
    period = v.manifest.period;
  } catch (e) {
    return { ok: false, why: `${file}: ${toError(e).message}` };
  }
  const r = await verifyBundle(zip, { allowedSigners: await ctx.allowedSigners() });
  if (!r.signer) {
    return {
      ok: false,
      why: `${file}: its manifest is not signed by a fleet signer (${r.problems.join("; ")})`,
      fix: "bun run stolos evidence export --from ... --to ...",
    };
  }
  if (period.from > got.e.period.from || period.to < got.e.period.to) {
    return {
      ok: false,
      why: `the bundle covers ${period.from} to ${period.to}, not the engagement's period (${got.e.period.from} to ${got.e.period.to})`,
      fix: `bun run stolos evidence export --from ${got.e.period.from} --to ${got.e.period.to}`,
    };
  }
  const name = file.split(/[\\/]/).pop() ?? file;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/.test(name)) {
    return { ok: false, why: `${name}: name the bundle with letters, digits, . - _ and .zip` };
  }
  const dest = paths.join(ctx.evidenceDir, name);
  const sha256 = await sha256Hex(zip);
  const there = await fs.readFile(dest).catch(() => undefined);
  if (there && (await sha256Hex(there)) !== sha256) {
    return { ok: false, why: `${dest} exists and is another bundle: rename yours` };
  }
  if (!there) {
    await fs.mkdir(ctx.evidenceDir, { recursive: true });
    await fs.writeFile(dest, zip);
  }
  const e = { ...got.e, bundle: { file: name, sha256, head } };
  const done = await writeEngagement(ctx, e, `audit ${id}: pin the evidence bundle ${name}`);
  return done.ok && r.problems.length
    ? {
        ...done,
        detail: `${done.detail} (the bundle has ${r.problems.length} problem(s) the auditor will see)`,
      }
    : done;
}

/** Change the day the auditor's access ends. */
export async function auditAccess(ctx: AuditCtx, id: string, expires: string): Promise<Done> {
  const got = await committedEngagement(ctx, id);
  if ("why" in got) return { ok: false, ...got };
  if (got.e.closed) return { ok: false, why: `engagement ${id} is closed` };
  if (!isDay(expires)) return { ok: false, why: "--expires is a day (YYYY-MM-DD)" };
  return await writeEngagement(
    ctx,
    { ...got.e, access: { expires } },
    `audit ${id}: access ends with ${expires}`,
  );
}

/** Close an engagement: the portal refuses it from now on. */
export async function auditClose(ctx: AuditCtx, id: string): Promise<Done> {
  const got = await committedEngagement(ctx, id);
  if ("why" in got) return { ok: false, ...got };
  if (got.e.closed) return { ok: false, why: `engagement ${id} was closed on ${got.e.closed.on}` };
  return await writeEngagement(
    ctx,
    { ...got.e, closed: { on: day(ctx.now()), by: await ctx.who() } },
    `audit ${id}: close`,
  );
}

/** The next entry number (from HEAD and the working tree). */
async function nextSeq(ctx: AuditCtx, id: string): Promise<number> {
  const dir = trailDir(ctx.fleet, id);
  const names = new Set<string>();
  const ls = await git(ctx.repo, ["ls-tree", "--name-only", `HEAD:${dir}`]);
  if (ls.ok) ls.stdout.split("\n").forEach((n) => names.add(n));
  try {
    for await (const f of fs.readDir(paths.join(ctx.repo, dir))) names.add(f.name);
  } catch {
    /* none yet */
  }
  let max = 0;
  for (const n of names) {
    const m = ENTRY_FILE.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Record a trail entry in a signed commit. */
export async function auditEntry(
  ctx: AuditCtx,
  id: string,
  e: Omit<TrailEntry, "seq" | "at"> & { at?: string },
): Promise<Done & { seq?: number }> {
  const got = await committedEngagement(ctx, id);
  if ("why" in got) return { ok: false, ...got };
  if (got.e.closed) return { ok: false, why: `engagement ${id} is closed` };
  if (e.control && !got.e.controls.some((c) => c.id === e.control)) {
    return {
      ok: false,
      why: `no control ${e.control} in scope (${got.e.controls.map((c) => c.id).join(", ")})`,
    };
  }
  if (!e.body.trim() && e.kind !== "sample") return { ok: false, why: "--text: say what it is" };
  const seq = await nextSeq(ctx, id);
  if (e.re !== undefined && (e.re < 1 || e.re >= seq)) {
    return { ok: false, why: `--re ${e.re}: no such entry` };
  }
  const entry: TrailEntry = {
    ...e,
    seq,
    at:
      e.at ??
      ctx
        .now()
        .toISOString()
        .replace(/\.\d+Z$/, "Z"),
  };
  const path = `${trailDir(ctx.fleet, id)}/${entryFile(entry)}`;
  const message = `audit ${id}: ${e.kind} ${seq}${e.control ? ` (${e.control})` : ""}`;
  try {
    const commit = await ctx.commit({ [path]: entrySource(entry) }, message);
    return { ok: true, detail: `${path}: ${message}`, commit, seq };
  } catch (x) {
    return { ok: false, why: (x as Error).message, fix: "bun run stolos keys" };
  }
}

/** Draw a sample from the auditor's seed and record it. */
export async function auditSample(
  ctx: AuditCtx,
  id: string,
  o: { control: string; seed: string; size: number; by?: string; note?: string },
): Promise<Done & { seq?: number; units?: string[] }> {
  if (!SEED.test(o.seed)) {
    return { ok: false, why: "--seed: one line of printable text, 1 to 256 characters" };
  }
  if (!Number.isInteger(o.size) || o.size < 1) {
    return { ok: false, why: "--size: a whole number from 1" };
  }
  const c = await loadCase(ctx, id);
  if (!c) return { ok: false, why: `no engagement ${id}` };
  const x = c.engagement.controls.find((y) => y.id === o.control);
  if (!x) return { ok: false, why: `no control ${o.control} in scope` };
  const pop = c.populations.get(x.id);
  if (!pop) {
    return {
      ok: false,
      why: c.bundleProblems.join("; ") || "no population",
      fix: `bun run stolos audit bundle ${id} <bundle.zip>`,
    };
  }
  const s = await drawSample(x.id, pop, o.seed, o.size);
  const body = `${s.units.length} of ${s.populationSize} unit(s) of ${s.population}, drawn with ${s.method} from the seed the auditor gave.${
    o.note ? `\n\n${o.note}` : ""
  }\n\n${s.units.map((u) => `- ${u}`).join("\n")}`;
  const r = await auditEntry(ctx, id, {
    kind: "sample",
    by: o.by ?? (await ctx.who()),
    control: x.id,
    sample: s,
    body,
  });
  return r.ok ? { ...r, units: s.units } : r;
}

/** An engagement from this repository, checked. */
export async function loadCase(ctx: AuditCtx, id: string): Promise<AuditCase | undefined> {
  return await loadAudit({
    repo: ctx.repo,
    fleet: ctx.fleet,
    id,
    evidenceDir: ctx.evidenceDir,
    allowedSigners: await ctx.allowedSigners(),
  });
}

/** The export package of an engagement. */
export async function auditExportZip(ctx: AuditCtx, id: string): Promise<Uint8Array | undefined> {
  const c = await loadCase(ctx, id);
  if (!c) return undefined;
  const { VERSION } = await import("../version.ts");
  return await buildPackage(c, { now: ctx.now(), version: VERSION });
}

// The command line: the context from this PC.

/** The fleet signer whose key Git signs with, else Git's user.name. */
async function whoSigns(repo: string): Promise<string> {
  const { loadSigners } = await import("../identity/signers.ts");
  const { keyPaths, pubOf } = await import("../identity/keys.ts");
  const k = (await git(repo, ["config", "user.signingkey"])).stdout.trim();
  let pub: string | undefined;
  for (const f of [k.endsWith(".pub") ? k : `${k}.pub`, `${keyPaths(k).daily}.pub`]) {
    pub = pubOf(await fs.readTextFile(f).catch(() => undefined));
    if (pub) break;
  }
  const me = (await loadSigners()).find(
    (s) => pub && s.key.trim().split(/\s+/).slice(0, 2).join(" ") === pub,
  );
  return me?.name ?? ((await git(repo, ["config", "user.name"])).stdout.trim() || "unknown");
}

/** The context on this PC: the fleet repository, its signers, your signing key. */
export async function pcAuditCtx(): Promise<AuditCtx> {
  const { P } = await import("../core/paths.ts");
  const { loadSigners, allowedSignersText } = await import("../identity/signers.ts");
  const repo = P.repo;
  return {
    repo,
    fleet: P.fleetId,
    evidenceDir: paths.join(P.state, "evidence"),
    allowedSigners: async () => allowedSignersText(await loadSigners()),
    who: () => whoSigns(repo),
    commit: gitCommitter(repo, true),
    now: () => new Date(),
  };
}

/** How long the portal reuses an engagement it read and checked. */
export const AUDIT_TTL_MS = 60_000;

/** The portal's deps on this PC: engagements from the fleet repository, read at most once a minute each. */
export async function auditDeps(ctx?: AuditCtx): Promise<AuditDeps> {
  const c = ctx ?? (await pcAuditCtx());
  const cache = new Map<string, { at: number; v: Promise<AuditCase | undefined> }>();
  return {
    launch: new AuditLaunch(),
    load(id) {
      const hit = cache.get(id);
      if (hit && Date.now() - hit.at < AUDIT_TTL_MS) return hit.v;
      const v = loadCase(c, id);
      cache.set(id, { at: Date.now(), v });
      v.catch(() => cache.delete(id));
      return v;
    },
    async exportZip(x) {
      const { VERSION } = await import("../version.ts");
      return await buildPackage(x, { now: c.now(), version: VERSION });
    },
  };
}

function report(name: string, r: Done): number {
  const p = ui.phase("Audit");
  if (!r.ok) {
    p.fail(r.why, r.fix);
    return 1;
  }
  p.done(`${r.detail}${r.commit ? ` (commit ${r.commit.slice(0, 12)}, signed; not pushed)` : ""}`);
  ui.next.push(
    `push it when ready (bun run stolos apply), then: bun run stolos audit show ${name}`,
  );
  return 0;
}

const lines = (v: unknown) =>
  typeof v === "string"
    ? v
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/** `stolos audit open`. */
export async function auditOpenCmd(a: Record<string, unknown>): Promise<number> {
  const ctx = await pcAuditCtx();
  return report(
    arg(a, "id"),
    await auditOpen(ctx, {
      id: arg(a, "id"),
      ...(a["title"] ? { title: arg(a, "title") } : {}),
      firm: arg(a, "firm"),
      auditors: lines(a["auditor"]),
      from: arg(a, "from"),
      to: arg(a, "to"),
      frameworks: lines(a["framework"])
        .flatMap((x) => x.split(","))
        .map((x) => x.trim().toLowerCase()),
      ...(a["controls"] ? { controls: arg(a, "controls") } : {}),
      expires: arg(a, "expires"),
    }),
  );
}

/** A command-line argument as text ("" where it was not given). */
function arg(a: Record<string, unknown>, name: string): string {
  const v = a[name];
  return typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : "";
}

/** `stolos audit bundle`, `access`, `close`. */
export async function auditChangeCmd(
  what: "bundle" | "access" | "close",
  a: Record<string, unknown>,
): Promise<number> {
  const ctx = await pcAuditCtx();
  const id = arg(a, "id");
  return report(
    id,
    what === "bundle"
      ? await auditBundle(ctx, id, arg(a, "bundle"))
      : what === "access"
        ? await auditAccess(ctx, id, arg(a, "expires"))
        : await auditClose(ctx, id),
  );
}

/** `stolos audit request` and `stolos audit respond`. */
export async function auditEntryCmd(
  kind: "request" | "response" | "note",
  a: Record<string, unknown>,
): Promise<number> {
  const ctx = await pcAuditCtx();
  const id = arg(a, "id");
  if (kind === "request") {
    const got = await committedEngagement(ctx, id);
    const by = arg(a, "by");
    if ("e" in got && !got.e.auditors.some((x) => x.name === by)) {
      return report(id, {
        ok: false,
        why: `--by "${by}" is not one of the engagement's auditors (${got.e.auditors
          .map((x) => x.name)
          .join(", ")})`,
      });
    }
  }
  return report(
    id,
    await auditEntry(ctx, id, {
      kind,
      by: kind === "request" ? arg(a, "by") : await ctx.who(),
      ...(a["control"] ? { control: arg(a, "control") } : {}),
      ...(a["re"] ? { re: Number(a["re"]) } : {}),
      body: arg(a, "text"),
    }),
  );
}

/** `stolos audit sample`. */
export async function auditSampleCmd(a: Record<string, unknown>): Promise<number> {
  const ctx = await pcAuditCtx();
  const id = arg(a, "id");
  const r = await auditSample(ctx, id, {
    control: arg(a, "control"),
    seed: arg(a, "seed"),
    size: Number(a["size"]),
    ...(a["note"] ? { note: arg(a, "note") } : {}),
  });
  if (r.ok && r.units) {
    for (const u of r.units) ui.say(u);
  }
  return report(id, r);
}

/** `stolos audit list`. */
export async function auditListCmd(json: boolean): Promise<number> {
  const ctx = await pcAuditCtx();
  const out = [];
  for (const id of await auditIds(ctx.repo, ctx.fleet)) {
    const got = await committedEngagement(ctx, id);
    if ("e" in got) {
      out.push({
        id,
        title: got.e.title,
        firm: got.e.firm,
        period: got.e.period,
        state: engagementState(got.e, ctx.now()),
        expires: got.e.access.expires,
      });
    }
  }
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const p = ui.phase("Audit");
  for (const x of out) {
    p.note(
      `${x.id}: ${x.title} (${x.firm}, ${x.period.from} to ${x.period.to}): ${x.state}, access to ${x.expires}`,
    );
  }
  p.done(out.length ? `${out.length} engagement(s)` : "no engagements: bun run stolos audit open");
  return 0;
}

/** `stolos audit show`. */
export async function auditShowCmd(id: string, json: boolean): Promise<number> {
  const ctx = await pcAuditCtx();
  const c = await loadCase(ctx, id);
  const p = ui.phase("Audit");
  if (!c) {
    p.fail(`no engagement ${id}`, "bun run stolos audit list");
    return 1;
  }
  const problems = caseProblems(c);
  if (json) {
    const { engagementJson } = await import("./portal.ts");
    stdio.stdout.writeSync(`${JSON.stringify(engagementJson(c, ctx.now()), null, 2)}\n`);
    return problems.length ? 1 : 0;
  }
  const e = c.engagement;
  p.note(
    `${e.title}: ${e.firm}, ${e.period.from} to ${e.period.to}, ${engagementState(
      e,
      ctx.now(),
    )}, access to ${e.access.expires}`,
  );
  for (const x of e.controls) {
    const pop = c.populations.get(x.id);
    p.note(
      `${x.id} (${x.population}): ${
        pop ? `${pop.units.length} unit(s), hash ${pop.hash.slice(0, 16)}` : "no bundle"
      }`,
    );
  }
  for (const t of c.trail) {
    p.note(
      `#${t.entry?.seq} ${t.entry?.kind} ${t.entry?.control ?? ""} by ${t.entry?.by}: ${
        t.proof.signer ? `signed by ${t.proof.signer}` : "not verified"
      }`,
    );
  }
  for (const x of problems) p.warn(x);
  if (problems.length) {
    p.fail(`${problems.length} problem(s) the auditor will see`);
    return 1;
  }
  p.done("everything checks out");
  return 0;
}

/** `stolos audit export`. */
export async function auditExportCmd(id: string, out?: string): Promise<number> {
  const ctx = await pcAuditCtx();
  const p = ui.phase("Audit");
  const zip = await auditExportZip(ctx, id);
  if (!zip) {
    p.fail(`no engagement ${id}`, "bun run stolos audit list");
    return 1;
  }
  const file = out ?? paths.join(ctx.evidenceDir, "..", "audits", `${ctx.fleet}-audit-${id}.zip`);
  await fs.mkdir(paths.dirname(file), { recursive: true });
  await fs.writeFile(file, zip);
  p.done(file);
  ui.next.push(`the auditor checks it, offline: bun run stolos audit verify ${file}`);
  return 0;
}

/** `stolos audit verify`. */
export async function auditVerifyCmd(
  file: string,
  signers?: string,
  json = false,
): Promise<number> {
  const p = ui.phase("Audit");
  let zip: Uint8Array;
  try {
    zip = await fs.readFile(file);
  } catch (e) {
    p.fail(`${file}: ${toError(e).message}`);
    return 1;
  }
  const allowed = signers ? await fs.readTextFile(signers) : undefined;
  const r = await verifyPackage(zip, allowed ? { allowedSigners: allowed } : {});
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify({ ok: r.ok, problems: r.problems }, null, 2)}\n`);
    return r.ok ? 0 : 1;
  }
  if (r.case) {
    const e = r.case.engagement;
    p.note(
      `${e.title}: ${e.firm}, ${e.period.from} to ${e.period.to}; ${e.controls.length} control(s), ${r.case.trail.length} trail entr(ies)`,
    );
  }
  for (const x of r.problems) p.warn(x);
  if (!r.ok) {
    p.fail(`${r.problems.length} problem(s): do not rely on this package`);
    return 1;
  }
  p.done(
    "the bundle verifies; every trail entry and the engagement are vouched for by signed commits; every population and sample recomputes",
  );
  if (!signers) {
    ui.next.push(
      "the package's own signers vouched for it: pass --signers with the fleet's allowed_signers you have from elsewhere",
    );
  }
  return 0;
}
