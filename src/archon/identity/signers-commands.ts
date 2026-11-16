/**
 * `stolos signers` (spec 047-intent-and-identity): list, add, and remove the
 * fleet's signers (fleets/<id>/signers.ts, in its fixed form), and, on a host
 * in an emergency, trust a key a person types there.
 *
 * @module
 */
// Spec: 047-intent-and-identity

import { fs, path, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { count } from "../core/telemetry.ts";
import { P, repoRel } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { journal } from "../core/log.ts";
import type { SignerDef } from "../model/types.ts";
import {
  ALLOWED_SIGNERS,
  ALLOWED_SIGNERS_LOCAL,
  allowedSignersText,
  loadSigners,
  signerProblems,
  signersFile,
  signersSource,
  signingSetup,
} from "./signers.ts";

/** A public key from the argument: the key itself, or a .pub file (its comment dropped). */
async function readKey(arg: string): Promise<string> {
  const text = (await fs.exists(arg)) ? await fs.readTextFile(arg) : arg;
  return text.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** stolos signers: the list, and this machine's signing setup. */
export async function signersList(json: boolean): Promise<number> {
  const list = await loadSigners();
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  const p = ui.phase(`Signers of ${P.fleetId || "(no fleet)"}`);
  for (const s of list) {
    stdio.stdout.writeSync(
      `  ${s.role.padEnd(9)} ${s.name.padEnd(24)} ${s.key.slice(0, 40)}...  ${s.added}\n`,
    );
  }
  for (const pr of signerProblems(list)) p.fail(pr.message, pr.fix);
  if (!list.some((s) => s.role === "recovery")) {
    p.warn(
      "no recovery signer: losing the daily key freezes the fleet",
      "stolos signers add <name> --role recovery --key <.pub> (keep the private key offline)",
    );
  }
  p.done(`${list.length} signer(s) in ${repoRel(signersFile())}`);
  const s = ui.phase("Your signing setup (bun run stolos keys)");
  for (const c of await signingSetup()) {
    if (c.ok) s.note(c.what);
    else s.warn(c.what, c.fix);
  }
  s.done();
  return ui.finish();
}

async function write(list: SignerDef[]): Promise<string> {
  const file = signersFile();
  await fs.ensureDir(path.dirname(file));
  await fs.writeTextFile(file, signersSource(list));
  return repoRel(file);
}

/** stolos signers add. */
export async function signersAdd(name: string, role: string, keyArg: string): Promise<number> {
  if (role !== "daily" && role !== "recovery") throw new Error("--role is daily or recovery");
  const list = await loadSigners();
  const key = await readKey(keyArg);
  const next: SignerDef[] = [
    ...list.filter((s) => s.name !== name),
    { name, role, key, added: new Date().toISOString().slice(0, 10) },
  ];
  const problems = signerProblems(next).filter((p) => !p.message.startsWith("no daily"));
  const p = ui.phase("Signers");
  if (problems.length) {
    for (const pr of problems) p.fail(pr.message, pr.fix);
    return ui.finish();
  }
  const rel = await write(next);
  p.done(`${name} (${role}) in ${rel}`);
  ui.next.push(
    `commit and push it signed by a key already listed (git commit -S): hosts accept the new list only that way`,
  );
  return ui.finish();
}

/** stolos signers remove. */
export async function signersRemove(name: string): Promise<number> {
  const list = await loadSigners();
  const p = ui.phase("Signers");
  if (!list.some((s) => s.name === name)) {
    p.fail(`no signer ${name}`, "stolos signers list");
    return ui.finish();
  }
  const next = list.filter((s) => s.name !== name);
  const rel = await write(next);
  p.done(`removed ${name} from ${rel}`);
  ui.next.push("commit and push it signed by another listed key (git commit -S)");
  return ui.finish();
}

/**
 * Emergency (spec 047): every signing key is lost. A person on the host itself
 * (never an agent, never over MCP) trusts a new public key here; the next apply
 * keeps it until the fleet's signers.ts lists it, signed by it.
 */
export async function signersTrust(keyArg: string, name: string): Promise<number> {
  const key = await readKey(keyArg);
  const p = ui.phase("Trust a signer on this host");
  const problems = signerProblems([{ name, role: "daily", key, added: "" }]);
  if (problems.length) {
    for (const pr of problems) p.fail(pr.message, pr.fix);
    return ui.finish();
  }
  const local = (await fs.readTextOr(ALLOWED_SIGNERS_LOCAL)) ?? "";
  const line = `${name} namespaces="git" ${key}`;
  if (!local.includes(key)) {
    await fs.writeTextFile(ALLOWED_SIGNERS_LOCAL, local + line + "\n", { mode: 0o644 });
  }
  const fleet = (await import("../model/load.ts")).loadFleet;
  const signers = (await fleet().catch(() => undefined))?.signers ?? [];
  await fs.writeTextFile(
    ALLOWED_SIGNERS,
    allowedSignersText(signers, (await fs.readTextOr(ALLOWED_SIGNERS_LOCAL)) ?? ""),
  );
  await journal("archon-approval", `a person trusted signer ${name} on this host`, "user.warning");
  count("archon.signers.trusted");
  const { notify } = await import("../notify/events.ts");
  await notify({
    event: `signer ${name} trusted on this host by hand`,
    level: "warn",
    what: `archon signers trust: ${name} (${key.slice(
      0,
      30,
    )}...) may now approve changes for this host.`,
    todo: "Add it to the fleet's signers.ts with stolos signers add, commit signed by it, and push; then remove /etc/archon/allowed_signers.local.",
    key: `signers-trust:${name}`,
  }).catch(() => {});
  p.done(`${name} trusted here (${ALLOWED_SIGNERS_LOCAL})`);
  return ui.finish();
}
