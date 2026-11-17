/**
 * Specs 098, 103-three-ports and 107-pairing-and-query (tests): a pairing session with a fixed code and a fixed key, serving
 * `/device/pair` as the boot server's door does, that approves every signed check-in (as many machines as come) and writes the first
 * to a file. The session never ends by itself. `tests/pair098.test.ts` runs it in process; `tests/integrate/windows-check.ps1` runs
 * it as a program on Windows CI:
 *
 * ```sh
 * bun tests/integrate/pair-server.ts <code> <public key> <check-in file>
 * ```
 *
 * It prints the pairing's base URL (`http://127.0.0.1:<port>/device/pair`, what `--pair` takes) on the first line, and exits 0 once the first check-in was approved (a session is otherwise open until stopped).
 *
 * @module
 */
// Spec: 098-pair FR-001, FR-006
// Spec: 103-three-ports FR-003
// Spec: 107-pairing-and-query FR-001, FR-002, FR-014

import { fs, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { listen } from "../../src/archon-boot/http.ts";
import { PairSession } from "../../src/archon/adopt/pair.ts";
import { MemoryPairStore, newPairRecord } from "../../src/archon/adopt/pair-store.ts";
import { DEVICE_PAIR_PATH } from "../../src/archon/ontology.auto.ts";

/** Serve one pairing on 127.0.0.1; its base URL (`<origin>/device/pair`), the session, and a way to stop it. */
export async function servePair(o: {
  code: string;
  key: string;
  fleet?: string;
  name?: string;
  onCheckIn?: (text: string) => Promise<void> | void;
  pollMs?: number;
}): Promise<{
  url: string;
  origin: string;
  session: PairSession;
  store: MemoryPairStore;
  /** Resolves with the machine's name when the first check-in was approved. */
  approved: Promise<string>;
  close: () => void;
}> {
  const fleet = o.fleet ?? "lab";
  let approve: (name: string) => void = () => undefined;
  const approved = new Promise<string>((ok) => (approve = ok));
  const store = new MemoryPairStore(
    newPairRecord({ code: o.code, fleet, engine: "stolos-v0.0.0" }),
  );
  const session = new PairSession({
    store,
    ...(o.pollMs ? { pollMs: o.pollMs } : {}),
    nameFor: (hostname) =>
      Promise.resolve({ name: o.name ?? hostname.toLowerCase().split(".")[0] ?? "m", key: o.key }),
    approve: async (text, hello) => {
      await o.onCheckIn?.(text);
      approve(hello.name);
      return { ok: true, message: `${hello.name} is adopted by the fleet ${fleet}` };
    },
  });
  const listener = await listen(0, (req, from) => session.handle(req, from), "127.0.0.1");
  const origin = `http://127.0.0.1:${(listener.addr as { port: number }).port}`;
  return {
    url: `${origin}${DEVICE_PAIR_PATH}`,
    origin,
    session,
    store,
    approved,
    close: () => listener.close(),
  };
}

/**
 * Wait until the first approved machine has been told (its held check-in was answered), then a moment more for the bytes to leave,
 * and close the server. The process of `windows-check.ps1` exits after this, so it must never exit while a client still waits for its
 * answer: a client of a slow Windows runner polls late, and "the PC did not answer" is what it reports when the process is gone.
 */
export async function untilDelivered(
  s: { approved: Promise<string>; store: MemoryPairStore; close: () => void },
  graceMs = 500,
): Promise<void> {
  await s.approved;
  for (;;) {
    const r = await s.store.read();
    if (!r || Object.values(r.machines).some((m) => m.delivered)) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  await new Promise((ok) => setTimeout(ok, graceMs));
  s.close();
}

if (import.meta.main) {
  const [code = "", key = "", out = "checkin.txt"] = proc.args;
  const s = await servePair({
    code,
    key,
    fleet: "ci",
    onCheckIn: (t) => fs.writeTextFile(out, t),
  });
  stdio.stdout.writeSync(`${s.url}\n`);
  await untilDelivered(s);
  proc.exit(0);
}
