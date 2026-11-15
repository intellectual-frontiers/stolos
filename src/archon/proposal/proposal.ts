/**
 * Spec 095-proposals: the `stolos-proposal/1` format. A proposal is
 * `proposal.json` (the host, the model commit it ran, who proposed it and
 * why, the change sessions, each item with its action and the structured
 * edits that adopt it, and the observations as evidence) and
 * `proposal.json.sig`, an SSH signature made with the host's own host key
 * (`ssh-keygen -Y sign -n stolos-proposal`). The PC already has that public
 * key in Git (`registration.ts`), so a forged or altered proposal is refused.
 *
 * Everything in it has passed through notify's redaction before it is
 * signed, so the mail cannot change a byte of it (Article 13).
 *
 * ```mermaid
 * sequenceDiagram
 *   participant S as server (root)
 *   participant M as fleet mailbox
 *   participant P as your PC
 *   S->>S: proposal.json (redacted, hashes for secrets)
 *   S->>S: ssh-keygen -Y sign -f ssh_host_ed25519_key -n stolos-proposal
 *   S->>M: archon notify: summary + proposal.json + proposal.json.sig
 *   M->>P: save the message (.eml) or its attachments
 *   P->>P: ssh-keygen -Y verify against registration.ts's host keys
 * ```
 *
 * @module
 */

import { join } from "../core/path.ts";
import { redact } from "../notify/redact.ts";
import {
  type Action,
  type DriftItem,
  type Edit,
  editText,
  type FileEvidence,
  type Intent,
  type Observation,
  type Proposal,
  PROPOSAL_FORMAT,
  PROPOSAL_NAMESPACE,
  type ProposalItem,
} from "./types.ts";

/** What a person chose for one item. */
export interface Choice {
  /** adopt, revert, or local. */
  action: Action;
  /** Local: until this day (ISO). */
  until?: string;
}

/** Everything a proposal is built from. */
export interface ProposalInput {
  /** The host. */
  host: string;
  /** The fleet. */
  fleet: string;
  /** The model commit the host runs. */
  base: string;
  /** The engine's version. */
  engine: string;
  /** When (ISO). */
  at: string;
  /** Who proposes it. */
  by: string;
  /** Why. */
  reason: string;
  /** The items chosen. */
  items: DriftItem[];
  /** The choice for each, by key. */
  choices: Record<string, Choice>;
  /** The change sessions they belong to. */
  intents: Intent[];
  /** Every observation (those the items name are carried). */
  observations: Observation[];
  /** Evidence for file items, by path. */
  files: Record<string, FileEvidence>;
  /** A suffix that makes the id unique (4 hex; random by default). */
  suffix?: string;
}

/** The id of a proposal: `<host>-<yyyymmdd>-<hhmm>-<4 hex>`. */
export function proposalId(host: string, at: string, suffix: string): string {
  const d = at.slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `${host}-${d}-${suffix}`;
}

/** What a person does to revert an item Archon will not undo itself (Article 11), in one line. */
export function revertHint(it: DriftItem): string {
  if (it.managed) return "Stolos converges it back at the next apply (its hold ends now)";
  switch (it.kind) {
    case "package":
      return it.change === "removed"
        ? `sudo apt install ${it.name}`
        : `sudo apt remove ${it.name} (Archon never removes packages itself)`;
    case "snap":
      return `sudo snap remove ${it.name}`;
    case "unit":
      return it.change === "enabled"
        ? `sudo systemctl disable --now ${it.name}`
        : `sudo systemctl unmask ${it.name}; sudo systemctl enable --now ${it.name}`;
    case "file":
      return `restore it from etckeeper: sudo git -C /etc log -- ${
        it.name.replace(/^\/etc\//, "")
      }`;
    case "user":
      return `sudo userdel ${it.name} (Archon never removes accounts itself)`;
    default:
      return "undo it by hand";
  }
}

