/**
 * Spec 042: SQL over infrastructure.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { engineFile } from "../src/archon/core/assets.ts";
import {
  assertExists,
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { fleet, host, at } from "./fixtures.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { TOOLS } from "../src/archon/tools/catalog.ts";

/** A tool of the catalog, which must be there. */
const tool = (id: string): (typeof TOOLS)[number] => {
  const t = TOOLS.find((x) => x.id === id);
  assertExists(t, `no tool ${id}`);
  return t;
};

proves(
  ["042-sql FR-001", "042-sql FR-004", "042-sql FR-005", "042-sql FR-006", "042-sql FR-007"],
  "042: the tools, their sources, and where they go",
  () => {
    assertEquals(tool("osquery").source, "apt");
    assertEquals(tool("osquery").repo?.uri, "https://pkg.osquery.io/deb");
    assertEquals([tool("jc").source, tool("sqlite3").source], ["apt", "apt"]);
    assertEquals(
      [tool("duckdb").source, tool("steampipe").source],
      ["upstream-binary", "upstream-binary"],
    );
    assert(tool("steampipe").workstationOnly, "the operator's credentials stay off servers");
    for (const id of ["osquery", "duckdb", "jc", "sqlite3"]) {
      assert(!tool(id).serverOnly && !tool(id).workstationOnly, `${id} on every host`);
    }
    for (const id of ["cloudquery", "trdsql", "q", "csvkit", "sq"]) {
      assertEquals(
        TOOLS.find((t) => t.id === id),
        undefined,
      );
    }
  },
);

