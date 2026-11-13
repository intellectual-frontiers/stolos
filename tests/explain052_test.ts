// Spec 052: four states everywhere, summaries that agree with exit codes,
// and every problem archon raises can be explained by its code.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { Ui } from "../src/archon/core/ui.ts";
import { EXPLAIN, explainText, translate } from "../src/archon/core/explain.ts";
import { walkFiles } from "../src/archon/core/fsx.ts";

function quiet() {
  const out: string[] = [];
  const ui = new Ui({
    tty: false,
    color: false,
    emoji: false,
    write: (s) => out.push(s),
    logPath: null,
  });
  return { ui, text: () => out.join("") };
}

Deno.test("052: not set up yet is never a failure, and shows its next step", () => {
  const { ui, text } = quiet();
  const p = ui.phase("Email");
  p.pending("no relay token yet", "deno task boot mail-push alpha", "P027-MAIL-TOKEN");
  p.done();
  assertEquals(ui.finish(), 0);
  const t = text();
  assertStringIncludes(t, "Not set up yet");
  assertStringIncludes(t, "next: deno task boot mail-push alpha");
  assertStringIncludes(t, "explain: archon explain P027-MAIL-TOKEN");
  assert(!t.includes("Needs attention"), "a pending item is not a problem");
  assert(!t.includes("failure"));
});

Deno.test("052: the summary and the exit code always agree", () => {
  for (const [fails, warns, pendings] of [[0, 0, 0], [0, 2, 0], [0, 0, 3], [1, 0, 0], [2, 1, 1]]) {
    const { ui, text } = quiet();
    const p = ui.phase("Verify");
    for (let i = 0; i < fails; i++) p.fail(`f${i}`);
    for (let i = 0; i < warns; i++) p.warn(`w${i}`);
    for (let i = 0; i < pendings; i++) p.pending(`p${i}`, "next");
    p.done();
    const code = ui.finish();
    const last = text().trim().split("\n").filter((l) => !l.startsWith("   ")).pop()!;
    assertEquals(code, fails ? 1 : 0, `${fails}/${warns}/${pendings}`);
    assertEquals(last.startsWith("!!"), fails > 0, last);
    assertEquals(last.includes("failure"), fails > 0, last);
  }
});

Deno.test("052: raw errors from other tools get their cause and fix", () => {
  const cases: Array<[string, string]> = [
    ["Host key verification failed.", "E047-HOST-KEY"],
    ["@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", "E047-HOST-KEY"],
    ["ops@alpha: Permission denied (publickey).", "E004-SSH-KEY"],
    ["curl: (6) Could not resolve host: archive.ubuntu.com", "E009-DNS"],
    ["E: Could not get lock /var/lib/dpkg/lock-frontend", "E009-APT-BUSY"],
    [
      "dpkg-query: error: fgets gave an empty string from '/var/lib/dpkg/triggers/Unincorp'",
      "E009-DPKG-DAMAGED",
    ],
  ];
  for (const [msg, code] of cases) assertEquals(translate(msg)?.code, code, msg);
  assertEquals(translate("everything is fine"), undefined);
  // A problem raised with such a message carries the code and fix by itself.
  const { ui, text } = quiet();
  ui.phase("Reach").fail("alpha: Host key verification failed.");
  ui.finish();
  assertStringIncludes(text(), "archon explain E047-HOST-KEY");
  assertStringIncludes(text(), "fleet trust");
});

Deno.test("052: every code the engine uses has an explanation", async () => {
  const used = new Set<string>();
  for (const rel of await walkFiles("src")) {
    const f = `src/${rel}`;
    if (!f.endsWith(".ts") || f.endsWith(".auto.ts")) continue;
    for (
      const m of (await Deno.readTextFile(f)).matchAll(/["`( ]([EP]\d{3}-[A-Z][A-Z-]*[A-Z])\b/g)
    ) {
      used.add(m[1]);
    }
  }
  // Codes built from signers.ts's checkTip codes in reconcile.ts.
  for (const c of ["rollback", "no-signers", "unsigned", "untrusted"]) {
    used.add(`E047-${c.toUpperCase()}`);
  }
  assert(used.size >= 15, `found ${used.size}`);
  for (const c of used) assert(EXPLAIN[c], `${c} is used but has no explanation`);
  for (const [c, e] of Object.entries(EXPLAIN)) {
    assert(/^[EP]\d{3}-[A-Z-]+$/.test(c), c);
    assert(e.what && e.why && e.fix && e.doc, c);
  }
  assertStringIncludes(explainText("e051-disk-not-blank"), "Fix");
  assertStringIncludes(explainText(), "E051-DISK-NOT-BLANK");
});

Deno.test("052: no new silent catches (each one is a decision, so the count only goes down)", async () => {
  let n = 0;
  for (const rel of await walkFiles("src")) {
    const f = `src/${rel}`;
    if (!f.endsWith(".ts") || f.endsWith(".auto.ts")) continue;
    n += ((await Deno.readTextFile(f)).match(/\.catch\(\(\) => \{\}\)/g) ?? []).length;
  }
  assert(
    n <= 60,
    `${n} .catch(() => {}) in src (at most 60): report the error instead, or lower nothing`,
  );
});

Deno.test("052: checks that wait for a token say 'not set up yet' (exit 3), with a code", async () => {
  const { mail } = await import("../src/archon/capabilities/mail.ts");
  const { fleet, host } = await import("./fixtures.ts");
  const f = { ...fleet(), mail: { to: "fleet@example.net", domain: "example.net" } };
  const c = mail()({ host: host(), fleet: f, users: [] }).checks!.find((x) =>
    x.name === "mail:credential"
  )!;
  assertStringIncludes(c.command, "exit 3");
  assertEquals(c.code, "P027-MAIL-TOKEN");
  const { verifyRecord } = await import("../src/archon/state/verify.ts");
  const r = verifyRecord([
    { resource: "a", command: "true", ok: true, output: "" },
    { resource: "mail:credential", command: "x", ok: false, output: "", level: "pending" },
    { resource: "b", command: "x", ok: false, output: "", level: "warn" },
  ]);
  assertEquals(r.failed, []);
  assertEquals(r.warned, ["b"]);
  assertEquals(r.pending, ["mail:credential"]);
});
