/**
 * Spec 084: connectors are labeled with NIST and analyst categories. (The estate graph of spec 085
 * is spec 090's now: tests/estate090_test.ts.)
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { MARKET_CATEGORIES, SERVICE_MODELS } from "../src/archon/connect/connector.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";

proves(
  ["084-connectors FR-001"],
  "084: every connector's service models are NIST's, and its markets are named by analyst firms",
  () => {
    const ids = new Set(MARKET_CATEGORIES.map((m) => m.id));
    for (const c of CONNECTORS) {
      assert(
        c.serviceModels.length > 0 &&
          c.serviceModels.every((m) => (SERVICE_MODELS as readonly string[]).includes(m)),
        c.id,
      );
      assert(
        c.markets.length > 0 && c.markets.every((m) => ids.has(m)),
        `${c.id}: ${c.markets.join(", ")}`,
      );
    }
    for (const m of MARKET_CATEGORIES) {
      assert(/^(Gartner|Forrester|IDC|NIST)/.test(m.source), `${m.id}: a published source`);
    }
  },
);

proves(
  ["085-estate-graph FR-001"],
  "085: connectors' records become normalized people, accounts, devices and repositories; the fleet's machines add theirs",
  async () => {
    const { toEntities } = await import("../src/archon/connect/sdk.ts");
    const { readSnapshot, gitReader } = await import("../src/archon/estate/snapshot.ts");
    const { buildGraph, estateQuery } = await import("../src/archon/estate/graph.ts");
    const { fs } = await import("@intellectual-frontiers/ifc-ts/runtime");
    const rec = (label: string, native_id: string, props: Record<string, unknown>) => ({
      label,
      ocsf_class_uid: 0,
      native_id,
      display_name: native_id,
      props,
    });
    const { entities, rest } = toEntities("example", [
      // An HR roster's person: the roster's fields only, whatever else the record carried.
      rec("person", "1", {
        email: "alice@example.org",
        name: "Alice",
        status: "active",
        start_date: "2024-01-02",
        end_date: "2026-12-31",
        manager: "carol@example.org",
        role_type: "employee",
        salary: 100000,
        home_address: "1 Example Street",
      }),
      rec("user_account", "u1", {
        email: "alice@example.org",
        active: true,
        admin: true,
        mfa: false,
        last_sign_in: "2026-11-01",
        service: false,
      }),
      rec("hardware_device", "d1", {
        owner: "alice@example.org",
        serial_number: "C02X",
        encrypted: true,
      }),
      rec("code_repository", "example/app", { private: true, protected: false }),
      rec("dns_record", "r1", {}),
    ]);
    assertEquals(Object.keys(entities.people?.[0] ?? {}).sort(), [
      "email",
      "end",
      "manager",
      "name",
      "start",
      "status",
      "type",
    ]);
    assert(!JSON.stringify(entities).includes("100000"), "never compensation");
    assert(!JSON.stringify(entities).includes("Example Street"), "never personal fields");
    const account = entities.accounts?.[0];
    assertEquals(
      [account?.system, account?.id, account?.email, account?.active, account?.admin, account?.mfa],
      ["example", "u1", "alice@example.org", true, true, false],
    );
    assertEquals(entities.devices?.[0]?.serial, "C02X");
    assertEquals(entities.repositories?.[0]?.name, "example/app");
    assertEquals(
      rest.map((r) => r.label),
      ["dns_record"],
      "other records stay records",
    );
    // The fleet's own machines: a managed host, an adopted machine, an SNMP device.
    const dir = await fs.makeTempDir();
    try {
      const f = `${dir}/fleets/lab`;
      for (const d of ["hosts/alpha", "adopted/alice-mbp", "devices/printer"]) {
        await fs.mkdir(`${f}/${d}`, { recursive: true });
      }
      await fs.writeTextFile(`${f}/hosts/alpha/host.ts`, "export const host = {};\n");
      await fs.writeTextFile(
        `${f}/adopted/alice-mbp/machine.ts`,
        'export const machine = { name: "alice-mbp", owner: "alice@example.org" };\n',
      );
      await fs.writeTextFile(
        `${f}/devices/printer/device.ts`,
        'export const device = { name: "printer", kind: "printer" };\n',
      );
      await fs.writeTextFile(
        `${f}/devices/printer/observed.ts`,
        'export const observed = { at: "2026-11-01T00:00:00Z", serial: "VNB0", model: "LaserJet" };\n',
      );
      const s = await readSnapshot(gitReader(dir), "lab");
      assertEquals(
        s.machines.map((m) => [m.source, m.id]),
        [
          ["stolos", "alpha"],
          ["adopted", "alice-mbp"],
          ["snmp", "printer"],
        ],
      );
      const e = buildGraph(s);
      assertEquals(estateQuery(e, "select count(*) as n from device"), [{ n: 3 }]);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["085-estate-graph FR-002"],
  "085: stolos estate query runs one SELECT over the last observations, in memory, and writes nothing",
  async () => {
    const { fs, path } = await import("@intellectual-frontiers/ifc-ts/runtime");
    const { sandbox, linkEngine, fingerprint } = await import("./sandbox.ts");
    const { observationSource } = await import("../src/archon/connect/connector.ts");
    const sb = await sandbox("stolos-estate-query-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets", "lab", "estate"), { recursive: true });
      await fs.copy("examples/fleets/lab", path.join(repo, "fleets", "lab"), { overwrite: true });
      await linkEngine(repo);
      await fs.writeTextFile(
        path.join(repo, "fleets", "lab", "estate", "okta.ts"),
        observationSource({
          at: "2026-11-01T00:00:00Z",
          provider: "okta",
          account: "example.okta.com",
          assets: [],
          posture: {},
          gaps: [],
          entities: {
            accounts: [
              {
                system: "okta",
                id: "1",
                name: "alice",
                email: "alice@example.org",
                active: true,
                admin: true,
                mfa: false,
              },
              {
                system: "okta",
                id: "2",
                name: "bob",
                email: "bob@example.org",
                active: true,
                admin: false,
                mfa: true,
              },
            ],
          },
        }),
      );
      const before = await fingerprint([repo]);
      const closed = "http://127.0.0.1:9";
      const q = (sql: string, ...more: string[]) =>
        sb.run("src/stolos/main.ts", ["estate", "query", sql, ...more], "", {
          ARCHON_REPO: repo,
          ARCHON_FLEET: "lab",
          HTTPS_PROXY: closed,
          HTTP_PROXY: closed,
        });
      let r = await q(
        "select display_name from user_account where admin = 1 and mfa = 0",
        "--json",
      );
      assertEquals(r.code, 0, r.out);
      assertEquals(JSON.parse(r.out.slice(r.out.indexOf("["), r.out.lastIndexOf("]") + 1)), [
        { display_name: "alice" },
      ]);
      for (const bad of [
        "delete from user_account",
        "select 1; drop table user_account",
        "attach database 'x' as y",
      ]) {
        r = await q(bad);
        assertEquals(r.code, 1, `${bad}: ${r.out}`);
        assertStringIncludes(r.out, "refused");
      }
      // With --json, a failure is an object a program can read, never nothing.
      for (const bad of ["delete from user_account", "select * from no_such_table"]) {
        r = await q(bad, "--json");
        assertEquals(r.code, 1, `${bad}: ${r.out}`);
        const o: unknown = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1));
        assert(
          typeof o === "object" && o !== null && "error" in o && "fix" in o,
          `${bad}: ${r.out}`,
        );
      }
      assertEquals(await fingerprint([repo]), before, "nothing written");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);
