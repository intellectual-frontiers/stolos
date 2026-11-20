/**
 * Spec 072: evidence bundles. One ZIP holds a period's evidence (the
 * observations as Git recorded them, the verify results, the commits with
 * their signatures, and the OSCAL assessment results), each item stored
 * under its own SHA-256 (content-addressed), listed in a manifest in order,
 * each entry chained to the one before (a hash chain), and the manifest
 * signed by a fleet signer's key (`ssh-keygen -Y sign`, namespace
 * `stolos-evidence`). An auditor re-checks it offline: every item unchanged,
 * none missing or added, the chain whole, the manifest signed by a signer,
 * and each commit signed as Git signs it.
 *
 * ```mermaid
 * flowchart LR
 *   items["items: observations, verify, commits, OSCAL"] --> objects["objects/&lt;sha256&gt;"]
 *   objects --> manifest["manifest.json: each item's SHA-256, chained"]
 *   manifest --> sig["manifest.json.sig (a fleet signer)"]
 *   sig --> verify["stolos evidence verify: offline, with the reason for any failure"]
 * ```
 *
 * The ZIP also holds `allowed_signers` (the fleet's signers when it was
 * made) and a README saying how to check it with `sha256sum` and
 * `ssh-keygen` alone. The signers in a bundle vouch for themselves: an
 * auditor who has the fleet's signers from elsewhere passes them with
 * `--signers`.
 *
 * Built on IFC TypeScript: SHA-256 and the ZIP (deflated) are the kernel's,
 * signing is runtime `sign.sshSigner` and checking a signature runtime
 * `sign.sshVerifier`, both `ssh-keygen -Y` in the namespace `stolos-evidence`.
 *
 * @module
 */
// Spec: 072-evidence-bundles

import {
  array,
  type Decoder,
  err,
  formatDecodeError,
  integer,
  json,
  literal,
  mapDecoder,
  object,
  type Result,
  string,
} from "@intellectual-frontiers/core";
import { sha256 } from "@intellectual-frontiers/crypto";
import { unzip, zipDeflated } from "@intellectual-frontiers/formats";
import { fs, path } from "@intellectual-frontiers/system";
import { sign } from "@intellectual-frontiers/grc/host";
import { run } from "../core/exec.ts";

/** The bundle format. */
export const BUNDLE_FORMAT = "stolos-evidence/1";

/** The ssh-keygen namespace bundle signatures are made in (never "git": a bundle is not a commit). */
export const NAMESPACE = "stolos-evidence";

/** What an item is. */
export type ItemKind =
  | "observation"
  | "verify"
  | "commit"
  | "oscal"
  | "signers"
  // Spec 077: an access review as committed (its approving commit is a "commit" item).
  | "people"
  // Spec 081: a Trust Center's public summary (one control, or the index), redacted.
  | "summary";

/** One item, before it is stored. */
export interface Item {
  /** What it is. */
  kind: ItemKind;
  /** Its name for people (a path, a commit). */
  name: string;
  /** When it was recorded (ISO time). */
  at: string;
  /** Its bytes. */
  content: Uint8Array;
}

/** One item in the manifest. */
export interface ManifestItem {
  /** What it is. */
  kind: ItemKind;
  /** Its name for people. */
  name: string;
  /** When it was recorded. */
  at: string;
  /** Its SHA-256: its object is objects/<sha256>. */
  sha256: string;
  /** Its size in bytes. */
  size: number;
  /** The chain so far: SHA-256 of the previous entry's chain and this entry. */
  chain: string;
}

