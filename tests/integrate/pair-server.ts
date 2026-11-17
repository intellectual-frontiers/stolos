/**
 * Specs 098 and 103-three-ports (tests): a pairing server for one machine with a fixed code and a fixed key, serving
 * `/device/pair` as the boot server's door does, that approves the first signed check-in and writes it to a file. `tests/pair098.test.ts` runs it in
 * process; `tests/integrate/windows-check.ps1` runs it as a program on Windows CI:
 *
 * ```sh
 * bun tests/integrate/pair-server.ts <code> <public key> <check-in file>
 * ```
 *
 * It prints the pairing's base URL (`http://127.0.0.1:<port>/device/pair`, what `--pair` takes) on the first line, and exits 0 once a check-in was approved.
 *
 * @module
 */
// Spec: 098-pair FR-001, FR-006
// Spec: 103-three-ports FR-003

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
}): Promise<{ url: string; origin: string; session: PairSession; close: () => void }> {
  const fleet = o.fleet ?? "lab";
  const session = new PairSession({
    store: new MemoryPairStore(newPairRecord({ code: o.code, fleet, engine: "v0.0.0" })),
    ...(o.pollMs ? { pollMs: o.pollMs } : {}),
    nameFor: (hostname) =>
      Promise.resolve({ name: o.name ?? hostname.toLowerCase().split(".")[0] ?? "m", key: o.key }),
    approve: async (text, hello) => {
      await o.onCheckIn?.(text);
      return { ok: true, message: `${hello.name} is adopted by the fleet ${fleet}` };
    },
  });
  const listener = await listen(0, (req) => session.handle(req), "127.0.0.1");
  const origin = `http://127.0.0.1:${(listener.addr as { port: number }).port}`;
  return { url: `${origin}${DEVICE_PAIR_PATH}`, origin, session, close: () => listener.close() };
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
  const end = await s.session.done();
  await new Promise((r) => setTimeout(r, 500));
  s.close();
  proc.exit(end === "paired" ? 0 : 1);
}
