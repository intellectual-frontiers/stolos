/**
 * Spec 065: the worker thread that runs the PAM check ({@link loadPam}): PAM blocks for about
 * two seconds after a wrong password, and the web server keeps answering. Messages: a
 * {@link PamRequest} in, a {@link PamReply} out. It runs on Bun only (spec 096 FR-010): the
 * console never starts it on Node.
 *
 * @module
 */

import { parentPort } from "node:worker_threads";
import { loadPam, type PamCheck, type PamReply, pamRequest } from "./pam.ts";

const port = parentPort;
if (port !== null) {
  // Messages wait on the port until this listener is added, so none is lost while PAM loads.
  let check: PamCheck | undefined;
  let loading: Promise<PamCheck> | undefined;
  port.on("message", (m: unknown) => {
    const req = pamRequest(m);
    if (!req) return;
    void (async (): Promise<void> => {
      let ok: boolean;
      try {
        check ??= await (loading ??= loadPam());
        ok = check(req.service, req.user, req.password, req.confdir);
      } catch {
        ok = false;
      }
      const reply: PamReply = { id: req.id, ok };
      port.postMessage(reply);
    })();
  });
}