/** The manifest: what the signature covers. */
export interface Manifest {
  /** BUNDLE_FORMAT. */
  format: string;
  /** The fleet. */
  fleet: { id: string; title: string; repo: string };
  /** The period (ISO dates, both included). */
  period: { from: string; to: string };
  /** When it was made. */
  created: string;
  /** The Stolos version that made it. */
  stolos: string;
  /** Who signed it (their name in signers.ts). */
  signer: string;
  /** Evidence that could not be included, and why. */
  omitted: string[];
  /** The items, in order. */
  items: ManifestItem[];
  /** The last entry's chain (the genesis when there are none). */
  head: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The chain's start: the format, the fleet, and the period. */
export function genesis(m: Pick<Manifest, "fleet" | "period">): Promise<string> {
  return sha256(`${BUNDLE_FORMAT}\n${m.fleet.id}\n${m.period.from}\n${m.period.to}\n`);
}

/** One link of the chain. */
export function link(prev: string, i: Omit<ManifestItem, "chain">): Promise<string> {
  return sha256(`${prev}\n${i.sha256}\n${i.size}\n${i.kind}\n${i.name}\n${i.at}\n`);
}

/** The manifest for the items (in the order given). */
export async function manifestFor(
  items: Item[],
  m: Omit<Manifest, "format" | "items" | "head">,
): Promise<Manifest> {
  let prev = await genesis(m);
  const out: ManifestItem[] = [];
  for (const i of items) {
    const e = {
      kind: i.kind,
      name: i.name,
      at: i.at,
      sha256: await sha256(i.content),
      size: i.content.length,
    };
    prev = await link(prev, e);
    out.push({ ...e, chain: prev });
  }
  return { format: BUNDLE_FORMAT, ...m, items: out, head: prev };
}

/** The README inside a bundle: how to check it without Stolos. */
export function bundleReadme(m: Manifest): string {
  return `Evidence for ${m.fleet.title} (${m.fleet.id}), ${m.period.from} to ${m.period.to}
Made ${m.created} by Stolos ${m.stolos}; signed by ${m.signer}.

Check it with Stolos (offline):
  bun run stolos evidence verify <this zip> [--signers <the fleet's allowed_signers>]

Or by hand, in the unzipped folder:
  1. Each file in objects/ is named by its SHA-256:  sha256sum objects/*
  2. manifest.json lists each item's SHA-256, in order, each entry chained to the one
     before: chain = sha256("<previous chain>\\n<sha256>\\n<size>\\n<kind>\\n<name>\\n<at>\\n"),
     starting from sha256("${BUNDLE_FORMAT}\\n<fleet id>\\n<from>\\n<to>\\n").
  3. The manifest's signature:
     ssh-keygen -Y find-principals -s manifest.json.sig -f allowed_signers
     ssh-keygen -Y verify -f allowed_signers -I <that name> -n ${NAMESPACE} -s manifest.json.sig < manifest.json
  4. Each commit object carries its own SSH signature (Git's), in the namespace "git".

The allowed_signers here are the fleet's own when the bundle was made: they vouch for
themselves. Compare them with the fleet's signers you have from elsewhere.
`;
}

/** The bundle's bytes (a ZIP, deflated), from its items, manifest, signature, and allowed signers. */
export function packBundle(
  items: Item[],
  m: Manifest,
  signature: string,
  allowedSigners: string,
): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(manifestText(m))],
    ["manifest.json.sig", enc.encode(signature)],
    ["allowed_signers", enc.encode(allowedSigners)],
    ["README.txt", enc.encode(bundleReadme(m))],
  ]);
  for (const [k, it] of items.entries()) {
    const entry = m.items[k];
    if (entry) files.set(`objects/${entry.sha256}`, it.content);
  }
  return zipDeflated(files);
}

const ITEM_KINDS = [
  "observation",
  "verify",
  "commit",
  "oscal",
  "signers",
  "people",
  "summary",
] as const satisfies readonly ItemKind[];

const manifestDecoder: Decoder<Manifest> = mapDecoder(
  object({
    format: string,
    fleet: object({ id: string, title: string, repo: string }),
    period: object({ from: string, to: string }),
    created: string,
    stolos: string,
    signer: string,
    omitted: array(string),
    items: array(
      object({
        kind: literal(...ITEM_KINDS),
        name: string,
        at: string,
        sha256: string,
        size: integer,
        chain: string,
      }),
    ),
    head: string,
  }),
  (m): Manifest => ({
    ...m,
    fleet: { ...m.fleet },
    period: { ...m.period },
    omitted: [...m.omitted],
    items: m.items.map((i) => ({ ...i })),
  }),
);

