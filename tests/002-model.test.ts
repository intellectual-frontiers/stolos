/**
 * Specs 002, 014, 018, 020: the model as a fleet repository holds it, found from its folders;
 * `validate` and `build`; and `export`'s RDF, run as a fleet runs them, in a sandbox.
 *
 * @module
 */
import { fs, path } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { ENGINE_ROOT, linkEngine, sandbox, type Sandbox } from "./sandbox.ts";

/** A fleet repository with the example lab, the engine installed, in a fresh sandbox. */
async function lab(): Promise<{ sb: Sandbox; repo: string; env: Record<string, string> }> {
  const sb = await sandbox("archon-model-test-");
  const repo = path.join(sb.home, "fleet");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await fs.copy(
    path.join(ENGINE_ROOT, "examples", "fleets", "lab"),
    path.join(repo, "fleets", "lab"),
  );
  await linkEngine(repo);
  return { sb, repo, env: { ARCHON_REPO: repo, ARCHON_FLEET: "lab" } };
}

const stolos = (l: Awaited<ReturnType<typeof lab>>, args: string[]) =>
  l.sb.run(path.join(ENGINE_ROOT, "src", "stolos", "main.ts"), args, "", l.env);

/** Runs a module in the sandbox and gives the JSON its last line prints. */
async function probe(l: Awaited<ReturnType<typeof lab>>, code: string): Promise<unknown> {
  const file = path.join(l.sb.home, `probe-${crypto.randomUUID()}.ts`);
  const src = (rel: string): string =>
    JSON.stringify(path.toFileUrl(path.join(ENGINE_ROOT, "src", "archon", rel)).href);
  await fs.writeTextFile(
    file,
    code.replace(/@src\/([\w/.-]+)/g, (_, rel: string) => src(rel)),
  );
  const r = await l.sb.run(file, [], "", l.env);
  assertEquals(r.code, 0, r.out);
  return JSON.parse(r.out.trim().split("\n").pop() ?? "null");
}

/** A host file of the lab, as `stolos host add` writes one. */
const hostFile = (
  name: string,
  extra = "",
) => `import type { HostDef } from "@intellectual-frontiers/stolos/archon/model/types";
import { foundation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";

export const host: HostDef = {
  name: "${name}",
  arch: "amd64",
  disk: { match: "largest", layout: "lvm" },
  capabilities: foundation(),
  spec: "004-install",${extra}
};
`;

