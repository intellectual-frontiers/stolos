/**
 * The boot machine's side of HTTPS (spec 032):
 *
 *   deno task stolos boot web-setup          store the Cloudflare DNS token (once)
 *   deno task stolos boot web-push <host>    give a running server the token over SSH
 *
 * The token lives only in this PC's secrets folder and, on each server, root
 * only in /etc/archon/web. It never enters the repository (Article 13).
 *
 * @module
 */

import { readHidden } from "../archon/identity/fleet-init.ts";
import { readSecret, SECRETS, writeSecret } from "../archon/core/secrets.ts";
import { loadFleet, loadServers } from "../archon/model/load.ts";
import { zoneId } from "../archon/web/cloudflare.ts";
import { zoneOf } from "../archon/web/config.ts";

/**
 * `deno task stolos boot web-setup`: explain the one-time Cloudflare DNS token, read
 * it without echo, check that it can see the fleet's zone, and store it in this
 * PC's secrets. Returns the exit code (1 on a missing web setting or a bad token).
 */
export async function webSetup(): Promise<number> {
  const fleet = await loadFleet();
  if (!fleet.web) {
    console.error(
      'No web settings: add web: { domain: "<servers live under this name>" } to fleets/<fleet>/fleet.ts first.',
    );
    return 1;
  }
  const zone = zoneOf(fleet.web);
  const first = (await loadServers())[0]?.name ?? "alpha";
  const had = await readSecret(SECRETS.web);
  console.log(
    [
      `Each server answers HTTPS as <host>.${fleet.web.domain} (for example ${first}.${fleet.web.domain}),`,
      `with a Let's Encrypt certificate for that name and *.${first}.${fleet.web.domain}, and keeps its own`,
      `DNS records in Cloudflare (private addresses, not proxied). Once, in the Cloudflare dashboard:`,
      ``,
      ` My Profile > API Tokens > Create Token > "Edit zone DNS" template, named "archon web":`,
      `   Permissions: Zone > DNS > Edit, and add Zone > Zone > Read`,
      `   Zone Resources: Include > Specific zone > ${zone}`,
      ` Create, then copy the token (it is shown once).`,
      ``,
      had ? `(A token is already stored; pasting a new one replaces it.)` : "",
    ].filter((l, i, a) => l || a[i - 1]).join("\n"),
  );
  const token = (await readHidden("Cloudflare API token: ")).trim();
  if (!/^\S{20,}$/.test(token)) {
    console.error("That does not look like an API token. Nothing was stored.");
    return 1;
  }
  try {
    await zoneId(token, zone);
  } catch (e) {
    console.error(`${(e as Error).message}. Nothing was stored.`);
    return 1;
  }
  await writeSecret(
    SECRETS.web,
    JSON.stringify({ token, created: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log([
    ``,
    `Cloudflare accepted the token for ${zone}. Stored in ${SECRETS.web} (this PC only, never in git).`,
    `Servers get it at their next install, or now: deno task stolos boot web-push <host>.`,
    `Anyone with it can change ${zone}'s DNS. To revoke it: delete "archon web" under My Profile >`,
    `API Tokens; then run this again and web-push each server.`,
    ``,
  ].join("\n"));
  return 0;
}

/**
 * `deno task stolos boot web-push <host>`: give a running server the stored DNS token
 * over SSH (on stdin to `archon web credential`). Returns ssh's exit code, 2
 * for an unknown host, or 1 when no token is stored.
 */
export async function webPush(name: string | undefined): Promise<number> {
  const fleet = await loadFleet();
  const hosts = await loadServers();
  if (!name || !hosts.some((h) => h.name === name)) {
    console.error(
      `usage: deno task stolos boot web-push <host>  (known: ${
        hosts.map((h) => h.name).join(", ") || "none"
      })`,
    );
    return 2;
  }
  const cred = await readSecret(SECRETS.web);
  if (!cred) {
    console.error("No token on this PC yet: deno task stolos boot web-setup");
    return 1;
  }
  const target = `${fleet.admin.user}@${name}`;
  const child = new Deno.Command("ssh", {
    args: ["-o", "ConnectTimeout=10", target, "archon web credential"],
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(cred));
  await w.close();
  const { code } = await child.status;
  if (code !== 0) {
    console.error(`ssh ${target} failed (exit ${code}). Is ${name} up, and can this PC ssh to it?`);
  }
  return code;
}
