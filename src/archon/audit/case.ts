/**
 * Spec 083: one engagement, read and checked: its file and the commit that
 * vouches for it, its evidence bundle (verified with `verifyBundle`), the
 * population of each control in scope, the trail with each entry's commit,
 * and each recorded sample redrawn from its seed. The portal reads it from
 * the fleet repository ({@link loadAudit}); `stolos audit verify` reads the
 * same from an export package, offline, with the same code.
 *
 * ```mermaid
 * flowchart LR
 *   repo["the fleet repository (HEAD)"] --> parts["parts: engagement.ts, trail/*.md, raw commits, the bundle"]
 *   pkg["an export package (ZIP)"] --> parts
 *   parts --> assemble["assemble: proofs, verifyBundle, populations, samples redrawn"]
 *   assemble --> portal["the portal"] & verify["stolos audit verify"]
 * ```
 *
 * @module
 */

import { sha256 as sha256Hex } from "@intellectual-frontiers/commons/ts/kernel";
import { run } from "../core/exec.ts";
import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { verifyBundle, type VerifyResult } from "../evidence/bundle.ts";
import { type Engagement, engagementPath, parseEngagement } from "./engagement.ts";
import { type BundleView, bundleView, type Population, population } from "./populations.ts";
import { checkSample } from "./sample.ts";
import {
  ENTRY_FILE,
  entryFile,
  parseEntry,
  type Proof,
  proveEntry,
  trailDir,
  type TrailEntry,
} from "./trail.ts";

/** A file and the raw commit that recorded it (when there is one). */
export interface CommittedFile {
  /** Its path, relative to the repository. */
  path: string;
  /** Its text. */
  text: string;
  /** The raw commit object that last changed it. */
  raw?: string;
  /** The commit's id, when known. */
  commit?: string;
}

/** What an engagement is read from: the repository, or an export package. */
export interface AuditParts {
  /** The fleet's id. */
  fleet: string;
  /** engagement.ts. */
  engagement: CommittedFile;
  /** Each trail entry. */
  trail: CommittedFile[];
  /** The evidence bundle's bytes, when found. */
  bundle?: Uint8Array;
  /** Why the bundle was not found. */
  bundleMissing?: string;
  /** The allowed signers the commits and the bundle are checked against. */
  allowedSigners: string;
}

/** One trail entry, checked. */
export interface CheckedEntry {
  /** Its file and commit. */
  file: CommittedFile;
  /** The entry, when it could be read. */
  entry?: TrailEntry;
  /** Its proof (the commit vouches for its text, signed by a signer). */
  proof: Proof;
  /** For a sample: what redrawing it found (empty: the same units). */
  redraw?: string[];
}

/** The evidence bundle, read and verified. */
export interface CheckedBundle {
  /** Its bytes. */
  zip: Uint8Array;
  /** Its SHA-256. */
  sha256: string;
  /** Its manifest and items. */
  view: BundleView;
  /** What verifyBundle found. */
  verify: VerifyResult;
}

/** One engagement, read and checked. */
export interface AuditCase {
  /** The fleet's id. */
  fleet: string;
  /** The engagement. */
  engagement: Engagement;
  /** engagement.ts and its commit. */
  engagementFile: CommittedFile;
  /** engagement.ts's proof. */
  engagementProof: Proof;
  /** The bundle, when it is pinned and found. */
  bundle?: CheckedBundle;
  /** What is wrong with the bundle as pinned (not found, a different file). */
  bundleProblems: string[];
  /** Each control's population, by control id (only with a bundle). */
  populations: Map<string, Population>;
  /** The trail, in order. */
  trail: CheckedEntry[];
  /** The allowed signers it was checked against. */
  allowedSigners: string;
}

/** Every problem the case has, each with where it is (empty: everything checks out). */
export function caseProblems(c: AuditCase): string[] {
  return [
    ...c.engagementProof.problems.map((p) => `engagement.ts: ${p}`),
    ...c.bundleProblems.map((p) => `bundle: ${p}`),
    ...(c.bundle?.verify.problems ?? []).map((p) => `bundle: ${p}`),
    ...c.trail.flatMap((t) => [
      ...t.proof.problems.map((p) => `${t.file.path}: ${p}`),
      ...(t.redraw ?? []).map((p) => `${t.file.path}: ${p}`),
    ]),
  ];
}

