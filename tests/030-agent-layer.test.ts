/**
 * Spec 030 (the agent layer): servers install no agent and get no AI credential; every MCP call is
 * journaled on the server.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { workstation } from "../src/archon/capabilities/mod.ts";
import { SECRET_INVENTORY } from "../src/archon/model/secret-inventory.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { PERSONAS } from "../src/archon/personas/mod.ts";
import { firstBootScript, userData } from "../src/archon/render/autoinstall.ts";
import { TOOLS } from "../src/archon/tools/catalog.ts";
import { fleet, host, KEY } from "./fixtures.ts";
import { ENGINE_ROOT, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";
/** What an AI agent or its credential looks like, in a name or a text. */
const AGENT = /claude|anthropic|openai|copilot|gemini|codex|sk-ant-/i;

proves(
  ["030-agent-layer FR-001"],
  "030: a server installs no agent: no agent tool, no persona feature, no agent dotfiles",
  async () => {
    // Any agent tool the catalog has is a workstation's only.
    for (const t of TOOLS.filter((x) => AGENT.test(`${x.id} ${x.name}`))) {
      assertEquals(t.workstationOnly, true, t.id);
    }
    const server = resolvePlan(host(), fleet());
    assertEquals(
      server.tools.filter((t) => AGENT.test(`${t.id} ${t.name}`) || t.workstationOnly),
      [],
    );
    assert(!server.packages.some((p) => AGENT.test(p.name)));
    // Personas carry no agent feature.
    for (const p of Object.values(PERSONAS)) {
      assertEquals(Object.keys(p.features).sort(), ["devTools", "fish", "tmux"], p.id);
    }
    // The dotfiles every user gets hold nothing of an agent's.
    const home = await fs.walkFiles(path.join(ENGINE_ROOT, "home"));
    assertEquals(
      home.filter((f) => AGENT.test(f)),
      [],
    );
    assert(!server.files.some((f) => AGENT.test(f.path)));
    // A workstation's tools are its own (the server's list holds no workstation-only tool).
    const ws = resolvePlan(
      host({
        name: "pc",
        kind: "workstation",
        user: "alice",
        mac: undefined,
        disk: undefined,
        capabilities: workstation(),
        spec: "020-workstation",
      }),
      fleet(),
    );
    for (const t of TOOLS.filter((x) => x.workstationOnly)) {
      assert(
        ws.tools.some((x) => x.id === t.id),
        t.id,
      );
    }
  },
);

proves(
  ["030-agent-layer FR-002"],
  "030: no AI credential reaches a server: none held, none in the install config, none signed in at first boot",
  () => {
    assertEquals(
      SECRET_INVENTORY.filter((s) => AGENT.test(`${s.id} ${s.label} ${s.purpose}`)).map(
        (s) => s.id,
      ),
      [],
    );
    const u = userData(
      { fleet: fleet(), host: host(), base: "http://10.0.0.5:8080/install/alpha/tok/" },
      {
        passwordHash: "$6$abc$def",
        deployKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
        mailCredential: '{"token":"cfat_x","created":""}',
        webCredential: '{"token":"y"}',
      },
    );
    // The admin's key is the example's; nothing in the config names an agent or its key.
    assert(!AGENT.test(u.replace(KEY, "")), "the install config names no agent");
    const first = firstBootScript(fleet(), host());
    assert(!AGENT.test(first), first);
    assert(!/\blogin\b/.test(first.replace(/gh auth login/g, "")), "first boot signs nothing in");
  },
);

/** A child that answers two MCP calls (one refused, one served) with logger replaced. */
const CHILD = (src: string): string => `
import { handle } from ${JSON.stringify(src)};
await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "archon_backup_run", arguments: {} } }, "read");
await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "archon_verify", arguments: { json: true } } }, "read");
console.log("done");
`;

proves(
  ["030-agent-layer FR-005"],
  "030: every MCP call is journaled with logger -t archon-mcp: the tool, its arguments, SSH_CLIENT",
  async () => {
    const sb = await sandbox("archon-030-");
    try {
      const bin = path.join(sb.home, "bin");
      await fs.mkdir(bin, { recursive: true });
      const log = path.join(sb.home, "logger.txt");
      await fs.writeTextFile(path.join(bin, "logger"), `#!/bin/sh\necho "$@" >> "${log}"\n`);
      await fs.writeTextFile(path.join(bin, "archon"), "#!/bin/sh\necho ok\n");
      for (const f of ["logger", "archon"]) await fs.chmod(path.join(bin, f), 0o755);
      const script = path.join(sb.home, "mcp.ts");
      await fs.writeTextFile(
        script,
        CHILD(new URL("../src/archon/mcp/server.ts", import.meta.url).href),
      );
      const r = await sb.run(script, [], "", {
        PATH: `${bin}:${proc.env.get("PATH") ?? ""}`,
        SSH_CLIENT: "10.0.30.5 51000 22",
        ARCHON_SELF: path.join(bin, "archon"),
      });
      assertEquals(r.code, 0, r.out);
      const lines = (await fs.readTextFile(log)).trim().split("\n");
      assertEquals(lines, [
        "-t archon-mcp refused archon_backup_run {} from 10.0.30.5",
        '-t archon-mcp call archon_verify {"json":true} from 10.0.30.5',
      ]);
      assertStringIncludes(r.out, "done");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "stand-ins for logger and archon written as POSIX shell scripts" },
);