/** One item of the proposal from a drift item, its choice, and its file's evidence. */
export function proposalItem(
  it: DriftItem,
  choice: Choice,
  intent: string | undefined,
  file?: FileEvidence,
): ProposalItem {
  if (choice.action === "local" && it.managed) {
    throw new Error(
      `${it.key} is managed by ${
        it.spec ?? "the plan"
      }: the model wins, so it is adopted or reverted, not kept local`,
    );
  }
  let edits: Edit[] = [];
  let manual = it.manual;
  if (choice.action === "adopt") {
    edits = it.edits;
    if (it.kind === "file" && it.change !== "deleted") {
      if (file?.content !== undefined) {
        edits = [{
          op: "files.override",
          path: it.name,
          content: file.content,
          mode: file.mode ?? "0644",
          owner: file.owner ?? "root",
          ...(file.group && file.group !== file.owner ? { group: file.group } : {}),
        }];
      } else {
        manual = `its content is not sent (${
          file?.withheld ?? "not readable"
        }): model it by hand (a secret goes to the secret store, never the model)`;
      }
    }
  } else if (choice.action === "revert") manual = revertHint(it);
  return {
    key: it.key,
    kind: it.kind,
    name: it.name,
    change: it.change,
    managed: it.managed,
    action: choice.action,
    ...(choice.action === "local" && choice.until ? { until: choice.until } : {}),
    ...(it.who ? { who: it.who } : {}),
    at: it.at,
    ...(intent ? { intent } : {}),
    edits,
    ...(manual ? { manual } : {}),
    ...(it.flag ? { flag: it.flag } : {}),
    evidence: it.evidence,
    ...(file ? { file } : {}),
  };
}

/** Build a proposal (not signed). */
export function buildProposal(input: ProposalInput): Proposal {
  const suffix = input.suffix ?? crypto.randomUUID().slice(0, 4);
  const intentOf = new Map<string, string>();
  for (const i of input.intents) for (const k of i.items) intentOf.set(k, i.id);
  const items = input.items.map((it) =>
    proposalItem(
      it,
      input.choices[it.key] ?? { action: "adopt" },
      intentOf.get(it.key),
      it.kind === "file" ? input.files[it.name] : undefined,
    )
  );
  const keys = new Set(items.map((i) => i.key));
  const ids = new Set(items.flatMap((i) => i.evidence));
  const intents = input.intents.map((i) => ({ ...i, items: i.items.filter((k) => keys.has(k)) }))
    .filter((i) => i.items.length);
  const from = intents.map((i) => i.from).sort()[0];
  const to = intents.map((i) => i.to).sort().pop();
  // The sudo commands of these sessions are evidence too.
  const observations = input.observations.filter((o) =>
    ids.has(o.id) || (o.source === "sudo" && from && to && o.at >= from && o.at <= to &&
      intents.some((i) => i.commands.includes(o.name)))
  ).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return {
    format: PROPOSAL_FORMAT,
    id: proposalId(input.host, input.at, suffix),
    host: input.host,
    fleet: input.fleet,
    base: input.base,
    engine: input.engine,
    at: input.at,
    by: input.by,
    reason: input.reason,
    intents,
    items,
    observations,
  };
}

/**
 * The exact text that is signed and sent: pretty JSON, redacted until
 * redaction changes nothing (so the mail's own redaction is a no-op).
 */
export function proposalText(p: Proposal): string {
  let text = JSON.stringify(p, null, 2) + "\n";
  for (let i = 0; i < 5; i++) {
    const next = redact(text);
    if (next === text) return text;
    // Keep it JSON: redaction only replaces runs inside strings, but check.
    JSON.parse(next);
    text = next;
  }
  return text;
}

/** Sign text: returns the armored SSH signature. */
export type Signer = (text: string) => Promise<string>;

/** The host's own key (as root): `ssh-keygen -Y sign -f <key> -n stolos-proposal`. */
export const HOST_KEY = "/etc/ssh/ssh_host_ed25519_key";