/** A manifest from its text, or why it is not one. */
export function parseManifest(text: string): Result<Manifest, string> {
  const r = json(text, manifestDecoder);
  return r.kind === "ok"
    ? r
    : err(`manifest.json is not a manifest: ${formatDecodeError(r.error)}`);
}

/** The manifest exactly as it is signed. */
export function manifestText(m: Manifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

/** Sign text with an SSH key (ssh-keygen -Y sign; it asks the key's passphrase in this terminal). */
export type Signer = (text: string) => Promise<string>;

/** A Signer by ssh-keygen with this key file (runtime `sign.sshSigner`); ssh-keygen asks its passphrase at the terminal. */
export function sshSigner(key: string): Signer {
  const signer = sign.sshSigner({ keyFile: key, namespace: NAMESPACE });
  return async (text) => {
    const r = await signer.sign(enc.encode(text));
    if (r.kind === "err") {
      throw new Error(`ssh-keygen could not sign with ${key}: ${sign.formatSignError(r.error)}`);
    }
    return dec.decode(r.value.sig);
  };
}

/** What `verify` found. */
export interface VerifyResult {
  /** True when nothing is wrong. */
  ok: boolean;
  /** Each problem, with its reason. */
  problems: string[];
  /** The manifest, when it could be read. */
  manifest?: Manifest;
  /** Who signed the manifest, when the signature verified. */
  signer?: string;
  /** Commits whose Git signature verified, and by whom. */
  commits: Array<{ name: string; signer?: string }>;
}

/** Who signed `text` with `sig`, by the allowed signers in `namespace`, or the reason it fails. */
export function sshVerify(
  text: string | Uint8Array,
  sig: string,
  allowedSigners: string,
  namespace: string,
): Promise<{ signer?: string; reason?: string }> {
  return fs.withTempDir(
    async (dir) => {
      const s = path.join(dir, "sig");
      const a = path.join(dir, "allowed");
      await fs.writeTextFile(s, sig);
      await fs.writeTextFile(a, allowedSigners);
      const who = await run(["ssh-keygen", "-Y", "find-principals", "-s", s, "-f", a]);
      const names = who.stdout
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      if (!who.ok || !names.length) {
        return { reason: "signed by a key that is not an allowed signer" };
      }
      const message = typeof text === "string" ? enc.encode(text) : text;
      for (const identity of names) {
        const v = await sign
          .sshVerifier({ allowedSignersFile: a, identity, namespace })
          .verify(message, enc.encode(sig));
        if (v.kind === "ok" && v.value) return { signer: identity };
      }
      return { reason: "the signature does not match the signed text (changed after signing)" };
    },
    { prefix: "stolos-verify-" },
  );
}

/** A raw Git commit object split into what Git signed and its SSH signature. */
export function commitSignature(raw: string): { payload: string; signature?: string } {
  const lines = raw.split("\n");
  const out: string[] = [];
  const sig: string[] = [];
  let inSig = false,
    inHeaders = true;
  for (const l of lines) {
    if (inHeaders && l === "") inHeaders = false;
    if (inHeaders && l.startsWith("gpgsig ")) {
      inSig = true;
      sig.push(l.slice(7));
      continue;
    }
    if (inSig && l.startsWith(" ")) {
      sig.push(l.slice(1));
      continue;
    }
    inSig = false;
    out.push(l);
  }
  const s = sig.join("\n");
  return {
    payload: out.join("\n"),
    ...(s.includes("SSH SIGNATURE") ? { signature: s + "\n" } : {}),
  };
}

/**
 * Allowed signers for one namespace: every key line gets namespaces="<ns>",
 * so the fleet's Git allowed_signers (namespaces="git") check a bundle too.
 */
export function forNamespace(allowed: string, ns: string): string {
  return allowed
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (!t || t.startsWith("#")) return l;
      const parts = t.split(/\s+/);
      const isKey = (x: string) => /^(ssh-|sk-|ecdsa-)/.test(x);
      const k = parts.findIndex((x, i) => i > 0 && isKey(x));
      if (k < 1) return l;
      return [parts[0], `namespaces="${ns}"`, ...parts.slice(k)].join(" ");
    })
    .join("\n");
}

