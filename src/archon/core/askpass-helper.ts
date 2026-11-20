/**
 * The program OpenSSH runs for a passphrase while a command signs (spec 106-one-passphrase-speed
 * FR-002): it asks the command that started the signing, over 127.0.0.1, with the token made for
 * that command, and writes the answer to standard output for OpenSSH. It holds no secret itself,
 * keeps nothing, and logs nothing; started without the command's address it fails, which tells
 * OpenSSH no.
 *
 * @module
 */
// Spec: 106-one-passphrase-speed FR-002

import { proc, stdio } from "@intellectual-frontiers/system";

/** How long to wait for the command's answer (the person has five minutes, spec 106 FR-004). */
const WAIT_MS = 5 * 60_000 + 30_000;

if (import.meta.main) {
  const url = proc.env.get("STOLOS_PASSPHRASE_URL") ?? "";
  const token = proc.env.get("STOLOS_PASSPHRASE_TOKEN") ?? "";
  const scope = proc.env.get("STOLOS_PASSPHRASE_SCOPE") ?? "";
  const prompt = proc.args.join(" ") || "Enter passphrase:";
  try {
    if (!url || !token) proc.exit(1);
    const r = await fetch(`${url}/ask`, {
      method: "POST",
      headers: {
        "x-stolos-askpass": token,
        "x-stolos-scope": encodeURIComponent(scope),
        "content-type": "text/plain; charset=utf-8",
      },
      body: prompt,
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (r.status !== 200) proc.exit(1);
    const answer = new Uint8Array(await r.arrayBuffer());
    stdio.stdout.writeSync(answer);
    stdio.stdout.writeSync("\n");
    answer.fill(0);
    proc.exit(0);
  } catch {
    proc.exit(1);
  }
}
