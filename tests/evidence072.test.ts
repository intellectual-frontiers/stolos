/**
 * Spec 072: evidence bundles: content-addressed, hash-chained, signed, and checked offline.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/system";
import { unzip, zipDeflated } from "@intellectual-frontiers/formats";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import {
  commitSignature,
  forNamespace,
  type Item,
  type Manifest,
  manifestFor,
  manifestText,
  packBundle,
  sshSigner,
  verifyBundle,
} from "../src/archon/evidence/bundle.ts";
import { gitItems, isObservation } from "../src/archon/evidence/commands.ts";

/** A ZIP of these files (deflated), as the engine writes its bundles. */
const zipped = (files: Record<string, Uint8Array>): Promise<Uint8Array> =>
  zipDeflated(new Map(Object.entries(files)));

/** A ZIP's files, by path. */
async function unzipped(zip: Uint8Array): Promise<Record<string, Uint8Array>> {
  const r = await unzip(zip);
  if (r.kind === "err") throw new Error(`not a ZIP: ${r.error.kind}`);
  return Object.fromEntries(r.value);
}

async function sh(args: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
  const r = await proc.run(args, {
    ...(cwd ? { cwd } : {}),
    stdin: "null",
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  if (r.code !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function keyPair(dir: string, name: string): Promise<{ key: string; pub: string }> {
  const key = `${dir}/${name}`;
  await sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  return {
    key,
    pub: (await fs.readTextFile(key + ".pub")).trim().split(/\s+/).slice(0, 2).join(" "),
  };
}

/** A fleet repository with two signed commits and one unsigned, and its signers. */
async function fixture(): Promise<Fixture> {
  const dir = await fs.makeTempDir();
  const alice = await keyPair(dir, "alice-daily");
  const mallory = await keyPair(dir, "mallory");
  const repo = `${dir}/repo`;
  await fs.mkdir(`${repo}/fleets/lab/adopted/alice-mbp`, { recursive: true });
  const g = (a: string[], date: string, sign = true) =>
    sh(
      ["git", ...(sign ? ["-c", "commit.gpgsign=true"] : ["-c", "commit.gpgsign=false"]), ...a],
      repo,
      {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    );
  await sh(["git", "init", "-q", "-b", "main"], repo);
  for (const [k, v] of [
    ["user.name", "Alice"],
    ["user.email", "alice@example.com"],
    ["gpg.format", "ssh"],
    ["user.signingkey", alice.key],
  ] as const)
    await sh(["git", "config", k, v], repo);
  await fs.writeTextFile(`${repo}/fleets/lab/signers.ts`, `export default [];\n`);
  await g(["add", "-A"], "2026-03-01T10:00:00Z");
  await g(["commit", "-q", "-m", "signers"], "2026-03-01T10:00:00Z");
  await fs.writeTextFile(
    `${repo}/fleets/lab/adopted/alice-mbp/observed.ts`,
    `// GENERATED\nexport const observed = { disk: "on" };\n`,
  );
  await g(["add", "-A"], "2026-03-02T10:00:00Z");
  await g(["commit", "-q", "-m", "observe alice-mbp"], "2026-03-02T10:00:00Z");
  await fs.writeTextFile(`${repo}/fleets/lab/notes.md`, "unsigned\n");
  await g(["add", "-A"], "2026-03-03T10:00:00Z", false);
  await g(["commit", "-q", "-m", "unsigned"], "2026-03-03T10:00:00Z", false);
  await fs.writeTextFile(
    `${repo}/fleets/lab/adopted/alice-mbp/observed.ts`,
    `// GENERATED\nexport const observed = { disk: "off" };\n`,
  );
  await g(["add", "-A"], "2026-04-10T10:00:00Z");
  await g(["commit", "-q", "-m", "after the period"], "2026-04-10T10:00:00Z");
  const allowed = `alice-daily namespaces="git,stolos-evidence" ${alice.pub}\n`;
  return { dir, repo, alice, mallory, allowed };
}

/** The fleet repository the tests bundle. */
type Fixture = {
  dir: string;
  repo: string;
  alice: { key: string; pub: string };
  mallory: { key: string; pub: string };
  allowed: string;
};

const META = {
  fleet: { id: "lab", title: "Lab", repo: "example/lab" },
  period: { from: "2026-03-01", to: "2026-03-31" },
  created: "2026-04-01T00:00:00Z",
  stolos: "0.0.0",
  signer: "alice-daily",
  omitted: [] as string[],
};

async function bundle(
  f: Fixture,
  key = f.alice.key,
): Promise<{ items: Item[]; m: Manifest; zip: Uint8Array }> {
  const items: Item[] = await gitItems(f.repo, "fleets/lab", "2026-03-01", "2026-03-31");
  const m = await manifestFor(items, META);
  const sig = await sshSigner(key)(manifestText(m));
  return { items, m, zip: await packBundle(items, m, sig, f.allowed) };
}

/** Change a ZIP's files and pack it again. */
async function edit(
  zip: Uint8Array,
  fn: (files: Record<string, Uint8Array>) => void,
): Promise<Uint8Array> {
  const files = await unzipped(zip);
  fn(files);
  return zipped(files);
}

const hasSsh = proc.which("ssh-keygen") !== undefined;

proves(
  ["072-evidence-bundles FR-001", "072-evidence-bundles FR-002"],
  "072: the period's commits and observations, in order, each commit raw with its signature",
  async () => {
    const f = await fixture();
    const items = await gitItems(f.repo, "fleets/lab", "2026-03-01", "2026-03-31");
    assertEquals(
      items.map((i) => i.kind),
      ["commit", "commit", "observation", "commit"],
    );
    const observed = got(items[2]);
    assertStringIncludes(observed.name, "fleets/lab/adopted/alice-mbp/observed.ts @ ");
    assertStringIncludes(new TextDecoder().decode(observed.content), `disk: "on"`);
    const c = commitSignature(new TextDecoder().decode(got(items[0]).content));
    assertStringIncludes(got(c.signature), "BEGIN SSH SIGNATURE");
    assert(!c.payload.includes("gpgsig"));
    assert(isObservation("fleets/lab/estate/github.ts"));
    assert(!isObservation("fleets/lab/estate/links.ts"));
    assert(!isObservation("fleets/lab/fleet.ts"));
    await fs.remove(f.dir, { recursive: true });
  },
  { skip: !hasSsh && "ssh-keygen is not installed" },
);

proves(
  [
    "072-evidence-bundles FR-002",
    "072-evidence-bundles FR-003",
    "072-evidence-bundles FR-004",
    "072-evidence-bundles FR-005",
  ],
  "072: a bundle verifies; tampered, missing, added, reordered, and wrongly signed ones fail with the reason",
  async () => {
    const f = await fixture();
    const { m, zip } = await bundle(f);
    const good = await verifyBundle(zip);
    // The unsigned commit is named; everything else checks out.
    assertEquals(good.problems.length, 1, good.problems.join("; "));
    assertStringIncludes(got(good.problems[0]), "not signed");
    assertEquals(good.signer, "alice-daily");
    assertEquals(good.commits.filter((c) => c.signer === "alice-daily").length, 2);

    const obj = `objects/${got(m.items[2]).sha256}`;
    const tampered = await verifyBundle(
      await edit(zip, (x) => (x[obj] = new TextEncoder().encode("forged\n"))),
    );
    assert(
      tampered.problems.some((p) => p.includes("changed (SHA-256")),
      tampered.problems.join("; "),
    );

    const missing = await verifyBundle(await edit(zip, (x) => delete x[obj]));
    assert(missing.problems.some((p) => p.includes("missing (no objects/")));

    const added = await verifyBundle(
      await edit(zip, (x) => (x["objects/extra"] = new Uint8Array([1]))),
    );
    assert(
      added.problems.some((p) => p.includes("objects/extra: in the bundle, not in the manifest")),
    );

    // Reordering or cutting the manifest breaks the chain and the signature.
    const cut = { ...m, items: m.items.slice(0, -1) };
    const cutZip = await edit(
      zip,
      (x) => (x["manifest.json"] = new TextEncoder().encode(manifestText(cut))),
    );
    const c = await verifyBundle(cutZip);
    assert(
      c.problems.some((p) => p.includes("head is not the end of its chain")),
      c.problems.join("; "),
    );
    assert(c.problems.some((p) => p.includes("changed after signing")));
    const swapped = { ...m, items: [got(m.items[1]), got(m.items[0]), ...m.items.slice(2)] };
    const s = await verifyBundle(
      await edit(
        zip,
        (x) => (x["manifest.json"] = new TextEncoder().encode(manifestText(swapped))),
      ),
    );
    assert(s.problems.some((p) => p.includes("the chain breaks here")));

    // Signed by a key that is not a signer.
    const wrong = await bundle(f, f.mallory.key);
    const w = await verifyBundle(wrong.zip);
    assert(
      w.problems.some((p) => p.includes("not an allowed signer")),
      w.problems.join("; "),
    );

    // An auditor's own signers (the fleet's Git allowed_signers) check it too; others do not.
    const own = await verifyBundle(zip, {
      allowedSigners: `alice-daily namespaces="git" ${f.alice.pub}\n`,
    });
    assertEquals(own.signer, "alice-daily");
    const theirs = await verifyBundle(zip, { allowedSigners: `mallory ${f.mallory.pub}\n` });
    assert(theirs.problems.some((p) => p.includes("manifest's signature")));
    assert(!(await verifyBundle(new Uint8Array([1, 2, 3]))).ok);
    await fs.remove(f.dir, { recursive: true });
  },
  { skip: !hasSsh && "ssh-keygen is not installed" },
);

proves(["072-evidence-bundles FR-004"], "072: allowed signers for one namespace", () => {
  assertEquals(
    forNamespace(
      '# c\na namespaces="git" ssh-ed25519 AAAA x\nb ssh-ed25519 BBBB\n',
      "stolos-evidence",
    ),
    '# c\na namespaces="stolos-evidence" ssh-ed25519 AAAA x\nb namespaces="stolos-evidence" ssh-ed25519 BBBB\n',
  );
});

/** The value the test expects to be there. */
function got<T>(value: T | undefined | null, what = "a value"): T {
  assertExists(value, `${what} is missing`);
  return value;
}