/** Check a bundle, offline; `allowedSigners` replaces the bundle's own when given. */
export async function verifyBundle(
  zip: Uint8Array,
  o: { allowedSigners?: string } = {},
): Promise<VerifyResult> {
  const problems: string[] = [];
  const commits: VerifyResult["commits"] = [];
  const unzipped = await unzip(zip);
  if (unzipped.kind === "err") {
    return { ok: false, problems: [`not a ZIP: ${unzipped.error.kind}`], commits };
  }
  const files = unzipped.value;
  const raw = files.get("manifest.json");
  const text = raw ? dec.decode(raw) : undefined;
  if (!text) return { ok: false, problems: ["no manifest.json"], commits };
  const parsed = parseManifest(text);
  if (parsed.kind === "err") return { ok: false, problems: [parsed.error], commits };
  const m = parsed.value;
  if (m.format !== BUNDLE_FORMAT) {
    return {
      ok: false,
      problems: [`format ${m.format}, not ${BUNDLE_FORMAT}`],
      manifest: m,
      commits,
    };
  }
  // 1. The signature over the manifest.
  const bundled = files.get("allowed_signers");
  const allowed = o.allowedSigners ?? (bundled ? dec.decode(bundled) : "");
  const signature = files.get("manifest.json.sig");
  let signer: string | undefined;
  if (!signature) {
    problems.push("the manifest is not signed (no manifest.json.sig)");
  } else if (!allowed.trim()) problems.push("no allowed signers to check the signature with");
  else {
    const v = await sshVerify(
      text,
      dec.decode(signature),
      forNamespace(allowed, NAMESPACE),
      NAMESPACE,
    );
    if (v.signer) signer = v.signer;
    else problems.push(`the manifest's signature: ${v.reason}`);
  }
  // 2. Every item, and the chain.
  let prev = await genesis(m);
  const listed = new Set<string>();
  for (const it of m.items ?? []) {
    const path = `objects/${it.sha256}`;
    listed.add(path);
    const { chain, ...entry } = it;
    prev = await link(prev, entry);
    if (prev !== chain) {
      problems.push(
        `${it.kind} ${it.name}: the chain breaks here (an entry was changed, removed, or reordered)`,
      );
    }
    const b = files.get(path);
    if (!b) {
      problems.push(`${it.kind} ${it.name}: missing (no ${path})`);
      continue;
    }
    const got = await sha256(b);
    if (got !== it.sha256 || b.length !== it.size) {
      problems.push(
        `${it.kind} ${it.name}: changed (SHA-256 ${got}, the manifest says ${it.sha256})`,
      );
      continue;
    }
    if (it.kind === "commit") {
      const c = commitSignature(dec.decode(b));
      if (!c.signature) {
        problems.push(`${it.kind} ${it.name}: not signed`);
        commits.push({ name: it.name });
        continue;
      }
      const v = await sshVerify(c.payload, c.signature, forNamespace(allowed, "git"), "git");
      if (v.signer) commits.push({ name: it.name, signer: v.signer });
      else {
        problems.push(`${it.kind} ${it.name}: its Git signature: ${v.reason}`);
        commits.push({ name: it.name });
      }
    }
  }
  if (prev !== m.head) {
    problems.push("the manifest's head is not the end of its chain (items were cut off)");
  }
  for (const f of files.keys()) {
    if (f.startsWith("objects/") && !listed.has(f)) {
      problems.push(`${f}: in the bundle, not in the manifest`);
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    manifest: m,
    ...(signer ? { signer } : {}),
    commits,
  };
}
