/**
 * Spec 081: a Trust Center built from a real signed evidence bundle: refused when the bundle does
 * not verify; failing and stale controls shown as such; a public build leaks no subject, hostname,
 * or email; every claim links to an item present in the published bundle with a matching hash; the
 * page is well formed and makes no requests.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { unzip, zipDeflated } from "@intellectual-frontiers/formats";
import { sha256 } from "@intellectual-frontiers/crypto";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import {
  type Item,
  manifestFor,
  manifestText,
  packBundle,
  sshSigner,
  verifyBundle,
} from "../src/archon/evidence/bundle.ts";
import { gitItems } from "../src/archon/evidence/commands.ts";
import type { ScfCatalog } from "../src/archon/compliance/catalog.ts";
import { assessmentResults, tidyStrings } from "../src/archon/compliance/oscal.ts";
import { complianceView, type Evidence } from "../src/archon/compliance/report.ts";
import { type FrameworkId, FRAMEWORKS } from "../src/archon/compliance/scf.ts";
import {
  buildTrustSite,
  MARKER,
  parseFrameworks,
  trustBuild,
} from "../src/archon/trust/commands.ts";
import { publicControl, signerLines } from "../src/archon/trust/publish.ts";
import { GUIDES } from "../src/archon/core/guides.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";

/** A ZIP of these files (deflated), as the engine writes its bundles. */
const zipped = (files: Record<string, Uint8Array>): Promise<Uint8Array> =>
  zipDeflated(new Map(Object.entries(files)));

