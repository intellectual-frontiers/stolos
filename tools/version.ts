// `deno task version <bump|check|show>` (spec 046-engine-instance): the
// engine's version lives in src/archon/version.ts, never in a config file.
//
//   bump    raise the minor number (0.1.0 -> 0.2.0) and print it
//   check   fail unless the version is newer than the one on <base> (default
//           origin/main), or <base> does not exist yet; prints the tag
//   show    print the version

const FILE = new URL("../src/archon/version.ts", import.meta.url);
const RE = /export const VERSION = "(\d+)\.(\d+)\.(\d+)";/;

function parse(text: string): [number, number, number] {
  const m = text.match(RE);
  if (!m) throw new Error("src/archon/version.ts has no VERSION");
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const fmt = (v: number[]) => v.join(".");
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

const [cmd = "show", base = "origin/main"] = Deno.args;
const text = await Deno.readTextFile(FILE);
const v = parse(text);

if (cmd === "show") {
  console.log(fmt(v));
} else if (cmd === "bump") {
  const next = [v[0], v[1] + 1, 0];
  await Deno.writeTextFile(FILE, text.replace(RE, `export const VERSION = "${fmt(next)}";`));
  console.log(fmt(next));
} else if (cmd === "check") {
  const known = await new Deno.Command("git", {
    args: ["rev-parse", "-q", "--verify", `${base}^{commit}`],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!known.success) {
    console.error(
      `unknown base ${base}: fetch it first (git fetch origin), so the check can compare`,
    );
    Deno.exit(1);
  }
  const r = await new Deno.Command("git", {
    args: ["show", `${base}:src/archon/version.ts`],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (r.code !== 0) {
    console.log(`v${fmt(v)} (no version on ${base} yet)`);
  } else {
    const prev = parse(new TextDecoder().decode(r.stdout));
    if (!newer(v, prev)) {
      console.error(
        `version ${fmt(v)} is not newer than ${
          fmt(prev)
        } on ${base}: run \`deno task version bump\``,
      );
      Deno.exit(1);
    }
    console.log(`v${fmt(v)} (was ${fmt(prev)} on ${base})`);
  }
} else {
  console.error("usage: deno task version <bump|check|show> [base]");
  Deno.exit(2);
}
