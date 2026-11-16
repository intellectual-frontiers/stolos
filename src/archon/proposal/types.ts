/**
 * Spec 095-proposals: the types shared by the server side (`archon drift`,
 * `archon propose`, `archon record`) and the PC side (`stolos proposal ...`):
 * observations, drift items, change sessions, structured model edits, and the
 * signed `stolos-proposal/1` format.
 *
 * @module
 */
// Spec: 095-proposals

import { absurd } from "@intellectual-frontiers/commons/ts/kernel";

/** The spec that brings proposals. */
export const PROPOSAL_SPEC = "095-proposals" as const;

/** The format name and version a proposal carries (`format`). */
export const PROPOSAL_FORMAT = "stolos-proposal/1" as const;

/** The namespace of the host-key signature (`ssh-keygen -Y sign -n ...`). */
export const PROPOSAL_NAMESPACE = "stolos-proposal" as const;

/** How long a hand change to a managed item is held from the reconcile timer (the owner's decision 1). */
export const HOLD_DAYS = 7;

/** How long accepted local drift stays accepted when no date is given. */
export const LOCAL_DAYS = 30;

/** After this many days, unproposed drift or a waiting proposal is mailed as a reminder. */
export const REMIND_DAYS = 3;

/** Where an observation came from. */
export type Source =
  | "sudo"
  | "apt"
  | "dpkg"
  | "etckeeper"
  | "osquery"
  | "units"
  | "snap"
  | "container"
  | "unowned"
  | "verify";

/** What an observation or drift item is about. */
export type SubjectKind =
  | "command"
  | "package"
  | "snap"
  | "unit"
  | "file"
  | "port"
  | "user"
  | "sudoer"
  | "module"
  | "container"
  | "unowned";

/** One thing a collector saw: what changed, who changed it, when, and the source it came from. */
export interface Observation {
  /** A stable id (the same evidence collected twice is one observation). */
  id: string;
  /** The collector that saw it. */
  source: Source;
  /** When it happened (ISO time; when it was first seen, if the source has no time). */
  at: string;
  /** Who did it (a Unix account), when the source says. */
  who?: string;
  /** What it is about. */
  kind: SubjectKind;
  /** Its name: a package, a unit, an absolute path, `tcp/443`, an account. */
  name: string;
  /** What happened to it: installed, removed, enabled, edited, added, ... */
  change: string;
  /** One line for people. */
  what: string;
  /** The evidence as the source recorded it (redacted; never a secret). */
  evidence: string;
}

/** What a drift item is: something the host has that neither the plan nor Ubuntu's own install explains. */
export interface DriftItem {
  /** Its key: `<kind>:<name>` (`package:nginx`, `file:/etc/nginx/sites-available/app`). */
  key: string;
  /** What it is about. */
  kind: SubjectKind;
  /** Its name. */
  name: string;
  /** How it differs: added, removed, enabled, disabled, masked, changed. */
  change: string;
  /** The plan manages it, so archon converges it back (a hand edit is held, spec 095). */
  managed: boolean;
  /** The spec that manages it, when managed. */
  spec?: string;
  /** Who changed it, when known. */
  who?: string;
  /** When it was first seen. */
  at: string;
  /** The observations that show it (ids). */
  evidence: string[];
  /** A constitution flag (Article 5: something no package owns). */
  flag?: string;
  /** The model change that would adopt it, when there is one. */
  edits: Edit[];
  /** Why there is no structured edit, and what a person does instead. */
  manual?: string;
  /** The proposal it is in, if any. */
  proposal?: string;
  /** Accepted local drift: kept until this date (ISO day). */
  localUntil?: string;
  /** Rejected on the PC: managed items revert; anything else stays flagged. */
  rejected?: boolean;
  /** Held from the reconcile timer until this time (ISO). */
  heldUntil?: string;
}

/** A modified package file: a security alert, never a proposal. */
export interface Alert {
  /** The file. */
  path: string;
  /** The package that owns it, when known. */
  package?: string;
  /** When it was first seen. */
  at: string;
  /** The verifier's line. */
  evidence: string;
}

/** A structured model edit: what `stolos proposal accept` writes into the host's TypeScript. */
export type Edit =
  | {
      /** Install a package (apt, or a snap). */
      op: "packages.add";
      /** The package. */
      name: string;
      /** "snap" for a snap; apt otherwise. */
      source?: "snap";
    }
  | {
      /** Enable, disable, or mask a unit Ubuntu ships. */
      op: "units.enable" | "units.disable" | "units.mask";
      /** The unit. */
      unit: string;
    }
  | {
      /** Open a port in the firewall. */
      op: "ports.open";
      /** The port. */
      port: number;
      /** tcp or udp. */
      protocol: "tcp" | "udp";
    }
  | {
      /** Write a file with this content (small, non-secret text only). */
      op: "files.override";
      /** Its absolute path. */
      path: string;
      /** Its content. */
      content: string;
      /** Its mode ("0644"). */
      mode: string;
      /** Its owner. */
      owner: string;
      /** Its group. */
      group?: string;
    };

