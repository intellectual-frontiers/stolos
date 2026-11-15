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
import { type Phase, ui } from "./ui.ts";

/**
 * The logger the engine uses: `step` starts a phase, `info` notes, `ok`,
 * `change` and `skip` are counted, `warn` and `error` (with an optional fix)
 * are always shown. A skip that mentions "disruptive" becomes a deferral.
 */
export const log: {
  readonly info: (msg: string) => void;
  readonly step: (msg: string) => Phase;
  readonly ok: (msg: string) => void;
  readonly change: (msg: string) => void;
  readonly skip: (msg: string) => void;
  readonly warn: (msg: string, fix?: string) => void;
  readonly error: (msg: string, fix?: string) => void;
} = {
  info: (msg) => ui.active().note(msg),
  step: (msg) => ui.phase(msg),
  ok: (msg) => ui.active().ok(msg),
  change: (msg) => ui.active().change(msg),
  skip: (msg) => (/disruptive/.test(msg) ? ui.active().defer(msg) : ui.active().skip(msg)),
  warn: (msg, fix) => ui.active().warn(msg, fix),
  error: (msg, fix) => ui.active().fail(msg, fix),
};

/** Write `message` to the systemd journal with logger(1), tagged `tag` at syslog `priority`. */
export async function journal(tag: string, message: string, priority = "user.info"): Promise<void> {
  await run(["logger", "-t", tag, "-p", priority, message]);
}
