/**
 * Spec 095-proposals: `archon propose` on a server. Anyone with sudo may
 * propose (the owner's decision 3). It collects again, picks the items (all,
 * by intent, or by key), applies each person's choice (adopt, revert, or
 * keep local until a day), requires a written reason, builds and signs
 * `proposal.json` with the host key, keeps a copy in
 * `/var/lib/archon/proposals/<id>/`, records it in `archon.sql`, and mails it
 * to the fleet's mailbox with a readable summary.
 *
 * @module
 */

import { fs, path as paths, proc, stdio } from "@intellectual-frontiers/ifc-ts/runtime";
import { asRoot, P } from "../core/paths.ts";
import { currentUser, run } from "../core/exec.ts";
import { putRecord } from "../state/store.ts";
import { VERSION } from "../version.ts";
import type { HostDef } from "../model/types.ts";
import type { Event } from "../notify/notify.ts";
import type { Birth, Hold, SentProposal } from "./drift.ts";
import { unproposed } from "./drift.ts";
import { groupItems, type Recording } from "./group.ts";
import {
  buildProposal,
  type Choice,
  keySigner,
  proposalSummary,
  proposalText,
  type Signer,
  signProposal,
} from "./proposal.ts";
import { fileEvidence } from "./secrets.ts";
import {
  type Action,
  type DriftItem,
  type FileEvidence,
  LOCAL_DAYS,
  type Proposal,
} from "./types.ts";

/** Where a host keeps the proposals it sent. */
export const PROPOSALS_DIR = "/var/lib/archon/proposals";

/** What `archon propose` was asked for. */
export interface ProposeOptions {
  /** Every item not proposed yet. */
  all?: boolean | undefined;
  /** Intents by id (newline-separated when repeated). */
  intent?: string | undefined;
  /** Items by key (newline-separated when repeated). */
  item?: string | undefined;
  /** The action for every chosen item (default adopt). */
  action?: string | undefined;
  /** Items to revert instead (keys, newline-separated). */
  revert?: string | undefined;
  /** Items to keep local instead (keys, newline-separated). */
  local?: string | undefined;
  /** Local: until this day (default 30 days from now). */
  until?: string | undefined;
  /** Why (required, unless a recording gives it). */
  reason?: string | undefined;
  /** Print proposal.json; sign, record, and send nothing. */
  dryRun?: boolean | undefined;
  /** --json. */
  json?: boolean | undefined;
}

const list = (s?: string) =>
  (s ?? "")
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Who proposes: the person behind sudo (and the agent, when one runs it over MCP). */
export function proposer(): string {
  const who = proc.env.get("SUDO_USER") || currentUser();
  const agent = proc.env.get("ARCHON_AGENT");
  return agent ? `${who} (via ${agent})` : who;
}

