// `archon dotfiles [path] [--user <u>]` (spec 031): which layer provides each
// of a user's dotfiles on this host. Read-only; reads only the repository.

import { P } from "../core/paths.ts";
import { exists } from "../core/fsx.ts";
import { join } from "../core/path.ts";
import { currentUser } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { composedDir } from "./layers.ts";
import { composeFrom } from "./sync.ts";

export async function dotfilesReport(
  host: string,
  user = currentUser(),
  path?: string,
): Promise<number> {
  const c = await composeFrom(P.repo, host, user);
  const p = ui.phase(`Dotfiles of ${user} on ${host}`);
  for (const l of c.layers) {
    const n = c.files.filter((f) => f.layer.dir === l.dir).length;
    const there = l.kind === "engine" || await exists(join(P.repo, l.dir));
    console.log(
      `  ${there ? "●" : "○"} ${l.dir.padEnd(44)} ${there ? `${n} file(s) win here` : "(none)"}`,
    );
  }
  for (const pr of c.problems) p.fail(pr, "fix the file in the repository, then archon build");
  if (path) {
    const t = path.replace(/^~\//, "").replace(/^\$HOME\//, "").replace(/^\.\//, "");
    const f = c.files.find((x) => x.target === t);
    if (!f) {
      p.done(`~/${t} is not managed: it is yours, and archon leaves it alone`);
      return 0;
    }
    console.log(`\n  ~/${t}\n    from   ${f.from}\n    layer  ${f.layer.kind}`);
    p.done(`edit ${f.from} (or add it to a more specific layer), commit, push`);
    return c.problems.length ? 1 : 0;
  }
  console.log("");
  for (const f of c.files) {
    if (f.target.startsWith(".chezmoi")) continue;
    console.log(`  ~/${f.target.padEnd(40)} ${f.layer.kind.padEnd(9)} ${f.from}`);
  }
  p.done(
    `${c.files.length} file(s) · composed source ${composedDir(user)} · man archon-dotfiles`,
  );
  return c.problems.length ? 1 : 0;
}
