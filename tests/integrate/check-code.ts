/**
 * Spec 069 (CI): read the check-in code an integrate script printed and check it. Run by the
 * integrate jobs of `.github/workflows/ci.yml` (Linux distributions, macOS, Windows), with Bun or
 * Node: `bun tests/integrate/check-code.ts <output-file> <os family> <kind> [kind...]`.
 *
 * @module
 */
import { fs, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { parseCheckIn } from "../../src/archon/adopt/checkin.ts";

const [file, family = "", ...kinds] = proc.args;
if (file === undefined) {
  stdio.stderr.writeSync("usage: check-code.ts <output-file> <os family> <kind> [kind...]\n");
  proc.exit(2);
}
const line = (await fs.readTextFile(file)).split(/\r?\n/).find((l) => l.startsWith("stolos1:"));
if (line === undefined) throw new Error(`no check-in code in ${file}`);
const c = parseCheckIn(line);
const problems: string[] = [];
if (c.observed === undefined) problems.push("no probe facts in the code");
else {
  if (!c.observed.os.family.startsWith(family)) {
    problems.push(`os family ${c.observed.os.family}, not ${family}`);
  }
  if (c.observed.security.firewall === "") problems.push("no firewall fact");
}
for (const k of kinds) {
  if (!c.kinds.includes(k)) problems.push(`kinds ${c.kinds.join(",")} lacks ${k}`);
}
console.log(
  JSON.stringify(
    {
      hostname: c.hostname,
      kinds: c.kinds,
      os: c.observed?.os,
      security: c.observed?.security,
      hostKeys: c.hostKeys.length,
    },
    null,
    2,
  ),
);
if (problems.length > 0) {
  stdio.stderr.writeSync(`${problems.join("\n")}\n`);
  proc.exit(1);
}