/** Choose items and their actions; throws a message naming what is wrong. */
export function choose(
  items: DriftItem[],
  intents: Array<{ id: string; items: string[]; reason?: string }>,
  o: ProposeOptions,
  now: Date = new Date(),
): { chosen: DriftItem[]; choices: Record<string, Choice>; reason: string } {
  const open = unproposed(items);
  const keys = new Set<string>();
  if (o.all) {
    for (const i of open) keys.add(i.key);
  }
  let recorded: string | undefined;
  for (const id of list(o.intent)) {
    const i = intents.find((x) => x.id === id);
    if (!i) {
      throw new Error(
        `no intent ${id} (archon drift shows them with --json; archon propose --all takes every item)`,
      );
    }
    for (const k of i.items) if (open.some((x) => x.key === k)) keys.add(k);
    recorded ??= i.reason;
  }
  for (const k of list(o.item)) {
    const it = items.find((x) => x.key === k);
    if (!it) throw new Error(`no drift item ${k} (archon drift lists them)`);
    if (!open.includes(it)) {
      throw new Error(
        `${k} is already ${
          it.proposal ? `in proposal ${it.proposal}` : it.localUntil ? "local" : "rejected"
        }`,
      );
    }
    keys.add(k);
  }
  if (!keys.size) {
    throw new Error(
      "nothing chosen: --all, --intent <id>, or --item <key> (archon drift lists them)",
    );
  }
  const reason = (o.reason ?? recorded ?? "").trim();
  if (!reason) throw new Error('a written reason is required: --reason "why this change was made"');
  const action = (o.action ?? "adopt") as Action;
  if (!["adopt", "revert", "local"].includes(action)) {
    throw new Error(`--action: adopt, revert, or local, not ${action}`);
  }
  const until =
    o.until ?? new Date(now.getTime() + LOCAL_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    throw new Error(`--until: a day (YYYY-MM-DD), not ${until}`);
  }
  const choices: Record<string, Choice> = {};
  for (const k of keys) choices[k] = action === "local" ? { action, until } : { action };
  for (const k of list(o.revert)) {
    if (!keys.has(k)) throw new Error(`--revert ${k}: not among the chosen items`);
    choices[k] = { action: "revert" };
  }
  for (const k of list(o.local)) {
    if (!keys.has(k)) throw new Error(`--local ${k}: not among the chosen items`);
    choices[k] = { action: "local", until };
  }
  const chosen = items.filter((i) => keys.has(i.key));
  for (const i of chosen) {
    if (i.managed && choices[i.key]?.action === "local") {
      throw new Error(
        `${i.key} is managed by ${
          i.spec ?? "the plan"
        }: adopt or revert it (the model wins in the end)`,
      );
    }
  }
  return { chosen, choices, reason };
}

/** A file's evidence on this host: hash, mode, owner, and (when allowed) its content and its etckeeper diff. */
export async function hostFileEvidence(
  path: string,
  birth?: Birth,
): Promise<FileEvidence | undefined> {
  if (!(await fs.exists(path))) return undefined;
  const data = await fs.readFile(path);
  const st = (await run(["stat", "-c", "%a %U %G", path])).stdout.trim().split(" ");
  const diff =
    path.startsWith("/etc/") && birth?.etcCommit
      ? (await run(["git", "-C", "/etc", "diff", birth.etcCommit, "--", path.slice(5)])).stdout
      : undefined;
  return await fileEvidence(path, data, {
    mode: st[0] ? st[0].padStart(4, "0") : undefined,
    owner: st[1],
    group: st[2],
    ...(diff && diff.length <= 16_384 ? { diff } : {}),
  });
}

/** The recordings on this host (`archon record`). */
export async function recordings(host: string, dir: string = P.state): Promise<Recording[]> {
  const { listRecords } = await import("../state/store.ts");
  return (await listRecords<Recording>(host, "recording", dir))
    .map((r) => r.body)
    .filter((r) => r.id !== "current" && !!r.start);
}

