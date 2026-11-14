/**
 * Logging adapter over the calm-output UI (Article XXII, spec 018), plus
 * journald through logger(1) (util-linux, native; Article XVIII).
 *
 * step starts a phase; ok/change/skip are counted (shown with --verbose);
 * warn/error are always shown and repeated under "Needs attention"; skips
 * that mention "disruptive" are collected into the single Deferred line.
 *
 * @module
 */

import { run } from "./exec.ts";
import { ui } from "./ui.ts";

/**
 * The logger the engine uses: `step` starts a phase, `info` notes, `ok`,
 * `change` and `skip` are counted, `warn` and `error` (with an optional fix)
 * are always shown. A skip that mentions "disruptive" becomes a deferral.
 */
export const log = {
  info: (msg: string) => ui.active().note(msg),
  step: (msg: string) => ui.phase(msg),
  ok: (msg: string) => ui.active().ok(msg),
  change: (msg: string) => ui.active().change(msg),
  skip: (msg: string) => (/disruptive/.test(msg) ? ui.active().defer(msg) : ui.active().skip(msg)),
  warn: (msg: string, fix?: string) => ui.active().warn(msg, fix),
  error: (msg: string, fix?: string) => ui.active().fail(msg, fix),
};

/** Write `message` to the systemd journal with logger(1), tagged `tag` at syslog `priority`. */
export async function journal(
  tag: string,
  message: string,
  priority = "user.info",
): Promise<void> {
  await run(["logger", "-t", tag, "-p", priority, message]);
}