/** Read and check an engagement from its parts. */
export async function assemble(p: AuditParts): Promise<AuditCase> {
  const engagement = parseEngagement(p.engagement.text);
  const prove = async (f: CommittedFile): Promise<Proof> => {
    if (!f.raw) {
      return {
        path: f.path,
        sha256: await sha256Hex(f.text),
        problems: ["not committed (no commit vouches for it)"],
      };
    }
    const proof = await proveEntry(f.path, f.text, f.raw, p.allowedSigners);
    return f.commit ? { ...proof, commit: f.commit } : proof;
  };
  const bundleProblems: string[] = [];
  let bundle: CheckedBundle | undefined;
  if (!engagement.bundle) {
    bundleProblems.push("no evidence bundle is pinned yet (stolos audit bundle)");
  } else if (!p.bundle) {
    bundleProblems.push(p.bundleMissing ?? `${engagement.bundle.file}: not found`);
  } else {
    const sha256 = await sha256Hex(p.bundle);
    if (sha256 !== engagement.bundle.sha256) {
      bundleProblems.push(
        `${engagement.bundle.file} is not the bundle the engagement pins (SHA-256 ${sha256}, pinned ${engagement.bundle.sha256})`,
      );
    } else {
      const view = await bundleView(p.bundle);
      bundle = {
        zip: p.bundle,
        sha256,
        view,
        verify: await verifyBundle(p.bundle, { allowedSigners: p.allowedSigners }),
      };
      if (view.manifest.head !== engagement.bundle.head) {
        bundleProblems.push("its manifest's head is not the one the engagement pins");
      }
    }
  }
  const populations = new Map<string, Population>();
  if (bundle) {
    const byId = new Map<string, Population>();
    for (const c of engagement.controls) {
      let pop = byId.get(c.population);
      if (!pop) {
        pop = await population(c.population, bundle.view, engagement.period);
        byId.set(c.population, pop);
      }
      populations.set(c.id, pop);
    }
  }
  const trail: CheckedEntry[] = [];
  for (const f of [...p.trail].sort((a, b) => a.path.localeCompare(b.path))) {
    const proof = await prove(f);
    let entry: TrailEntry | undefined;
    try {
      entry = parseEntry(f.text);
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      if (name !== entryFile(entry)) {
        proof.problems.push(`its front matter says ${entryFile(entry)}, not ${name}`);
      }
    } catch (e) {
      proof.problems.push((e as Error).message);
    }
    let redraw: string[] | undefined;
    if (entry?.kind === "sample") {
      const s = entry.sample;
      const pop =
        s && bundle
          ? ([...populations.values()].find((x) => x.id === s.population) ??
            (await population(s.population, bundle.view, engagement.period)))
          : undefined;
      redraw = !s
        ? ["a sample entry without its sample"]
        : !pop
          ? ["cannot be redrawn without the bundle"]
          : await checkSample(s, pop);
    }
    trail.push({ file: f, ...(entry ? { entry } : {}), proof, ...(redraw ? { redraw } : {}) });
  }
  return {
    fleet: p.fleet,
    engagement,
    engagementFile: p.engagement,
    engagementProof: await prove(p.engagement),
    ...(bundle ? { bundle } : {}),
    bundleProblems,
    populations,
    trail,
    allowedSigners: p.allowedSigners,
  };
}

/** A file at the repository's HEAD and the raw commit that last changed it. */
async function committed(repo: string, path: string): Promise<CommittedFile | undefined> {
  const git = (args: string[]) => run(["git", "-C", repo, ...args]);
  const shown = await git(["show", `HEAD:${path}`]);
  if (!shown.ok) return undefined;
  const commit = (await git(["log", "-1", "--format=%H", "HEAD", "--", path])).stdout.trim();
  const raw = commit ? (await git(["cat-file", "commit", commit])).stdout : undefined;
  return { path, text: shown.stdout, ...(raw ? { raw, commit } : {}) };
}

/** Where an engagement is read from on this PC. */
export interface AuditLocation {
  /** The fleet repository. */
  repo: string;
  /** The fleet's id. */
  fleet: string;
  /** The engagement's id. */
  id: string;
  /** This PC's evidence directory (where the pinned bundle is). */
  evidenceDir: string;
  /** The fleet's signers, as an allowed_signers file's text. */
  allowedSigners: string;
}

/** The parts of an engagement in the fleet repository (as committed: HEAD), or undefined when there is none. */
export async function repoParts(l: AuditLocation): Promise<AuditParts | undefined> {
  const engagement = await committed(l.repo, engagementPath(l.fleet, l.id));
  if (!engagement) return undefined;
  const dir = trailDir(l.fleet, l.id);
  const ls = await run(["git", "-C", l.repo, "ls-tree", "--name-only", `HEAD:${dir}`]);
  const trail: CommittedFile[] = [];
  for (const n of ls.ok ? ls.stdout.split("\n").filter((x) => ENTRY_FILE.test(x)) : []) {
    const f = await committed(l.repo, `${dir}/${n}`);
    if (f) trail.push(f);
  }
  const e = parseEngagement(engagement.text);
  let bundle: Uint8Array | undefined;
  let bundleMissing: string | undefined;
  if (e.bundle) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zip$/.test(e.bundle.file)) {
      bundleMissing = `${e.bundle.file}: not a bundle's file name`;
    } else {
      bundle = await fs.readFile(path.join(l.evidenceDir, e.bundle.file)).catch(() => undefined);
      if (!bundle) {
        bundleMissing = `${e.bundle.file} is not in this PC's evidence directory (${l.evidenceDir}): copy the bundle there`;
      }
    }
  }
  return {
    fleet: l.fleet,
    engagement,
    trail,
    ...(bundle ? { bundle } : {}),
    ...(bundleMissing ? { bundleMissing } : {}),
    allowedSigners: l.allowedSigners,
  };
}

/** An engagement from the fleet repository, read and checked; undefined when there is none. */
export async function loadAudit(l: AuditLocation): Promise<AuditCase | undefined> {
  const parts = await repoParts(l);
  return parts ? await assemble(parts) : undefined;
}

/** The engagements in the fleet repository's HEAD, by id. */
export async function auditIds(repo: string, fleet: string): Promise<string[]> {
  const ls = await run([
    "git",
    "-C",
    repo,
    "ls-tree",
    "--name-only",
    `HEAD:fleets/${fleet}/audits`,
  ]);
  return ls.ok ? ls.stdout.split("\n").filter(Boolean).sort() : [];
}
