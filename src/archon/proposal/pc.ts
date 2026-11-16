/**
 * Spec 095-proposals: `stolos proposal ...` on your PC, in the fleet
 * repository. `import` reads a saved message (`.eml`) or the attachments,
 * checks that the host is in the fleet and that the signature is its own host
 * key from `registration.ts`, and keeps the proposal in your state folder
 * (outside Git). `list` and `show` say what each would change; `accept` edits
 * the host's TypeScript, writes a draft spec, records the decision in Git,
 * and builds; `reject` records the rejection. You review and run `stolos
 * apply`, and the server converges.
 *
 * ```mermaid
 * flowchart LR
 *   mail["saved mail (.eml)<br/>or proposal.json + .sig"] --> imp["stolos proposal import<br/>verify against registration.ts"]
 *   imp --> store["your state folder<br/>(not committed)"]
 *   store --> show["list / show:<br/>the model diff, conflicts"]
 *   show --> acc["accept: host.ts adopted({...}),<br/>specs/NNN-.../spec.md, proposals.ts, build"]
 *   show --> rej["reject: proposals.ts"]
 *   acc & rej --> apply["stolos apply (signed commit)"] --> host["the host pulls:<br/>converges, holds end"]
 * ```
 *
 * @module
 */

import { fs, path as paths, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { P, repoRel } from "../core/paths.ts";
import { currentUser, run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { hostFile, loadHosts } from "../model/load.ts";
import { attachmentsOf, gunzip } from "./mail.ts";
import { readProposal, verifyProposal } from "./proposal.ts";
import { decisionsSource, loadProposalDecisions, proposalsFile } from "./decisions.ts";
import {
  addAdopted,
  adoptedDef,
  checkEdits,
  draftSpec,
  type EditCheck,
  lineDiff,
  nextSpecNumber,
  specId,
} from "./edit.ts";
import { type Proposal, PROPOSAL_FORMAT, type ProposalDecision } from "./types.ts";

/** Where imported proposals are kept on this PC (per fleet; never committed). */
export function proposalStore(): string {
  return paths.join(P.userState, "proposals");
}

/** Each host's SSH host keys from Git (registration.ts); undefined for a host not in the fleet. */
export async function fleetHostKeys(): Promise<(host: string) => string[] | undefined> {
  const hosts = await loadHosts();
  return (h) => {
    const host = hosts.find((x) => x.name === h);
    return host ? (host.registration?.sshHostKeys ?? []) : undefined;
  };
}

/** One proposal found in what was given to import. */
export interface Candidate {
  /** Where it came from (a file, or a file inside a message). */
  from: string;
  /** proposal.json's text. */
  text: string;
  /** Its signature, when found. */
  sig?: string;
}

const dec = new TextDecoder();

/** The proposals in a file (.eml, .json, .json.gz) or a folder of them. */
export async function candidates(path: string): Promise<Candidate[]> {
  const st = await fs.stat(path);
  const files = st.isDirectory
    ? (await fs.walkFiles(path)).map((r) => paths.join(path, r))
    : [path];
  const out: Candidate[] = [];
  for (const f of files.sort()) {
    if (/\.eml$/i.test(f)) {
      const att = await attachmentsOf(await fs.readTextFile(f));
      const sigs = att.filter((a) => /\.sig$/i.test(a.name));
      for (const j of att.filter((a) => /\.json$/i.test(a.name))) {
        const sig =
          sigs.find((s) => s.name === `${j.name}.sig`) ?? (sigs.length === 1 ? sigs[0] : undefined);
        out.push({
          from: `${f} (${j.name})`,
          text: dec.decode(j.data),
          ...(sig ? { sig: dec.decode(sig.data) } : {}),
        });
      }
      continue;
    }
    if (!/\.json(\.gz)?$/i.test(f)) continue;
    const raw = await fs.readFile(f);
    const text = dec.decode(/\.gz$/i.test(f) ? await gunzip(raw) : raw);
    if (!text.includes(PROPOSAL_FORMAT)) continue;
    const plain = f.replace(/\.gz$/i, "");
    const sig =
      (await fs.readTextOr(`${plain}.sig`)) ??
      (await fs.readTextOr(`${f}.sig`)) ??
      (await fs.readTextOr(paths.join(paths.dirname(f), "proposal.json.sig")));
    out.push({ from: f, text, ...(sig ? { sig } : {}) });
  }
  return out;
}

/** An imported proposal: its text, signature, and parsed content. */
export interface Imported {
  /** The proposal. */
  proposal: Proposal;
  /** proposal.json as signed. */
  text: string;
  /** proposal.json.sig. */
  sig: string;
}

/** Every imported proposal, newest first. */
export async function imported(): Promise<Imported[]> {
  const out: Imported[] = [];
  for (const id of await fs.listDirs(proposalStore())) {
    const dir = paths.join(proposalStore(), id);
    const text = await fs.readTextOr(paths.join(dir, "proposal.json"));
    const sig = await fs.readTextOr(paths.join(dir, "proposal.json.sig"));
    if (!text || !sig) continue;
    const read = readProposal(text);
    if ("proposal" in read) out.push({ proposal: read.proposal, text, sig }); // else not ours: skipped
  }
  return out.sort((a, b) => b.proposal.at.localeCompare(a.proposal.at));
}

/** One imported proposal by id (or a unique start of it). */
export async function findImported(id: string): Promise<Imported> {
  const all = await imported();
  const hit = all.filter((p) => p.proposal.id === id);
  const near = hit.length ? hit : all.filter((p) => p.proposal.id.startsWith(id));
  const [only] = near;
  if (only && near.length === 1) return only;
  throw new Error(
    near.length
      ? `${id} names ${near.length} proposals: ${near.map((p) => p.proposal.id).join(", ")}`
      : `no imported proposal ${id}: bun run stolos proposal import <file> first (list: bun run stolos proposal list)`,
  );
}

/** `stolos proposal import <file|folder>`: verify each and keep the good ones. */
export async function importCommand(path: string): Promise<number> {
  const found = await candidates(path);
  if (!found.length) {
    stdio.stderr.writeSync(
      `no proposal in ${path} (a saved .eml, or proposal.json with proposal.json.sig beside it)\n`,
    );
    return 1;
  }
  const keys = await fleetHostKeys();
  let bad = 0;
  for (const c of found) {
    if (!c.sig) {
      stdio.stderr.writeSync(`✗ ${c.from}: no signature (proposal.json.sig) with it: refused\n`);
      bad++;
      continue;
    }
    const v = await verifyProposal(c.text, c.sig, keys);
    if (v.problem || !v.proposal) {
      stdio.stderr.writeSync(`✗ ${c.from}: refused: ${v.problem}\n`);
      bad++;
      continue;
    }
    const p = v.proposal;
    const dir = paths.join(proposalStore(), p.id);
    const have = await fs.readTextOr(paths.join(dir, "proposal.json"));
    if (have === c.text) {
      stdio.stdout.writeSync(`= ${p.id}: already imported\n`);
      continue;
    }
    if (have !== undefined) {
      stdio.stderr.writeSync(
        `✗ ${c.from}: a different proposal ${p.id} is already imported: refused\n`,
      );
      bad++;
      continue;
    }
    await fs.ensureDir(dir);
    await fs.writeTextFile(paths.join(dir, "proposal.json"), c.text);
    await fs.writeTextFile(paths.join(dir, "proposal.json.sig"), c.sig);
    stdio.stdout.writeSync(
      `✓ ${p.id}: from ${p.host}, by ${p.by}, ${p.items.length} item(s), signed by ${p.host}'s host key\n`,
    );
  }
  if (bad < found.length) stdio.stdout.writeSync("next: bun run stolos proposal show <id>\n");
  return bad ? 1 : 0;
}

/** Its decision in Git, or "waiting". */
async function statusOf(p: Proposal): Promise<string> {
  const d = (await loadProposalDecisions(p.host))[p.id];
  return d ? `${d.decision} ${d.at.slice(0, 10)}` : "waiting";
}

/** `stolos proposal list`. */
export async function listCommand(json: boolean): Promise<number> {
  const all = await imported();
  const rows = [];
  for (const i of all) {
    const p = i.proposal;
    rows.push({
      id: p.id,
      host: p.host,
      at: p.at,
      by: p.by,
      items: p.items.length,
      status: await statusOf(p),
      reason: p.reason,
    });
  }
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (!rows.length) {
    stdio.stdout.writeSync(
      "no proposals imported: bun run stolos proposal import <saved mail or folder>\n",
    );
    return 0;
  }
  for (const r of rows) {
    stdio.stdout.writeSync(
      `${r.id.padEnd(30)} ${r.at
        .slice(0, 16)
        .replace("T", " ")}  ${r.by}  ${r.items} item(s)  ${r.status}  ${r.reason}\n`,
    );
  }
  return 0;
}

/** What accepting would do: the checks, the new host.ts (or why not), and how far the model moved since. */
export async function plan(
  i: Imported,
  skip: string[] = [],
): Promise<{
  checks: EditCheck[];
  conflicts: EditCheck[];
  before?: string;
  after?: string;
  problem?: string;
  moved: string;
  spec: ReturnType<typeof specId>;
}> {
  const p = i.proposal;
  const host = (await loadHosts()).find((h) => h.name === p.host);
  if (!host) throw new Error(`${p.host} is not a host of this fleet`);
  const { planFor } = await import("../build.ts");
  const items = p.items.filter((x) => !skip.includes(x.key));
  const checks = checkEdits(await planFor(host), items);
  const conflicts = checks.filter((c) => c.status === "conflict");
  // The fleet's own specs (fleets/<fleet>/specs/) are numbered after the engine's.
  const { knownSpecs } = await import("../build.ts");
  const spec = specId(nextSpecNumber([...(await knownSpecs())]), p.host, p.reason);
  const fresh = checks.filter((c) => c.status === "new").map((c) => c.edit);
  const file = hostFile(p.host);
  const before = await fs.readTextFile(file);
  let after: string | undefined;
  let problem: string | undefined;
  if (fresh.length) {
    const r = addAdopted(
      before,
      adoptedDef(p.id, spec, fresh),
      `Spec ${spec}: adopted from proposal ${p.id} (${p.by}: ${p.reason.replace(/\n/g, " ")}).`,
    );
    if ("problem" in r) problem = r.problem;
    else after = r.text;
  }
  // Has the model moved on since the host made it?
  let moved = "";
  if (p.base) {
    const known = (await run(["git", "-C", P.repo, "cat-file", "-e", `${p.base}^{commit}`])).ok;
    if (!known) {
      moved = `the host ran ${p.base.slice(
        0,
        12,
      )}, which this checkout does not have (pull first?)`;
    } else {
      const log = (
        await run([
          "git",
          "-C",
          P.repo,
          "log",
          "--oneline",
          `${p.base}..HEAD`,
          "--",
          repoRel(paths.dirname(file)),
        ])
      ).stdout.trim();
      if (log) {
        moved = `${log.split("\n").length} commit(s) changed ${p.host}'s model since the host ran ${p.base.slice(
          0,
          12,
        )}: conflicts are checked against the model now`;
      }
    }
  }
  return {
    checks,
    conflicts,
    before,
    ...(after === undefined ? {} : { after }),
    ...(problem === undefined ? {} : { problem }),
    moved,
    spec,
  };
}

/** `stolos proposal show <id>`: the summary, each item, and the model diff accepting makes. */
export async function showCommand(id: string, json: boolean): Promise<number> {
  const i = await findImported(id);
  const v = await verifyProposal(i.text, i.sig, await fleetHostKeys());
  const p = i.proposal;
  const pl = await plan(i);
  if (json) {
    stdio.stdout.writeSync(
      `${JSON.stringify(
        {
          proposal: p,
          verified: !v.problem,
          problem: v.problem,
          checks: pl.checks,
          status: await statusOf(p),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const { proposalSummary } = await import("./proposal.ts");
  stdio.stdout.writeSync(`${proposalSummary(p).split("\n\nTo decide on your PC")[0]}\n`);
  stdio.stdout.writeSync(
    `\nSignature: ${v.problem ? `REFUSED: ${v.problem}` : `good (${p.host}'s host key)`}\n`,
  );
  stdio.stdout.writeSync(`Decision: ${await statusOf(p)}\n`);
  if (pl.moved) stdio.stdout.writeSync(`Note: ${pl.moved}\n`);
  for (const c of pl.checks.filter((x) => x.status !== "new")) {
    stdio.stdout.writeSync(
      `${c.status === "conflict" ? "CONFLICT" : "already"}: ${c.key}: ${c.why}\n`,
    );
  }
  if (pl.problem) stdio.stdout.writeSync(`\nhost.ts: ${pl.problem}\n`);
  if (pl.after && pl.before) {
    stdio.stdout.writeSync(
      `\n${repoRel(hostFile(p.host))}, if accepted (draft spec ${pl.spec}):\n`,
    );
    stdio.stdout.writeSync(`${lineDiff(pl.before, pl.after)}\n`);
  } else if (!pl.problem) stdio.stdout.writeSync("\nNothing new for the model.\n");
  return v.problem ? 1 : 0;
}

/** Who decides, for the record: this checkout's git user, else the account. */
async function decider(): Promise<string> {
  return (await run(["git", "-C", P.repo, "config", "user.name"])).stdout.trim() || currentUser();
}

async function record(host: string, id: string, d: ProposalDecision): Promise<string> {
  const all = await loadProposalDecisions(host);
  all[id] = d;
  const file = proposalsFile(host);
  await fs.writeTextFile(file, decisionsSource(all));
  return file;
}

/** `stolos proposal accept <id> [--skip <key>]`: the model change, a draft spec, the decision, and a build. */
export async function acceptCommand(id: string, skipArg?: string): Promise<number> {
  const skip = (skipArg ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const v = ui.phase("Verify");
  const i = await findImported(id);
  const p = i.proposal;
  const check = await verifyProposal(i.text, i.sig, await fleetHostKeys());
  if (check.problem) {
    v.fail(
      `${p.id}: ${check.problem}`,
      "import it again from the original mail; a changed proposal is refused",
    );
    return ui.finish();
  }
  const done = (await loadProposalDecisions(p.host))[p.id];
  if (done) {
    v.fail(
      `${p.id} is already ${done.decision} (${done.at.slice(0, 10)}, by ${done.by})`,
      "nothing to do",
    );
    return ui.finish();
  }
  for (const k of skip) {
    if (!p.items.some((x) => x.key === k)) {
      v.fail(`--skip ${k}: not an item of ${p.id}`, `bun run stolos proposal show ${p.id}`);
      return ui.finish();
    }
  }
  v.done(`${p.id}: signed by ${p.host}'s host key, ${p.items.length} item(s) from ${p.by}`);
  const m = ui.phase("Model");
  const pl = await plan(i, skip);
  if (pl.moved) m.note(pl.moved);
  if (pl.conflicts.length) {
    for (const c of pl.conflicts) {
      m.fail(`${c.key}: ${c.why}`, `bun run stolos proposal accept ${p.id} --skip ${c.key}`);
    }
    return ui.finish();
  }
  if (pl.problem) {
    m.fail(pl.problem, `bun run stolos proposal show ${p.id} shows what to add`);
    return ui.finish();
  }
  for (const c of pl.checks.filter((x) => x.status === "already")) m.skip(`${c.key}: ${c.why}`);
  if (pl.after) {
    await fs.writeTextFile(hostFile(p.host), pl.after);
    m.done(
      `${pl.checks.filter((c) => c.status === "new").length} edit(s) in ${repoRel(
        hostFile(p.host),
      )}`,
    );
  } else m.done("nothing new for the model");
  const s = ui.phase("Spec");
  const at = new Date().toISOString();
  const by = await decider();
  const specDir = paths.join(P.fleetDir, "specs", pl.spec);
  await fs.ensureDir(specDir);
  await fs.writeTextFile(
    paths.join(specDir, "spec.md"),
    draftSpec(p, pl.spec, pl.checks, { by, at }, skip),
  );
  s.done(`draft ${repoRel(paths.join(specDir, "spec.md"))}: review and edit it`);
  const d = ui.phase("Decision");
  const local = p.items
    .filter((x) => x.action === "local" && !skip.includes(x.key))
    .map((x) => ({
      key: x.key,
      until: x.until ?? at.slice(0, 10),
    }));
  const file = await record(p.host, p.id, {
    decision: "accepted",
    by,
    at,
    spec: pl.spec,
    adopted: [...new Set(pl.checks.filter((c) => c.status === "new").map((c) => c.key))],
    ...(local.length ? { local } : {}),
    ...(skip.length ? { skipped: skip } : {}),
  });
  d.done(`accepted in ${repoRel(file)}`);
  const b = ui.phase("Build");
  const r = await buildAgain();
  if (r.ok) b.done("valid; rendered into out/");
  else {
    b.fail(
      `stolos build failed: ${r.tail}`,
      "fix the model (the edit is in host.ts), then bun run stolos build",
    );
  }
  ui.next.push(
    `review: git diff (${repoRel(hostFile(p.host))}, ${repoRel(paths.join(specDir, "spec.md"))}, ${repoRel(
      file,
    )})`,
    `then: bun run stolos apply -m "${pl.spec}: adopt proposal ${p.id}"`,
    `${p.host} converges within 15 minutes of the push; its holds on these items end`,
  );
  return ui.finish();
}

/** stolos build in a new process: host.ts changed, and this process already loaded the old one. */
async function buildAgain(): Promise<{ ok: boolean; tail: string }> {
  const r = await proc.output(proc.selfCommand(["build"]), {
    env: { ARCHON_FLEET: P.fleetId, ARCHON_REPO: P.repo },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const text = dec.decode(r.stdout) + dec.decode(r.stderr);
  return { ok: r.success, tail: text.trim().split("\n").slice(-6).join(" | ") };
}

/** `stolos proposal reject <id> [--reason]`: recorded in Git; after the push the host ends its holds. */
export async function rejectCommand(id: string, reason?: string): Promise<number> {
  const i = await findImported(id);
  const p = i.proposal;
  const done = (await loadProposalDecisions(p.host))[p.id];
  if (done) throw new Error(`${p.id} is already ${done.decision} (${done.at.slice(0, 10)})`);
  const file = await record(p.host, p.id, {
    decision: "rejected",
    by: await decider(),
    at: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  });
  stdio.stdout.writeSync(`rejected ${p.id} in ${repoRel(file)}\n`);
  stdio.stdout.writeSync(
    `commit and push it: bun run stolos apply -m "095-proposals: reject ${p.id}"\n`,
  );
  stdio.stdout.writeSync(
    `after the push, ${p.host} ends the holds: managed items revert at the next apply; anything else stays flagged in archon drift\n`,
  );
  return 0;
}
