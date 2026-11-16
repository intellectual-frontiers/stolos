/**
 * Spec 081: `stolos trust build --bundle <zip>`: verify an evidence bundle,
 * then write a Trust Center from it: `index.html`, and under `evidence/` the
 * bundle it links to (the full one when gated; a signed public summary when
 * public), unpacked so that each claim's link is the item itself.
 *
 * ```mermaid
 * flowchart LR
 *   zip["--bundle"] --> v{"verifyBundle"}
 *   v -- "a problem" --> refuse["refused, with each reason"]
 *   v -- "ok" --> model["trustModel"] --> page["index.html"]
 *   model -- "--public" --> sum["summary bundle, signed (--key)"] --> ev["evidence/"]
 *   model -- "--gated" --> ev
 * ```
 *
 * @module
 */
// Spec: 081-trust-center

import { errors, fs, path, toError } from "@intellectual-frontiers/commons/ts/runtime";
import { ui } from "../core/ui.ts";
import { type Signer, sshSigner, verifyBundle } from "../evidence/bundle.ts";
import type { ScfCatalog } from "../compliance/catalog.ts";
import { type FrameworkId, FRAMEWORKS } from "../compliance/scf.ts";
import { type TrustModel, trustModel } from "./model.ts";
import { summaryBundle, unpacked } from "./publish.ts";
import { EVIDENCE_DIR, trustPage } from "./site.ts";

const enc = new TextEncoder();

/** The file a Trust Center's output folder holds, so a rebuild may replace it (and nothing else). */
export const MARKER = ".stolos-trust";

/** How to build a Trust Center. */
export interface TrustOptions {
  /** Public (the default: redacted, a summary bundle) or gated (everything, the full bundle). */
  mode?: "public" | "gated";
  /** Public: sign the summary bundle (as the full bundle's signer). Absent: the evidence is on request. */
  sign?: Signer;
  /** An allowed_signers text to verify the bundle with instead of its own. */
  allowedSigners?: string;
  /** The SCF catalog (only the release the bundle names is used). */
  catalog?: ScfCatalog;
  /** The frameworks to show (default: every one the mappings reach). */
  frameworks?: FrameworkId[];
  /** The company's link for questions and access requests (https: or mailto:). */
  contact?: string;
  /** When the page is built. */
  now?: Date;
  /** The Stolos version building it. */
  stolos?: string;
}

/** A Trust Center, built, or why not. */
export type TrustSite =
  | { ok: false; problems: string[] }
  | { ok: true; model: TrustModel; files: Record<string, Uint8Array> };

/** Whether a link is one the company may put on its page: https: or mailto:. */
export function isContact(s: string): boolean {
  return /^https:\/\/[^\s"<>]+$/.test(s) || /^mailto:[^\s"<>]+$/.test(s);
}

/** Parse --frameworks (soc2,hipaa), or throw naming the unknown one. */
export function parseFrameworks(s: string | undefined): FrameworkId[] | undefined {
  if (!s) return undefined;
  const ids = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!FRAMEWORKS.some((f) => f.id === id)) {
      throw new Error(`${id}: not a framework (one of ${FRAMEWORKS.map((f) => f.id).join(", ")})`);
    }
  }
  return ids as FrameworkId[];
}

/** Verify the bundle, then build its Trust Center's files (index.html and evidence/...). */
export async function buildTrustSite(
  zip: Uint8Array,
  fileName: string,
  o: TrustOptions = {},
): Promise<TrustSite> {
  const mode = o.mode ?? "public";
  if (o.contact && !isContact(o.contact)) {
    return { ok: false, problems: [`--contact ${o.contact}: an https: or mailto: link`] };
  }
  const verified = await verifyBundle(
    zip,
    o.allowedSigners ? { allowedSigners: o.allowedSigners } : {},
  );
  if (!verified.ok) return { ok: false, problems: verified.problems };
  const now = o.now ?? new Date();
  const stolos = o.stolos ?? (await import("../version.ts")).VERSION;
  let model: TrustModel;
  try {
    model = await trustModel({
      zip,
      fileName,
      verified,
      now,
      ...(o.catalog ? { catalog: o.catalog } : {}),
      ...(o.frameworks ? { frameworks: o.frameworks } : {}),
    });
  } catch (e) {
    return { ok: false, problems: [toError(e).message] };
  }
  const files: Record<string, Uint8Array> = {};
  let published: Parameters<typeof trustPage>[1]["published"];
  const publish = async (name: string, bytes: Uint8Array): Promise<void> => {
    files[`${EVIDENCE_DIR}/${name}`] = bytes;
    for (const [p, b] of Object.entries(await unpacked(bytes))) files[`${EVIDENCE_DIR}/${p}`] = b;
  };
  if (mode === "gated") {
    await publish(fileName, zip);
    published = {
      zip: fileName,
      items: verified.manifest?.items ?? [],
      signer: verified.signer ?? "",
    };
  } else if (o.sign) {
    try {
      const s = await summaryBundle(model, zip, o.sign, { stolos, now });
      const name = `${model.fleetId}-trust-summary-${model.period.from}-to-${model.period.to}.zip`;
      await publish(name, s.zip);
      published = { zip: name, items: s.manifest.items, signer: model.signer };
    } catch (e) {
      return { ok: false, problems: [toError(e).message] };
    }
  }
  const page = await trustPage(model, {
    mode,
    stolos,
    ...(published ? { published } : {}),
    ...(o.contact ? { contact: o.contact } : {}),
  });
  files["index.html"] = enc.encode(page);
  files[MARKER] = enc.encode(
    `Written by stolos trust build (${mode}) from ${fileName}, ${model.asOf}. A rebuild replaces this folder.\n`,
  );
  return { ok: true, model, files };
}