proves(
  ["042-sql FR-001"],
  "042: osquery's key is pinned and is the one osquery publishes",
  async () => {
    const { OSQUERY_KEY, OSQUERY_KEY_FINGERPRINT } =
      await import("../src/archon/tools/keys/osquery.ts");
    assertEquals(OSQUERY_KEY_FINGERPRINT, "1484120AC4E9F8A1A577AEEE97A80C63C9D8B80B");
    assert(OSQUERY_KEY.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----"));
    assertEquals(tool("osquery").repo?.key, OSQUERY_KEY);
    if (proc.which("gpg") !== undefined) {
      // Its own home folder: a runner's (or a person's) keyring is neither needed nor touched.
      const home = await fs.makeTempDir({ prefix: "archon-gpg-" });
      // The key on standard input, and the folder as "." from inside it: Git for Windows' gpg takes
      // C:\... and C:/... for relative paths (it would look in /d/a/.../C:/...).
      const r = await proc.output(["gpg", "--homedir", ".", "--show-keys", "--with-colons"], {
        cwd: home,
        input: OSQUERY_KEY,
        stdout: "piped",
        stderr: "piped",
      });
      await fs.remove(home, { recursive: true });
      assertStringIncludes(
        new TextDecoder().decode(r.stdout),
        `fpr:::::::::${OSQUERY_KEY_FINGERPRINT}:`,
        new TextDecoder().decode(r.stderr),
      );
    }
  },
);

proves(
  ["042-sql FR-004", "042-sql FR-006"],
  "042: release assets, as each project's release build names them",
  () => {
    const duck = tool("duckdb").github?.asset("amd64", "2.0.0");
    assertExists(duck);
    assert(duck.test("duckdb-cli-linux-amd64.tar.gz"));
    assert(duck.test("duckdb_cli-linux-amd64.zip"), "1.x naming");
    assert(!duck.test("duckdb-cli-linux-arm64.tar.gz"));
    assert(!duck.test("duckdb-shared-libs-linux-amd64.tar.gz"));
    const sp = tool("steampipe").github?.asset("amd64", "2.4.9");
    assertExists(sp);
    assert(sp.test("steampipe_linux_amd64.tar.gz"));
    assert(!sp.test("steampipe_linux_arm64.tar.gz"));
    assert(!sp.test("steampipe_darwin_amd64.zip"));
  },
);

proves(
  ["042-sql FR-002", "042-sql FR-003"],
  "042: osqueryd is infrastructure: enabled and running everywhere, Archon's flags and schedule, no port",
  async () => {
    const { OSQUERY, OSQUERY_FLAGS, OSQUERY_SCHEDULE, osqueryConf } =
      await import("../src/archon/capabilities/osquery.ts");
    const ws = host({
      name: "pc",
      kind: "workstation",
      user: "alice",
      mac: undefined,
      disk: undefined,
    });
    for (const h of [host(), ws]) {
      const plan = resolvePlan(h, fleet());
      const u = plan.units.find((x) => x.unitName === "osqueryd.service");
      assertExists(u);
      assertEquals([u.state, u.start, u.switch], ["enabled", true, undefined], h.name);
      assertStringIncludes(u.verify, "SELECT 1");
      assert(
        plan.files.some(
          (f) => f.path === OSQUERY.conf && f.onChange?.some((a) => a.kind === "restart"),
        ),
      );
      // The package puts osqueryi on the PATH; Archon adds no link of its own.
      assert(!plan.files.some((f) => f.path.endsWith("/osqueryi")));
      // It listens on nothing, so nothing is opened for it.
      assert(!plan.ports.some((p) => p.spec === "042-sql"));
    }
    for (const f of [
      "--logger_plugin=filesystem",
      "--logger_rotate=true",
      "--disable_events=true",
      "--host_identifier=hostname",
    ]) {
      assertStringIncludes(OSQUERY_FLAGS, f);
    }
    assert(!/--config_path|--pidfile/.test(OSQUERY_FLAGS), "the package's unit passes those");
    const conf: unknown = JSON.parse(osqueryConf());
    assertEquals(
      Object.keys(at(conf, "schedule") ?? {}).sort(),
      Object.keys(OSQUERY_SCHEDULE).sort(),
    );
    for (const [name, q] of Object.entries(OSQUERY_SCHEDULE)) {
      assert(q.interval >= 300, `${name}: no tighter than every 5 minutes`);
      assert(q.query.trim().endsWith(";"), name);
    }
    assertStringIncludes(
      String(at(conf, "schedule", "listening_ports", "query")),
      "listening_ports",
    );
  },
);

proves(["042-sql FR-009"], "042: the guide, the served page, and the man page", async () => {
  const doc = engineFile("docs/sql.md");
  for (const s of [
    "sudo osqueryi",
    "listens on no port",
    "INSTALL httpfs",
    "jc --df",
    "steampipe plugin install",
  ]) {
    assertStringIncludes(doc, s);
  }
  const { GUIDES } = await import("../src/archon/web/serve.ts");
  assert(GUIDES.some((g) => g.name === "sql"));
  const { guideFor } = await import("../src/archon/guide/guide.ts");
  assert(guideFor(resolvePlan(host(), fleet())).some((x) => x.id === "sql"));
  const { sqlPage } = await import("../src/archon/render/man.ts");
  assertStringIncludes(sqlPage(), "archon\\-sql");
});

proves(
  ["042-sql FR-008"],
  "042: verify: osqueryd active and osqueryi answering; each tool's version command",
  () => {
    const ws = host({
      name: "pc",
      kind: "workstation",
      user: "alice",
      mac: undefined,
      disk: undefined,
    });
    for (const [h, ids] of [
      [host(), ["osquery", "duckdb", "jc", "sqlite3"]],
      [ws, ["osquery", "duckdb", "jc", "sqlite3", "steampipe"]],
    ] as const) {
      const plan = resolvePlan(h, fleet());
      const u = plan.units.find((x) => x.unitName === "osqueryd.service");
      assertExists(u);
      assertEquals(
        u.verify,
        `sh -c 'systemctl is-active --quiet osqueryd.service && osqueryi --json "SELECT 1 AS ok;" | grep -q ok'`,
      );
      // archon verify runs every planned tool's verify (src/archon/state/verify.ts): its version.
      for (const id of ids) {
        const t = plan.tools.find((x) => x.id === id);
        assertExists(t, `${id} on ${h.name}`);
        assertStringIncludes(t.verify, "version", id);
        assertEquals(t.verify.split(" ").pop(), t.versionCommand.split(" ").pop(), id);
      }
    }
    // On a real host, tests/e2e/lib.sh requires every one of these checks to pass (archon verify).
  },
);