/** A signer for a private key file, non-interactive (a host key has no passphrase). */
export function keySigner(key: string = HOST_KEY): Signer {
  return async (text) => {
    const dir = await Deno.makeTempDir({ prefix: "archon-proposal-" });
    try {
      const f = join(dir, "proposal.json");
      await Deno.writeTextFile(f, text);
      const r = await new Deno.Command("ssh-keygen", {
        args: ["-q", "-Y", "sign", "-f", key, "-n", PROPOSAL_NAMESPACE, f],
        stdin: "null",
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!r.success) {
        throw new Error(
          `ssh-keygen could not sign with ${key}: ${new TextDecoder().decode(r.stderr).trim()}`,
        );
      }
      return await Deno.readTextFile(f + ".sig");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  };
}

/**
 * Sign a proposal: its text and signature. When redaction would change the
 * signature (a token-like run in its base64; rare), a nonce is added and it is
 * signed again, so nothing in the mail changes either file.
 */
export async function signProposal(
  p: Proposal,
  sign: Signer,
): Promise<{ proposal: Proposal; text: string; sig: string }> {
  let cur = p;
  for (let n = 0; n < 8; n++) {
    const text = proposalText(cur);
    const sig = await sign(text);
    if (redact(sig) === sig) return { proposal: JSON.parse(text), text, sig };
    cur = { ...p, nonce: n + 1 };
  }
  throw new Error("could not make a signature the mail's redaction leaves alone");
}

/** An allowed_signers file for a host's keys: the principal is the host, the namespace stolos-proposal. */
export function allowedSigners(host: string, keys: string[]): string {
  return keys.map((k) =>
    `${host} namespaces="${PROPOSAL_NAMESPACE}" ${k.trim().split(/\s+/).slice(0, 2).join(" ")}`
  )
    .join("\n") + "\n";
}

/** What checking a proposal found. */
export interface Checked {
  /** The proposal, when it could be read. */
  proposal?: Proposal;
  /** Why it is refused; unset when it is good. */
  problem?: string;
}

/**
 * Check a proposal: its format, that its host is in the fleet, and that the
 * signature was made by one of that host's SSH host keys over exactly this
 * text.
 */
export async function verifyProposal(
  text: string,
  sig: string,
  hostKeys: (host: string) => string[] | undefined,
): Promise<Checked> {
  let p: Proposal;
  try {
    p = JSON.parse(text);
  } catch {
    return { problem: "not JSON" };
  }
  if (p?.format !== PROPOSAL_FORMAT) {
    return { problem: `not a ${PROPOSAL_FORMAT} proposal (format: ${String(p?.format)})` };
  }
  if (!p.id || !p.host || !Array.isArray(p.items)) {
    return { problem: "incomplete: no id, host, or items" };
  }
  const keys = hostKeys(p.host);
  if (!keys) return { proposal: p, problem: `${p.host} is not a host of this fleet` };
  if (!keys.length) {
    return { proposal: p, problem: `${p.host} has no SSH host key in registration.ts` };
  }
  const { sshVerify } = await import("../evidence/bundle.ts");
  const v = await sshVerify(text, sig, allowedSigners(p.host, keys), PROPOSAL_NAMESPACE);
  if (!v.signer) {
    return { proposal: p, problem: `the signature is not ${p.host}'s: ${v.reason}` };
  }
  if (v.signer !== p.host) return { proposal: p, problem: `signed as ${v.signer}, not ${p.host}` };
  return { proposal: p };
}

/** The mail's text: who, why, and each item with its action and the edit that adopts it. */
export function proposalSummary(p: Proposal): string {
  const lines = [
    `Proposal ${p.id} from ${p.host}, by ${p.by}`,
    `Reason: ${p.reason}`,
    `Model commit on the host: ${p.base.slice(0, 12) || "unknown"} (engine ${p.engine})`,
    "",
  ];
  for (const i of p.intents) {
    lines.push(
      `${i.id}${i.who ? ` (${i.who})` : ""}, ${i.from.slice(0, 16).replace("T", " ")} UTC${
        i.reason ? `: ${i.reason}` : ""
      }`,
    );
    for (const c of i.commands.slice(0, 20)) lines.push(`  $ sudo ${c}`);
  }
  lines.push("", "Items:");
  for (const it of p.items) {
    lines.push(
      `  ${it.action.padEnd(6)} ${it.key} (${it.change}${it.who ? ` by ${it.who}` : ""}${
        it.managed ? ", managed" : ""
      })${it.until ? ` until ${it.until}` : ""}`,
    );
    for (const e of it.edits) lines.push(`         ${editText(e)}`);
    if (it.manual) lines.push(`         by hand: ${it.manual}`);
    if (it.flag) lines.push(`         flag: ${it.flag}`);
    if (it.file?.withheld) lines.push(`         content not sent: ${it.file.withheld}`);
  }
  lines.push(
    "",
    "To decide on your PC, in the fleet repository: save this message (.eml), or proposal.json and",
    "proposal.json.sig together, then:",
    "  deno task stolos proposal import <the .eml, the .json, or their folder>",
    `  deno task stolos proposal show ${p.id}`,
    `  deno task stolos proposal accept ${p.id}     (or reject)`,
  );
  return lines.join("\n");
}
