/**
 * Spec 053: where am I, and the one command to run next.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { nextCommand, type WhereFacts, whereSteps } from "../src/archon/guide/where.ts";
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { ENGINE_ROOT, fingerprint, linkEngine, sandbox } from "./sandbox.ts";

const ready: WhereFacts = {
  fleets: ["fcr"],
  fleetId: "fcr",
  pinned: "v0.20.0",
  locked: true,
  signers: { daily: 1, recovery: 1 },
  signingProblems: [],
  adminHash: true,
  mail: { token: true },
  web: { token: true },
  hosts: [{ name: "olympia", workstation: false, installed: true, armed: false, claim: false }],
  dirty: false,
  unpushed: 0,
};

proves(["053-where-am-i FR-001"], "053: everything done: fleet status is next", () => {
  const s = whereSteps(ready);
  assert(
    s.every((x) => x.state === "done"),
    JSON.stringify(s),
  );
  assertStringIncludes(nextCommand(s), "fleet status");
});

proves(["053-where-am-i FR-001"], "053: a new repository: create the fleet, or choose one", () => {
  const { fleetId: _, ...withoutFleet } = ready;
  assertStringIncludes(nextCommand(whereSteps({ ...withoutFleet, fleets: [] })), "fleet init");
  assertStringIncludes(
    nextCommand(whereSteps({ ...withoutFleet, fleets: ["fcr", "synthetic-uat"] })),
    "fleet use fcr",
  );
});

proves(
  ["053-where-am-i FR-001", "053-where-am-i FR-003"],
  "053: exactly one next step, the first not done; pending never blocks",
  () => {
    const s = whereSteps({
      ...ready,
      signers: { daily: 0, recovery: 0 },
      mail: { token: false },
      hosts: [
        { name: "olympia", workstation: false, installed: false, armed: false, claim: false },
      ],
    });
    assertEquals(s.filter((x) => x.state === "next").length, 1);
    assertStringIncludes(nextCommand(s), "keys setup");
    assert(s.some((x) => x.state === "pending" && x.command === "bun run stolos boot mail-setup"));
    assert(s.some((x) => x.state === "todo" && x.command?.includes("boot arm olympia --claim")));
    // Only a pending item left: it is what to do next.
    const p = whereSteps({ ...ready, mail: { token: false } });
    assertEquals(p.filter((x) => x.state === "next").length, 0);
    assertEquals(nextCommand(p), "bun run stolos boot mail-setup");
  },
);

proves(
  ["053-where-am-i FR-001"],
  "053: an armed host says to keep the boot server running; no server says host add --claim",
  () => {
    const armed = whereSteps({
      ...ready,
      hosts: [{ name: "olympia", workstation: false, installed: false, armed: true, claim: true }],
    });
    assertStringIncludes(nextCommand(armed), "boot serve");
    assertStringIncludes(
      nextCommand(whereSteps({ ...ready, hosts: [] })),
      "host add <name> --claim",
    );
    assertStringIncludes(nextCommand(whereSteps({ ...ready, unpushed: 2 })), "stolos apply");
  },
);

/** The example lab as a fresh fleet repository in a sandbox: no signers yet, not committed. */
async function freshFleet() {
  const sb = await sandbox("archon-where-test-");
  const repo = path.join(sb.home, "fleet");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await proc.output([
    "cp",
    "-r",
    path.join(ENGINE_ROOT, "examples/fleets/lab"),
    `${repo}/fleets/lab`,
  ]);
  await linkEngine(repo);
  await fs.remove(path.join(repo, "fleets", "lab", "signers.ts"));
  await fs.writeTextFile(path.join(repo, ".gitignore"), "node_modules/\nout/\n");
  await proc.output(["git", "init", "-q", "-b", "main", repo]);
  const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab", GIT_CONFIG_NOSYSTEM: "1" };
  const stolos = (...args: string[]) => sb.run("src/stolos/main.ts", args, "", env);
  return { sb, repo, stolos };
}

proves(
  ["053-where-am-i FR-002"],
  "053: each step is computed from the real state every time; nothing about progress is stored",
  async () => {
    const f = await freshFleet();
    try {
      const where = async () => {
        const r = await f.stolos("--json");
        assertEquals(r.code, 0, r.out);
        return JSON.parse(r.out.slice(r.out.indexOf("{"))) as {
          facts: { signers: { daily: number }; adminHash: boolean; dirty: boolean };
          next: string;
        };
      };
      // Everything this PC keeps, before: where am I writes none of it.
      const kept = [
        path.join(f.sb.home, "config"),
        path.join(f.sb.home, "data", "stolos", "state"),
      ];
      const before = await fingerprint(kept);
      let w = await where();
      assertEquals(w.facts.signers.daily, 0);
      assertEquals(await fingerprint(kept), before, "nothing stored");
      // The state changes by other means (signers.ts, the secret store, Git): the answer follows.
      const key = path.join(f.sb.home, "k");
      await proc.output(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
      assertEquals(
        (await f.stolos("signers", "add", "pc", "--role", "daily", "--key", `${key}.pub`)).code,
        0,
      );
      const secrets = path.join(f.sb.home, "config", "stolos", "secrets", "lab");
      await fs.mkdir(secrets, { recursive: true });
      await fs.writeTextFile(path.join(secrets, "admin-password.hash"), "$6$x$y\n");
      w = await where();
      assertEquals(w.facts.signers.daily, 1);
      assertEquals(w.facts.adminHash, true);
      assertEquals(w.facts.dirty, true, "Git: uncommitted changes");
    } finally {
      await fs.remove(f.sb.home, { recursive: true });
    }
  },
  { timeout: 120_000 },
);

proves(
  ["053-where-am-i FR-005"],
  "053: host add warns, with its code, when the fleet has no daily signer",
  async () => {
    const f = await freshFleet();
    try {
      const r = await f.stolos("host", "add", "gamma", "--claim", "--no-deploy-key", "--no-push");
      assertStringIncludes(
        r.out,
        "the fleet has no daily signer: gamma will install, but refuse every change after",
      );
      assertStringIncludes(r.out, "E047-NO-SIGNERS");
      assertStringIncludes(r.out, "stolos signers add");
    } finally {
      await fs.remove(f.sb.home, { recursive: true });
    }
  },
  { timeout: 120_000 },
);