/** `archon propose`: collect, choose, build, sign, keep, record, and mail. */
export async function proposeCommand(
  host: HostDef,
  o: ProposeOptions,
  deps: {
    sign?: Signer;
    collectFirst?: boolean;
    dir?: string;
    notify?: (ev: Event, host: string) => Promise<string>;
  } = {},
): Promise<number> {
  const dir = deps.dir ?? P.state;
  if (!o.dryRun && !asRoot() && !deps.sign) {
    throw new Error("archon propose signs with the host key, as root (it elevates through sudo)");
  }
  if (deps.collectFirst ?? (!o.dryRun && asRoot())) {
    const { collect } = await import("./collect.ts");
    await collect(host, dir);
  }
  const { loadDrift } = await import("./server.ts");
  const v = await loadDrift(host, dir);
  if (!v.state) throw new Error("nothing collected yet: sudo archon drift --collect");
  const recs = await recordings(host.name, dir);
  const intents = groupItems(v.items, v.observations, recs);
  const { chosen, choices, reason } = choose(v.items, intents, o);
  const files: Record<string, FileEvidence> = {};
  for (const it of chosen.filter((i) => i.kind === "file")) {
    const ev = await hostFileEvidence(it.name, v.birth).catch(() => undefined);
    if (ev) files[it.name] = ev;
  }
  const { loadFleet } = await import("../model/load.ts");
  const base = (await run(["git", "-C", P.repo, "rev-parse", "HEAD"])).stdout.trim();
  const draft = buildProposal({
    host: host.name,
    fleet: (await loadFleet()).id,
    base,
    engine: VERSION,
    at: new Date().toISOString(),
    by: proposer(),
    reason,
    items: chosen,
    choices,
    intents,
    observations: v.observations,
    files,
  });
  if (o.dryRun) {
    stdio.stdout.writeSync(`${o.json ? proposalText(draft) : proposalSummary(draft)}\n`);
    return 0;
  }
  const { proposal, text, sig } = await signProposal(draft, deps.sign ?? keySigner());
  const out = await keep(
    proposal,
    text,
    sig,
    deps.dir ? paths.join(deps.dir, "proposals") : PROPOSALS_DIR,
  );
  const sent: SentProposal = {
    id: proposal.id,
    at: proposal.at,
    by: proposal.by,
    reason: proposal.reason,
    items: proposal.items.map((i) => ({
      key: i.key,
      action: i.action,
      ...(i.until ? { until: i.until } : {}),
    })),
    sent: "queued",
  };
  await endOrTieHolds(host.name, proposal, dir);
  const notify = deps.notify ?? (await import("../notify/events.ts")).notify;
  sent.sent = await notify(
    {
      event: `proposal ${proposal.id}: ${proposal.items.length} item(s) from ${proposal.by}`,
      what: proposalSummary(proposal),
      todo: "Save this message (or both attachments) and run bun run stolos proposal import on it, in the fleet repository on your PC.",
      attach: [out.json, out.sig],
      key: `proposal:${proposal.id}`,
    },
    host.name,
  );
  await putRecord(host.name, "proposal", proposal.id, sent, dir, proposal.at);
  if (o.json)
    stdio.stdout.writeSync(
      `${JSON.stringify({ id: proposal.id, sent: sent.sent, dir: out.dir })}\n`,
    );
  else {
    stdio.stdout.writeSync(`${proposalSummary(proposal)}\n`);
    stdio.stdout.writeSync(
      `\nsigned with ${host.name}'s host key; kept in ${out.dir}; mail: ${sent.sent}\n`,
    );
  }
  return 0;
}

/** Keep the signed files: `<dir>/<id>/proposal.json`, `.sig`, and the summary. */
async function keep(
  p: Proposal,
  text: string,
  sig: string,
  root: string,
): Promise<{ dir: string; json: string; sig: string }> {
  const dir = paths.join(root, p.id);
  await fs.ensureDir(dir);
  const json = paths.join(dir, "proposal.json");
  await fs.writeTextFile(json, text);
  await fs.writeTextFile(json + ".sig", sig);
  await fs.writeTextFile(paths.join(dir, "summary.txt"), proposalSummary(p) + "\n");
  return { dir, json, sig: json + ".sig" };
}

/** A proposed item's hold now waits for its decision; a revert ends it (the model wins now). */
async function endOrTieHolds(host: string, p: Proposal, dir: string): Promise<void> {
  const { getRecord } = await import("../state/store.ts");
  for (const it of p.items.filter((i) => i.managed)) {
    const h = await getRecord<Hold>(host, "hold", it.key, dir);
    if (!h || h.body.ended) continue;
    const next: Hold =
      it.action === "revert"
        ? { ...h.body, proposal: p.id, ended: "reverted", endedAt: p.at }
        : { ...h.body, proposal: p.id };
    await putRecord(host, "hold", it.key, next, dir, h.at);
  }
}
