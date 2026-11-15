/**
 * Spec 065: the Archon Console's real dependencies on a server: PAM, the
 * system's accounts, the runner, the checkout of the fleet repository (the
 * commit applied now, who signed it, the engine it pins), the activity record,
 * and the served guides.
 *
 * @module
 */

import { engineFileOr } from "../core/assets.ts";
import { run } from "../core/exec.ts";
import { readTextOr } from "../core/fsx.ts";
import { join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { markdownToHtml } from "../web/markdown.ts";
import type { ActivityEntry, RepoFacts } from "./pages.ts";

/** Where the console keeps its activity record (its StateDirectory). */
export const ACTIVITY_FILE = "/var/lib/archon-console/activity.jsonl";

/** The checkout this server applies: the commit, its signer (as servers check it), the engine, the signers. */
export async function repoFacts(repo = P.repo): Promise<RepoFacts> {
  const git = (args: string[]) => run(["git", "-c", `safe.directory=${repo}`, "-C", repo, ...args]);
  const log = await git(["log", "-1", "--format=%h%x09%s%x09%an%x09%cI"]);
  const [sha, subject, author, at] = log.stdout.trim().split("\t");
  const v = await git([
    "-c",
    "gpg.format=ssh",
    "-c",
    "gpg.ssh.allowedSignersFile=/etc/archon/allowed_signers",
    "verify-commit",
    "--raw",
    "HEAD",
  ]);
  const signer = (v.stderr + v.stdout).match(/Good "git" signature for (\S+) with/)?.[1];
  const { readPin } = await import("../fleet/upgrade.ts");
  const pin = readPin((await readTextOr(join(repo, "deno.json"))) ?? "");
  let signers: RepoFacts["signers"] = [];
  try {
    const { loadSigners } = await import("../identity/signers.ts");
    signers = (await loadSigners()).map((s) => ({ name: s.name, role: s.role }));
  } catch { /* no signers.ts: none shown */ }
  return {
    ...(log.ok && sha ? { commit: { sha, subject, author, at } } : {}),
    ...(signer ? { signer } : {}),
    ...(pin ? { engine: pin.tag } : {}),
    signers,
  };
}

/** The activity record: one JSON line per sign-in or run, appended. */
export function activityLog(file = ACTIVITY_FILE): {
  add(e: ActivityEntry): Promise<void>;
  recent(n: number): Promise<ActivityEntry[]>;
} {
  return {
    async add(e) {
      try {
        await Deno.writeTextFile(file, JSON.stringify(e) + "\n", { append: true, create: true });
      } catch { /* the record is best effort; the journal has the run too */ }
      console.log(`${e.kind}: ${e.user} from ${e.from}${e.detail ? `: ${e.detail}` : ""}`);
    },
    async recent(n) {
      const lines = ((await readTextOr(file)) ?? "").trim().split("\n").filter(Boolean);
      return lines.slice(-n).reverse().flatMap((l) => {
        try {
          return [JSON.parse(l) as ActivityEntry];
        } catch {
          return [];
        }
      });
    },
  };
}

/** A served guide's body as HTML (docs/<name>.md), or undefined when it is not served. */
export async function guideBody(
  name: string,
  guides: Array<{ name: string }>,
  repoSlug: string,
): Promise<string | undefined> {
  if (!guides.some((g) => g.name === name)) return undefined;
  const md = engineFileOr(`docs/${name}.md`);
  if (!md) return undefined;
  return await Promise.resolve(markdownToHtml(md, {
    served: guides.map((g) => g.name),
    repoBlob: `https://github.com/${repoSlug}/blob/main/`,
  }));
}
