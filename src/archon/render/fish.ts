/**
 * fish completions generated from the command registry (Article VI).
 *
 * @module
 */

import { type Command, GLOBAL_ARGS } from "../core/registry-types.ts";

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function renderFishCompletions(commands: Command[]): string {
  const L = [
    "# Rendered by archon from spec 010-archon-cli. Do not edit.",
    "complete -c archon -f",
  ];
  const groups = new Map<string, Command[]>();
  for (const c of commands) {
    const [head] = c.name.split(" ");
    groups.set(head, [...(groups.get(head) ?? []), c]);
  }
  for (const [head, cmds] of groups) {
    const single = cmds.length === 1 && cmds[0].name === head;
    const desc = single ? cmds[0].summary : `${head} commands`;
    L.push(`complete -c archon -n __fish_use_subcommand -a ${head} -d ${q(desc)}`);
    const emitted = new Set<string>();
    for (const c of cmds) {
      const words = c.name.split(" ");
      let cond = `__fish_seen_subcommand_from ${head}`;
      // Each further word ("fs smb status"): offered once its parents are typed,
      // and until one of its siblings is.
      for (let i = 1; i < words.length; i++) {
        const prefix = words.slice(0, i).join(" ");
        const siblings = [
          ...new Set(
            cmds.filter((x) => x.name.startsWith(prefix + " ")).map((x) => x.name.split(" ")[i]),
          ),
        ];
        const key = `${prefix} ${words[i]}`;
        if (!emitted.has(key)) {
          emitted.add(key);
          const leaf = i === words.length - 1;
          const desc = leaf ? c.summary : `${key} commands`;
          L.push(
            `complete -c archon -n "${cond}; and not __fish_seen_subcommand_from ${
              siblings.join(" ")
            }" -a ${words[i]} -d ${q(desc)}`,
          );
        }
        cond = `${cond}; and __fish_seen_subcommand_from ${words[i]}`;
      }
      for (const a of [...c.args, ...GLOBAL_ARGS]) {
        if (a.positional) continue;
        L.push(
          `complete -c archon -n "${cond}" -l ${a.name}${a.type === "string" ? " -r" : ""} -d ${
            q(a.description)
          }`,
        );
      }
    }
  }
  return L.join("\n") + "\n";
}
