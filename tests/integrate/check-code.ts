// Spec 069 (CI): read the check-in code an integrate script printed and check it.
// Usage: deno run -A tests/integrate/check-code.ts <output-file> <os family> <kind> [kind...]
import { parseCheckIn } from "../../src/archon/adopt/checkin.ts";

const [file, family, ...kinds] = Deno.args;
const line = (await Deno.readTextFile(file)).split(/\r?\n/).find((l) => l.startsWith("stolos1:"));
if (!line) throw new Error(`no check-in code in ${file}`);
const c = parseCheckIn(line);
const problems: string[] = [];
if (!c.observed) problems.push("no probe facts in the code");
if (c.observed && !c.observed.os.family.startsWith(family)) {
  problems.push(`os family ${c.observed?.os.family}, not ${family}`);
}
for (const k of kinds) {
  if (!c.kinds.includes(k)) problems.push(`kinds ${c.kinds.join(",")} lacks ${k}`);
}
if (c.observed && c.observed.security.firewall === "") problems.push("no firewall fact");
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
if (problems.length) {
  console.error(problems.join("\n"));
  Deno.exit(1);
}