/** A ZIP's files, by path. */
async function unzipped(zip: Uint8Array): Promise<Record<string, Uint8Array>> {
  const r = await unzip(zip);
  if (r.kind === "err") throw new Error(`not a ZIP: ${r.error.kind}`);
  return Object.fromEntries(r.value);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sh(args: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
  const r = await proc.run(args, {
    ...(cwd ? { cwd } : {}),
    stdin: "null",
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  if (r.code !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function keyPair(dir: string, name: string) {
  const key = `${dir}/${name}`;
  await sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  return {
    key,
    pub: (await fs.readTextFile(key + ".pub")).trim().split(/\s+/).slice(0, 2).join(" "),
  };
}

const CREATED = "2026-03-31T12:00:00Z";
const META = {
  fleet: { id: "lab", title: "Example Co", repo: "example/lab" },
  period: { from: "2026-03-01", to: "2026-03-31" },
  created: CREATED,
  stolos: "0.0.0",
  signer: "alice-daily",
  omitted: [],
};

/** A small SCF catalog (the release the bundle names), mapping to SOC 2, HIPAA, and SP 800-53. */
function catalog(): ScfCatalog {
  const maps = (m: Partial<Record<FrameworkId, string[]>>) =>
    Object.fromEntries(FRAMEWORKS.map((f) => [f.id, m[f.id] ?? []])) as Record<
      FrameworkId,
      string[]
    >;
  const e = (name: string, m: Partial<Record<FrameworkId, string[]>>) => ({
    domain: "",
    name,
    description: "",
    maps: maps(m),
  });
  return {
    format: 1,
    version: "2026.3",
    controls: {
      "CFG-04": e("Secure Baseline Configurations", {
        soc2: ["CC7.1"],
        hipaa: ["164.308(a)(1)(ii)(D)"],
        nist80053: ["CM-06"],
      }),
      "CRY-07": e("Encrypting Data At Rest", {
        soc2: ["CC6.1-POF10"],
        hipaa: ["164.312(a)(2)(iv)"],
        nist80053: ["SC-28"],
      }),
      "END-07": e("Software Firewall", { soc2: ["CC6.6"], nist80053: ["SC-07"] }),
      "IAC-37": e("Multi-Factor Authentication (MFA)", {
        soc2: ["CC6.1"],
        nist80053: ["IA-02(01)"],
      }),
      "CHG-03": e("Configuration Change Control", { soc2: ["CC8.1"], nist80053: ["CM-03"] }),
      "MON-02": e("Continuous Monitoring", { soc2: ["CC7.2"], nist80053: ["SI-04"] }),
    },
  };
}

/** The checks the bundle's OSCAL records (subjects and details full of names a public page must not show). */
const EVIDENCE: Evidence[] = [
  {
    scf: ["CFG-04"],
    subject: "alpha",
    source: "managed",
    check: "Matches its model (archon verify)",
    status: "pass",
    detail: "12 of 12 checks on alpha.lab.example.net",
  },
  {
    scf: ["CRY-07"],
    subject: "alice-mbp",
    source: "adopted",
    check: "The disk is encrypted",
    status: "fail",
    detail: "FileVault is off on alice@example.com's laptop",
  },
  {
    scf: ["END-07"],
    subject: "alice-mbp",
    source: "adopted",
    check: "The firewall is on",
    status: "pass",
    detail: "FileVault host firewall on",
  },
  {
    scf: ["CRY-07"],
    subject: "bob-desk",
    source: "adopted",
    check: "The disk is encrypted",
    status: "pass",
    detail: "LUKS on bob-desk.lab.example.net",
  },
  {
    scf: ["IAC-37"],
    subject: "across systems",
    source: "estate",
    check: "Administrators have a second factor",
    status: "pass",
    detail: "bob@example.com registered MFA",
  },
  {
    scf: ["CHG-03"],
    subject: "example/lab",
    source: "repository",
    check: "Every commit servers apply is signed by a fleet signer",
    status: "pass",
    detail: "the newest commit is approved",
  },
];

/** A real bundle: a Git repository with signed commits (two adopted machines observed), a verify, OSCAL. */
async function fixture() {
  const dir = await fs.makeTempDir();
  const alice = await keyPair(dir, "alice-daily");
  const mallory = await keyPair(dir, "mallory");
  const repo = `${dir}/repo`;
  for (const m of ["alice-mbp", "bob-desk"]) {
    await fs.mkdir(`${repo}/fleets/lab/adopted/${m}`, { recursive: true });
  }
  await sh(["git", "init", "-q", "-b", "main"], repo);
  for (const [k, v] of [
    ["user.name", "Alice Example"],
    ["user.email", "alice@example.com"],
    ["gpg.format", "ssh"],
    ["user.signingkey", alice.key],
    ["commit.gpgsign", "true"],
  ])
    await sh(["git", "config", got(k), got(v)], repo);
  const commit = async (path: string, text: string, date: string) => {
    await fs.writeTextFile(`${repo}/${path}`, text);
    const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    await sh(["git", "add", "-A"], repo, env);
    await sh(["git", "commit", "-q", "-m", `observe ${path}`], repo, env);
  };
  // alice-mbp observed 10 days before signing (stale: adopted machines' service level is 2 days).
  await commit(
    "fleets/lab/adopted/alice-mbp/observed.ts",
    `// GENERATED\nexport const observed = { host: "alice-mbp.lab.example.net", owner: "alice@example.com" };\n`,
    "2026-03-21T12:00:00Z",
  );
  await commit(
    "fleets/lab/adopted/bob-desk/observed.ts",
    `// GENERATED\nexport const observed = { host: "bob-desk.lab.example.net", owner: "bob@example.com" };\n`,
    "2026-03-31T11:00:00Z",
  );
  const items: Item[] = await gitItems(repo, "fleets/lab", "2026-03-01", "2026-03-31");
  items.push({
    kind: "verify",
    name: "alpha verify archon",
    at: "2026-03-31T11:50:00Z",
    content: enc.encode(JSON.stringify({ host: "alpha.lab.example.net", passed: 12 }) + "\n"),
  });
  items.push({
    kind: "signers",
    name: "fleets/lab/signers.ts",
    at: CREATED,
    content: enc.encode(`export default [{ name: "alice-daily", email: "alice@example.com" }];\n`),
  });
  const ar = await assessmentResults({
    view: complianceView(EVIDENCE, catalog()),
    fleet: META.fleet,
    machines: [],
    version: "0.0.0",
    now: new Date(CREATED),
  });
  items.push({
    kind: "oscal",
    name: "assessment-results.json",
    at: CREATED,
    content: enc.encode(JSON.stringify(tidyStrings(ar), null, 2) + "\n"),
  });
  const allowed = `alice-daily namespaces="git,stolos-evidence" ${alice.pub} alice@example.com\n`;
  const m = await manifestFor(items, META);
  const sig = await sshSigner(alice.key)(manifestText(m));
  const zip = await packBundle(items, m, sig, allowed);
  return { dir, alice, mallory, zip, m, allowed };
}

const hasSsh = proc.which("ssh-keygen") !== undefined;

const NOW = new Date("2026-04-01T00:00:00Z");
const NAME = "lab-evidence-2026-03-01-to-2026-03-31.zip";

/** A simple well-formedness check: every non-void tag closes, in order. */
function unclosed(page: string): string[] {
  const VOID = new Set(["meta", "link", "br", "hr", "img", "input", "source", "wbr", "col"]);
  const body = page
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype[^>]*>/i, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, "");
  const stack: string[] = [];
  const problems: string[] = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, close, tag0] = m;
    const tag = tag0?.toLowerCase();
    if (VOID.has(got(tag))) continue;
    if (!close) stack.push(got(tag));
    else if (stack.at(-1) === tag) stack.pop();
    else problems.push(`</${tag}> closes <${stack.at(-1)}>`);
  }
  return [...problems, ...stack.map((t) => `<${t}> never closed`)];
}

/** The text of a control's card. */
function card(page: string, id: string): string {
  const a = page.indexOf(`id="control-${id.toLowerCase()}"`);
  assert(a > 0, `no card for ${id}`);
  return page.slice(a, page.indexOf("</article>", a));
}

/** Every evidence link: its href's SHA-256 is a published object whose bytes hash to it, and listed. */
async function checkLinks(files: Record<string, Uint8Array>, zipName: string): Promise<number> {
  const page = dec.decode(files["index.html"]);
  const zip = files[`evidence/${zipName}`];
  assert(zip, `evidence/${zipName} is published`);
  const listed = new Set(
    (
      JSON.parse(dec.decode((await unzipped(zip))["manifest.json"])) as {
        items: { sha256: string }[];
      }
    ).items.map((i) => i.sha256),
  );
  const links = [...page.matchAll(/href="evidence\/objects\/([0-9a-f]{64})"/g)].map((m) => m[1]);
  for (const sha of links) {
    const b = files[`evidence/objects/${sha}`];
    assert(b, `evidence/objects/${sha} is published`);
    assertEquals(await sha256(b), sha);
    assert(listed.has(got(sha)), `${sha} is in the published bundle's manifest`);
  }
  return links.length;
}

proves(
  [
    "081-trust-center FR-001",
    "081-trust-center FR-002",
    "081-trust-center FR-003",
    "081-trust-center FR-005",
    "081-trust-center FR-006",
    "081-trust-center FR-008",
  ],
  "081: a public Trust Center: honest statuses, a signed summary, nothing personal",
  async () => {
    const f = await fixture();
    const site = await buildTrustSite(f.zip, NAME, {
      sign: sshSigner(f.alice.key),
      catalog: catalog(),
      now: NOW,
      stolos: "0.0.0",
      contact: "https://example.com/security",
    });
    assert(site.ok, site.ok ? "" : site.problems.join("; "));
    const page = dec.decode(site.files["index.html"]);
    assertStringIncludes(page, "Example Co");
    assertStringIncludes(page, "alice-daily");

    // Failing and stale, plainly.
    assertStringIncludes(card(page, "CRY-07"), "Failing");
    const end = card(page, "END-07");
    assertStringIncludes(end, "Failing");
    assertStringIncludes(end, "1 stale");
    assertStringIncludes(card(page, "MON-02"), "Failing");
    assertStringIncludes(card(page, "CFG-04"), "Passing");
    assert(!card(page, "CFG-04").includes("stale"));
    assertStringIncludes(page, "control(s) failing");
    assert(/<div\s+id="aged"[^>]*\shidden\s*>/.test(page), "a fresh bundle's banner is hidden");
    assertEquals(got(site.model.controls.find((c) => c.id === "END-07")).counts.stale, 1);
    const soc2 = got(site.model.frameworks.find((x) => x.id === "soc2"));
    // CC6.1-POF10 folds into CC6.1, reached by CRY-07 (failing) and IAC-37 (passing).
    assertEquals(soc2.requirements.find((r) => r.id === "CC6.1")?.status, "fail");
    assertEquals(soc2.requirements.find((r) => r.id === "CC8.1")?.status, "pass");
    assertStringIncludes(page, 'id="fw-hipaa"');

    // The summary bundle verifies on its own, signed by the full bundle's signer.
    const zipName = got(
      Object.keys(site.files).find((p) => /^evidence\/[^/]+\.zip$/.test(p)),
    ).slice("evidence/".length);
    const sum = await verifyBundle(got(site.files[`evidence/${zipName}`]));
    assert(sum.ok, sum.problems.join("; "));
    assertEquals(sum.signer, "alice-daily");
    assert(got(sum.manifest).items.every((i) => i.kind === "summary"));

    // Every claim's link is an item in the published bundle, with a matching hash.
    const links = await checkLinks(site.files, zipName);
    assertEquals(links, site.model.controls.filter((c) => c.checks.length).length);

    // Nothing personal anywhere published: no subject, hostname, email, finding, or item name.
    const texts: Array<[string, string]> = [];
    for (const [p, b] of Object.entries(site.files)) {
      if (p.endsWith(".zip")) {
        for (const [q, c] of Object.entries(await unzipped(b)))
          texts.push([`${p}:${q}`, dec.decode(c)]);
      } else texts.push([p, dec.decode(b)]);
    }
    const SECRETS = [
      "alice-mbp",
      "bob-desk",
      "alpha",
      "lab.example.net",
      "example/lab",
      "FileVault is off",
      "LUKS on",
      "across systems",
      "Alice Example",
      "observed.ts",
      "fleets/",
      "Matches its model",
    ];
    for (const [p, t] of texts) {
      for (const s of SECRETS) assert(!t.includes(s), `${p} leaks "${s}"`);
      const emails = t.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/g) ?? [];
      assertEquals(emails, [], `${p} has an email`);
    }
    // The public summary's allowed_signers is the signer's key alone (its comment was an email).
    assertEquals(
      dec.decode(site.files["evidence/allowed_signers"]),
      `alice-daily namespaces="stolos-evidence" ${f.alice.pub}\n`,
    );
    assertEquals(signerLines(f.allowed, "nobody"), "\n");
    // A public control document: exactly these fields.
    assertEquals(
      Object.keys(publicControl(got(site.model.controls.find((c) => c.id === "CRY-07")))).sort(),
      ["backedBy", "checks", "counts", "format", "how", "id", "name", "observed", "status"],
    );

    // Well formed, and offline: no URL but the company's own.
    assertEquals(unclosed(page), []);
    for (const [p, t] of texts.filter(([p]) => p.endsWith(".html"))) {
      const urls = (t.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).filter(
        (u) => u !== "https://example.com/security",
      );
      assertEquals(urls, [], `${p} reaches out`);
    }
    assertStringIncludes(page, "default-src &#39;none&#39;");
    assert(!/\sstyle="/.test(page), "no inline style attributes (the CSP forbids them)");
    await fs.remove(f.dir, { recursive: true });
  },
  { skip: !hasSsh && "ssh-keygen is not installed" },
);

proves(
  ["081-trust-center FR-005", "081-trust-center FR-007"],
  "081: a gated Trust Center shows everything and links to the full bundle's items",
  async () => {
    const f = await fixture();
    const site = await buildTrustSite(f.zip, NAME, {
      mode: "gated",
      catalog: catalog(),
      now: NOW,
      stolos: "0.0.0",
      frameworks: ["soc2"],
    });
    assert(site.ok, site.ok ? "" : site.problems.join("; "));
    const page = dec.decode(site.files["index.html"]);
    assertStringIncludes(page, "alice-mbp");
    assertStringIncludes(page, "FileVault is off on alice@example.com&#39;s laptop");
    assertStringIncludes(page, "stale (was pass)");
    assertStringIncludes(page, "noindex");
    assert(!page.includes('id="fw-hipaa"'), "--frameworks soc2 shows only SOC 2");
    assertEquals(site.files[`evidence/${NAME}`], f.zip);
    const links = await checkLinks(site.files, NAME);
    // Every item backing every control is linked.
    const want = site.model.controls.reduce((n, c) => n + c.items.length, 0);
    assertEquals(links, want);
    const cry = got(site.model.controls.find((c) => c.id === "CRY-07"));
    assert(cry.items.some((i) => i.kind === "oscal"));
    assert(cry.items.some((i) => i.name.includes("/alice-mbp/")));
    assertEquals(unclosed(page), []);
    await fs.remove(f.dir, { recursive: true });
  },
  { skip: !hasSsh && "ssh-keygen is not installed" },
);

proves(
  ["081-trust-center FR-001", "081-trust-center FR-003"],
  "081: refused: a tampered bundle, a summary signed by someone else, a framework it cannot reach",
  async () => {
    const f = await fixture();
    const files = await unzipped(f.zip);
    const obj = `objects/${got(f.m.items.find((i) => i.kind === "oscal")).sha256}`;
    files[obj] = enc.encode(dec.decode(files[obj]).replace(/"fail"/g, '"pass"'));
    const tampered = await buildTrustSite(await zipped(files), NAME, {
      catalog: catalog(),
      now: NOW,
    });
    assert(!tampered.ok);
    assert(
      tampered.problems.some((p) => p.includes("changed (SHA-256")),
      tampered.problems.join(),
    );

    const wrong = await buildTrustSite(f.zip, NAME, {
      sign: sshSigner(f.mallory.key),
      catalog: catalog(),
      now: NOW,
    });
    assert(!wrong.ok);
    assertStringIncludes(got(wrong.problems[0]), "must be signed by alice-daily");

    // Without the catalog: SP 800-53 from the bundle's own findings; the others say why not.
    const bare = await buildTrustSite(f.zip, NAME, { mode: "gated", now: NOW });
    assert(bare.ok);
    assertEquals(
      bare.model.frameworks.map((x) => x.id),
      ["nist80053"],
    );
    assertEquals(bare.model.scf.mappings, "bundle");
    assert(bare.model.unavailable.some((u) => u.id === "soc2" && u.reason.includes("2026.3")));
    assert(
      bare.model.frameworks[0]?.requirements.some((r) => r.id === "sc-28" && r.status === "fail"),
    );
    const hipaa = await buildTrustSite(f.zip, NAME, { frameworks: ["hipaa"], now: NOW });
    assert(!hipaa.ok);
    assertStringIncludes(got(hipaa.problems[0]), "hipaa: cannot be shown");
    assert(!(await buildTrustSite(f.zip, NAME, { contact: "http://x", now: NOW })).ok);
    let threw = false;
    try {
      parseFrameworks("soc2,nope");
    } catch {
      threw = true;
    }
    assert(threw);

    // The command writes nothing for a refused bundle.
    const out = `${f.dir}/site`;
    await fs.writeFile(`${f.dir}/bad.zip`, await zipped(files));
    assertEquals(await trustBuild({ bundle: `${f.dir}/bad.zip`, out, catalog: null }), 1);
    assert(
      !(await fs.stat(out).then(
        () => true,
        () => false,
      )),
    );
    await fs.remove(f.dir, { recursive: true });
  },
  { skip: !hasSsh && "ssh-keygen is not installed" },
);

proves(
  ["081-trust-center FR-004", "081-trust-center FR-006"],
  "081: a stale bundle makes every status stale; on request publishes no evidence",
  async () => {
    const f = await fixture();
    const old = await buildTrustSite(f.zip, NAME, {
      catalog: catalog(),
      now: new Date("2026-05-01T00:00:00Z"),
    });
    assert(old.ok);
    assert(old.model.bundleStale);
    const page = dec.decode(old.files["index.html"]);
    assert(/<div\s+id="aged"[^>]*data-max="\d+"\s*>/.test(page), "the banner shows");
    assertStringIncludes(card(page, "CFG-04"), "stale bundle");
    // Public without a signer: on request, no evidence published, hashes as text.
    assert(!Object.keys(old.files).some((p) => p.startsWith("evidence/")));
    assertStringIncludes(page, "available on request");
    assert(!page.includes('href="evidence/'));
    await fs.remove(f.dir, { recursive: true });
  },
  { skip: !hasSsh && "ssh-keygen is not installed" },
);

proves(
  ["081-trust-center FR-009"],
  "081: trust build writes the folder, rebuilds it, and refuses someone else's",
  async () => {
    const f = await fixture();
    const bundle = `${f.dir}/${NAME}`;
    await fs.writeFile(bundle, f.zip);
    const out = `${f.dir}/site`;
    const o = {
      bundle,
      out,
      catalog: catalog(),
      sign: sshSigner(f.alice.key),
      now: NOW,
    };
    assertEquals(await trustBuild(o), 0);
    assertStringIncludes(await fs.readTextFile(`${out}/index.html`), "Example Co");
    assert(await fs.stat(`${out}/${MARKER}`));
    assertEquals(await trustBuild({ ...o, gated: true }), 0, "a rebuild replaces it");
    assert(await fs.stat(`${out}/evidence/${NAME}`));
    const other = `${f.dir}/other`;
    await fs.mkdir(other);
    await fs.writeTextFile(`${other}/keep.txt`, "mine\n");
    assertEquals(await trustBuild({ ...o, out: other }), 1);
    assertEquals(await fs.readTextFile(`${other}/keep.txt`), "mine\n");
    assertEquals(await trustBuild({ ...o, public: true, gated: true }), 1);
    await fs.remove(f.dir, { recursive: true });
  },
  { skip: !hasSsh && "ssh-keygen is not installed" },
);

test("081: the command and the guide are registered", () => {
  const c = COMMANDS.find((x) => x.name === "trust build");
  assert(c && c.noMcp && c.place === "pc");
  assert(GUIDES.some((g) => g.name === "trust" && g.module === "src/archon/trust/mod.ts"));
});

/** The value the test expects to be there. */
function got<T>(value: T | undefined | null, what = "a value"): T {
  assertExists(value, `${what} is missing`);
  return value;
}