proves(
  ["002-model FR-001", "020-workstation FR-005"],
  "002: fleet.ts holds the fleet; hosts are found from their folders; the boot machine skips workstations",
  async () => {
    const l = await lab();
    try {
      const hosts = path.join(l.repo, "fleets", "lab", "hosts");
      // A new folder with a host.ts is a host; no index to update.
      await fs.mkdir(path.join(hosts, "gamma"));
      await fs.writeTextFile(path.join(hosts, "gamma", "host.ts"), hostFile("gamma"));
      // A folder starting with _ (a draft) and a folder without host.ts are not hosts.
      await fs.mkdir(path.join(hosts, "_draft"));
      await fs.writeTextFile(path.join(hosts, "_draft", "host.ts"), hostFile("draft"));
      await fs.mkdir(path.join(hosts, "notes"));
      await fs.writeTextFile(path.join(hosts, "notes", "README.md"), "not a host\n");
      // A workstation (spec 020): a host of the model, never installed by the boot machine.
      await fs.mkdir(path.join(hosts, "pc"));
      await fs.writeTextFile(
        path.join(hosts, "pc", "host.ts"),
        `import type { HostDef } from "@intellectual-frontiers/stolos/archon/model/types";
import { workstation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";
export const host: HostDef = { name: "pc", kind: "workstation", arch: "amd64", capabilities: workstation(), spec: "020-workstation" };
`,
      );
      const got = await probe(
        l,
        `import { loadFleet, loadHosts, loadServers } from @src/model/load.ts;
const f = await loadFleet();
console.log(JSON.stringify({
  fleet: [f.id, f.ubuntu.release, f.timezone, f.locale, f.repository.slug],
  hosts: (await loadHosts()).map((h) => h.name),
  servers: (await loadServers()).map((h) => h.name),
}));`,
      );
      assertEquals(got, {
        fleet: ["lab", "26.04", "America/New_York", "en_US.UTF-8", "example/fleet"],
        hosts: ["alpha", "beta", "gamma", "pc"],
        servers: ["alpha", "beta", "gamma"],
      });
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
);

proves(
  ["002-model FR-005"],
  "002: build validates, then renders; validate only validates; an invalid model renders nothing",
  async () => {
    const l = await lab();
    try {
      const rootfs = (h: string) => path.join(l.repo, "out", "lab", "hosts", h, "rootfs");
      let r = await stolos(l, ["validate"]);
      assertEquals(r.code, 0, r.out);
      assert(
        !(await fs.exists(path.join(l.repo, "out", "lab", "hosts"))),
        "validate renders nothing",
      );

      r = await stolos(l, ["build"]);
      assertEquals(r.code, 0, r.out);
      for (const h of ["alpha", "beta"]) {
        assertEquals(
          await fs.readTextFile(path.join(rootfs(h), "etc", "archon", "host")),
          `${h}\n`,
        );
      }
      const before = await fs.readTextFile(
        path.join(rootfs("alpha"), "etc", "ufw", "applications.d", "archon"),
      );

      // An invalid host: validate says what and how to fix it; build renders nothing new.
      const hosts = path.join(l.repo, "fleets", "lab", "hosts");
      await fs.mkdir(path.join(hosts, "gamma"));
      await fs.writeTextFile(
        path.join(hosts, "gamma", "host.ts"),
        hostFile("gamma", '\n  mac: "not-a-mac",'),
      );
      r = await stolos(l, ["validate"]);
      assert(r.code !== 0, r.out);
      assertStringIncludes(r.out, "not-a-mac");
      r = await stolos(l, ["build"]);
      assert(r.code !== 0, r.out);
      assertStringIncludes(r.out, "nothing rendered");
      assert(!(await fs.exists(rootfs("gamma"))), "an invalid model renders nothing");
      assertEquals(
        await fs.readTextFile(path.join(rootfs("alpha"), "etc", "ufw", "applications.d", "archon")),
        before,
      );
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { timeout: 120_000 },
);

proves(
  ["002-model FR-006", "014-state FR-004", "018-out-of-band FR-001"],
  "002: export writes the fleet as Turtle: PROV, Dublin Core, FOAF, archon:, with each host's AMT",
  async () => {
    const l = await lab();
    try {
      // alpha records its AMT address and notes (spec 018).
      const alpha = path.join(l.repo, "fleets", "lab", "hosts", "alpha", "host.ts");
      await fs.writeTextFile(
        alpha,
        (await fs.readTextFile(alpha)).replace(
          'spec: "004-install",',
          'spec: "004-install",\n  outOfBand: { amt: { address: "10.0.30.60", notes: "MEBx password in the vault" } },',
        ),
      );
      // An apply that changed something, recorded as a PROV activity (spec 014).
      await probe(
        l,
        `import { recordActivity } from @src/prov/prov.ts;
const run = await recordActivity("alpha", { started: new Date("2026-11-10T10:00:00Z"), ended: new Date("2026-11-10T10:01:00Z"), changes: ["write /etc/archon/host"], failed: false });
console.log(JSON.stringify(run));`,
      );
      const r = await stolos(l, ["export"]);
      assertEquals(r.code, 0, r.out);
      const ttl = await fs.readTextFile(path.join(l.repo, "out", "lab", "rdf", "fleet.ttl"));
      for (const prefix of [
        "@prefix prov: <http://www.w3.org/ns/prov#> .",
        "@prefix dcterms: <http://purl.org/dc/terms/> .",
        "@prefix foaf: <http://xmlns.com/foaf/0.1/> .",
        "@prefix archon: <https://w3id.org/archon/vocab#> .",
      ]) {
        assertStringIncludes(ttl, prefix);
      }
      // The admin is a FOAF person and PROV agent; the fleet and its hosts are archon: things.
      assertStringIncludes(ttl, "a foaf:Person, prov:Agent");
      assertStringIncludes(ttl, 'foaf:name "Alice Example"');
      assertStringIncludes(ttl, "a archon:Fleet");
      assertStringIncludes(ttl, 'dcterms:identifier "alpha"');
      assertStringIncludes(ttl, 'dcterms:identifier "beta"');
      // Every spec, with its title.
      assertStringIncludes(ttl, "<https://w3id.org/archon/id/spec/001-platform>");
      // The recorded apply is a PROV activity of alpha.
      assertStringIncludes(ttl, "a prov:Activity");
      assertStringIncludes(ttl, 'prov:startedAtTime "2026-11-10T10:00:00.000Z"^^xsd:dateTime');
      assertStringIncludes(ttl, 'archon:change "write /etc/archon/host"');
      // AMT, published.
      assertStringIncludes(ttl, 'archon:amtAddress "10.0.30.60"');
      assertStringIncludes(ttl, 'archon:amtNotes "MEBx password in the vault"');
      // The site, with SKOS labels where they fit.
      const site = await fs.readTextFile(path.join(l.repo, "out", "lab", "rdf", "site.ttl"));
      assertStringIncludes(site, "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .");
      assertStringIncludes(site, "skos:prefLabel");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
);