/** An edit as one line people read: `packages.add("nginx")`. */
export function editText(e: Edit): string {
  switch (e.op) {
    case "packages.add":
      return `packages.add(${JSON.stringify(e.name)}${e.source ? `, { source: "snap" }` : ""})`;
    case "ports.open":
      return `ports.open(${e.port}, ${JSON.stringify(e.protocol)})`;
    case "files.override":
      return `files.override(${JSON.stringify(e.path)}, { mode: ${JSON.stringify(e.mode)}, owner: ${JSON.stringify(
        e.owner,
      )}, ${e.content.length} bytes })`;
    case "units.enable":
    case "units.disable":
    case "units.mask":
      return `${e.op}(${JSON.stringify(e.unit)})`;
    default:
      return absurd(e);
  }
}

/** A change session: observations grouped by sudo session (one user, one stretch of time) into one intent. */
export interface Intent {
  /** Its id: `s-<user>-<start>` for a sudo session, `r-<start>` for a recording. */
  id: string;
  /** Who, when known. */
  who?: string;
  /** When it started (ISO). */
  from: string;
  /** When it ended (ISO). */
  to: string;
  /** The commands typed under sudo in it. */
  commands: string[];
  /** The drift items it explains (keys). */
  items: string[];
  /** The reason a person stated (`archon record "..."`). */
  reason?: string;
}

/** What a person chose for one item: put it in the model, let Stolos converge it back, or keep it here. */
export type Action = "adopt" | "revert" | "local";

/** A file's evidence in a proposal: its hash always, its content only when small, text, and not secret. */
export interface FileEvidence {
  /** Its absolute path. */
  path: string;
  /** SHA-256 of its content (hex). */
  sha256: string;
  /** Its size in bytes. */
  size: number;
  /** Its mode ("0644"). */
  mode?: string;
  /** Its owner. */
  owner?: string;
  /** Its group. */
  group?: string;
  /** Its content, when sent. */
  content?: string;
  /** Why its content is not sent (a secret, too large, binary). */
  withheld?: string;
  /** The etckeeper diff since the birth snapshot, when the content is sent. */
  diff?: string;
}

/** One item of a proposal. */
export interface ProposalItem {
  /** The drift item's key. */
  key: string;
  /** What it is about. */
  kind: SubjectKind;
  /** Its name. */
  name: string;
  /** How it differs. */
  change: string;
  /** The plan manages it. */
  managed: boolean;
  /** The person's choice. */
  action: Action;
  /** Accepted local drift: until this day (ISO). */
  until?: string;
  /** Who changed it, when known. */
  who?: string;
  /** When it was first seen. */
  at: string;
  /** The change session it belongs to. */
  intent?: string;
  /** The model change that adopts it (adopt only; empty when there is none). */
  edits: Edit[];
  /** Why there is no structured edit, and what a person does instead. */
  manual?: string;
  /** A constitution flag. */
  flag?: string;
  /** The observations that show it (ids, in `observations`). */
  evidence: string[];
  /** For a file: its hash, and its content when allowed. */
  file?: FileEvidence;
}

/** `proposal.json`: what a server sends, signed with its SSH host key. */
export interface Proposal {
  /** Always {@link PROPOSAL_FORMAT}. */
  format: typeof PROPOSAL_FORMAT;
  /** Its id: `<host>-<yyyymmdd>-<hhmm>-<4 hex>`. */
  id: string;
  /** The host that made it (and signed it). */
  host: string;
  /** The fleet. */
  fleet: string;
  /** The model commit the host ran when it was made. */
  base: string;
  /** The engine's version on the host. */
  engine: string;
  /** When it was made (ISO). */
  at: string;
  /** Who proposed it (the person behind sudo). */
  by: string;
  /** Why: the written reason (required). */
  reason: string;
  /** The change sessions it covers. */
  intents: Intent[];
  /** The items, each with its action. */
  items: ProposalItem[];
  /** The observations, as evidence (redacted). */
  observations: Observation[];
  /** Changed until the signature survives the mail's redaction unchanged (rarely needed). */
  nonce?: number;
}

/** What operators decided about one proposal, in Git (`fleets/<fleet>/hosts/<host>/proposals.ts`). */
export type ProposalDecision = {
  /** accepted or rejected. */
  decision: "accepted" | "rejected";
  /** Who decided. */
  by: string;
  /** When (ISO). */
  at: string;
  /** The reason given (rejections). */
  reason?: string;
  /** The draft spec an acceptance wrote. */
  spec?: string;
  /** Items adopted into the model (keys). */
  adopted?: string[];
  /** Items kept as accepted local drift, each until a day. */
  local?: Array<{ key: string; until: string }>;
  /** Items skipped at acceptance (named conflicts), left flagged. */
  skipped?: string[];
};

/** Every decision about a host's proposals, by proposal id. */
export type ProposalDecisions = Record<string, ProposalDecision>;
