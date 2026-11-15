/**
 * Spec 082: each client's console inside the provider's console, built once
 * per client, in that client's scope: its facts, estate, compliance, REST API,
 * activity record, and caches come from its own checkout and its own folders
 * on this PC, and its commands run in its checkout with its scope.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { Sessions } from "../console/auth.ts";
import { activityLog } from "../console/machine.ts";
import { PC_GUIDES } from "../console/stolos-pages.ts";
import { Launch, stolosHandler } from "../console/stolos-server.ts";
import type { ClientConsole } from "./console.ts";
import type { Client } from "./registry.ts";
import { clientEnv, withClient } from "./scope.ts";

/** A builder of client consoles, one per client id (cached: its sessions live as long as it does). */
export function realConsoleFor(
  port: number,
  person: { user: string; name: string },
): (c: Client) => Promise<ClientConsole> {
  const built = new Map<string, Promise<ClientConsole>>();
  return (c) => {
    let b = built.get(c.id);
    if (!b) {
      b = withClient(c, async () => {
        const { pcFacts } = await import("../console/pc.ts");
        const { estateFor, pcGuideDoc, pcIntegrate, pcRunner } = await import(
          "../console/stolos-launch.ts"
        );
        const estate = estateFor();
        const sessions = new Sessions();
        const handler = stolosHandler({
          port,
          person,
          launch: new Launch(), // never issued: the provider's console signs in
          sessions,
          facts: () => withClient(c, () => pcFacts()),
          runner: pcRunner(c.path, clientEnv(c)),
          activity: activityLog(join(P.state, "console-activity.jsonl")),
          guides: PC_GUIDES,
          guideDoc: pcGuideDoc,
          integrate: (name, as) =>
            withClient(c, async () => pcIntegrate(name, as, (await pcFacts()).fleet.repo)),
          // The boot server's log is this PC's, about every client's installs: not on a client's pages.
          bootLog: () => Promise.resolve(""),
          cacheDir: join(P.state, "console-cache"),
          estate: () => withClient(c, estate),
          evidenceDir: join(P.state, "evidence"),
          scope: { label: c.title, href: "/clients" },
        });
        return {
          sessions,
          handler: (req: Request) => withClient(c, () => handler(req)),
        };
      });
      built.set(c.id, b);
      b.catch(() => built.delete(c.id));
    }
    return b;
  };
}