async function emptyOrOurs(dir: string): Promise<boolean> {
  if (await fs.exists(path.join(dir, MARKER))) return true;
  try {
    for await (const _ of fs.readDir(dir)) return false;
  } catch {
    // It does not exist yet.
  }
  return true;
}

/** The signing key: --key, else Git's signing key's daily key. */
async function signingKey(key?: string): Promise<string> {
  if (key) return key;
  const { run } = await import("../core/exec.ts");
  const { P } = await import("../core/paths.ts");
  const { keyPaths } = await import("../identity/keys.ts");
  return keyPaths((await run(["git", "-C", P.repo, "config", "user.signingkey"])).stdout.trim())
    .daily;
}

/** `stolos trust build`: verify, build, and write the Trust Center; exit 1 with the reason when refused. */
export async function trustBuild(o: {
  bundle: string;
  out?: string;
  frameworks?: string;
  public?: boolean;
  gated?: boolean;
  onRequest?: boolean;
  key?: string;
  signers?: string;
  contact?: string;
  catalog?: ScfCatalog | null;
  sign?: Signer;
  now?: Date;
}): Promise<number> {
  const p = ui.phase("Trust Center");
  if (o.public && o.gated) {
    p.fail("--public or --gated, not both");
    return 1;
  }
  const mode = o.gated ? "gated" : "public";
  if (o.onRequest && mode === "gated") {
    p.fail("--on-request is for a public build (a gated one publishes the bundle)");
    return 1;
  }
  let frameworks: FrameworkId[] | undefined;
  try {
    frameworks = parseFrameworks(o.frameworks);
  } catch (e) {
    p.fail(toError(e).message);
    return 1;
  }
  let zip: Uint8Array;
  try {
    zip = await fs.readFile(o.bundle);
  } catch (e) {
    p.fail(`${o.bundle}: ${toError(e).message}`);
    return 1;
  }
  const catalog =
    o.catalog === null
      ? undefined
      : (o.catalog ?? (await (await import("../compliance/catalog.ts")).loadScf()));
  const fileName = o.bundle.split(/[\\/]/).pop() ?? o.bundle;
  let sign = o.sign;
  if (mode === "public" && !o.onRequest && !sign) {
    const key = await signingKey(o.key);
    p.note(`signing the public summary with ${key}: ssh-keygen asks your key's passphrase`);
    sign = sshSigner(key);
  }
  const site = await buildTrustSite(zip, fileName, {
    mode,
    ...(sign && !o.onRequest ? { sign } : {}),
    ...(o.signers ? { allowedSigners: await fs.readTextFile(o.signers) } : {}),
    ...(catalog ? { catalog } : {}),
    ...(frameworks ? { frameworks } : {}),
    ...(o.contact ? { contact: o.contact } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  if (!site.ok) {
    for (const x of site.problems) p.warn(x);
    p.fail(`refused: ${site.problems.length} problem(s); no Trust Center was written`);
    return 1;
  }
  const { P } = await import("../core/paths.ts");
  const out = o.out ?? path.join(P.state, "trust", mode);
  if (!(await emptyOrOurs(out))) {
    p.fail(`${out} holds other files: give an empty folder, or one a Trust Center was built in`);
    return 1;
  }
  try {
    await fs.remove(out, { recursive: true });
  } catch (e) {
    if (!(e instanceof errors.NotFound)) throw e;
  }
  for (const [rel, bytes] of Object.entries(site.files)) {
    const f = path.join(out, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, bytes);
  }
  const m = site.model;
  const failing = m.controls.filter((c) => c.status === "fail").length;
  const stale = m.controls.filter((c) => c.counts.stale).length;
  p.ok(
    `${m.company}, ${m.period.from} to ${m.period.to}, signed by ${m.signer}: ${
      m.frameworks.map((f) => f.short).join(", ") || "no framework"
    }; ${failing} control(s) failing, ${stale} with stale evidence`,
  );
  if (m.bundleStale) {
    p.warn(`the bundle is older than ${m.maxAgeDays} days: the page says every status is stale`);
  }
  for (const u of m.unavailable) {
    const msg = `${u.id} not shown: ${u.reason}`;
    if (m.scf.mappings === "catalog") p.note(msg);
    else p.warn(msg);
  }
  p.done(path.join(out, "index.html"));
  ui.next.push(
    mode === "gated"
      ? "host it behind your own access (the trust guide: bun run stolos docs trust)"
      : "publish the folder as it is (any static host); it makes no requests",
  );
  return 0;
}
