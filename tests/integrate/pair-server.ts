/**
 * Spec 098 (tests): a pairing server for one machine with a fixed code and a fixed key, that
 * approves the first signed check-in and writes it to a file. `tests/pair098.test.ts` runs it in
 * process; `tests/integrate/windows-check.ps1` runs it as a program on Windows CI:
 *
 * ```sh
 * bun tests/integrate/pair-server.ts <code> <public key> <check-in file>
 * ```
 *
 * It prints its URL on the first line, and exits 0 once a check-in was approved.
 *
 * @module
 */

import { fs, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { listen } from "../../src/archon-boot/http.ts";
import { PairSession } from "../../src/archon/adopt/pair.ts";

/** Serve one pairing on 127.0.0.1; its URL, the session, and a way to stop it. */
export async function servePair(o: {
  code: string;
  key: string;
  fleet?: string;
  name?: string;
  onCheckIn?: (text: string) => Promise<void> | void;
}): Promise<{ url: string; session: PairSession; close: () => void }> {
  const box: { session?: PairSession } = {};
  const listener = await listen(
    0,
    (req) =>
      box.session ? box.session.handle(req) : Promise.resolve(new Response("", { status: 503 })),
    "127.0.0.1",
  );
  const url = `http://127.0.0.1:${(listener.addr as { port: number }).port}`;
  const session = new PairSession({
    fleet: o.fleet ?? "lab",
    engine: "v0.0.0",
    url,
    code: o.code,
    nameFor: (hostname) =>
      Promise.resolve({ name: o.name ?? hostname.toLowerCase().split(".")[0] ?? "m", key: o.key }),
    approve: async (text, hello) => {
      await o.onCheckIn?.(text);
      return { ok: true, message: `${hello.name} is adopted by the fleet ${o.fleet ?? "lab"}` };
    },
  });
  box.session = session;
  return { url, session, close: () => listener.close() };
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
