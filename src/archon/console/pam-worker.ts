/**
 * Spec 065: the worker thread that runs {@link pamCheck} (PAM blocks for about
 * two seconds after a wrong password; the web server keeps answering).
 * Messages: {id, service, user, password} in; {id, ok} out.
 *
 * @module
 */

/// <reference lib="deno.worker" />

import { pamCheck } from "./pam.ts";

self.onmessage = (
  e: MessageEvent<{ id: number; service: string; user: string; password: string }>,
) => {
  const { id, service, user, password } = e.data;
  let ok = false;
  try {
    ok = pamCheck(service, user, password);
  } catch {
    ok = false;
  }
  self.postMessage({ id, ok });
};
