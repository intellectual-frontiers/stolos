/**
 * The boot server's log (spec 004 FR-017): `boot serve` writes everything its window shows to
 * `boot.log` in the boot cache (`%LOCALAPPDATA%\stolos\boot`; Linux: `~/.local/share/stolos/boot`),
 * keeping one previous copy (`boot.log.1`) once it passes 5 MB.
 *
 * @example
 * ```ts
 * import { openBootLog } from "./boot-log.ts";
 * const log = await openBootLog();
 * log.write("2026-11-15T00:00:00.000Z alpha: First boot");
 * ```
 *
 * @module
 */
// Spec: 004-install
import { fs, path as paths } from "@intellectual-frontiers/commons/ts/runtime";
import { P } from "../archon/core/paths.ts";

/** Past this size, `boot.log` becomes `boot.log.1` when the server starts. */
export const BOOT_LOG_MAX_BYTES = 5_000_000;

/** An open boot log: its path, and a line writer that never throws. */
export interface BootLog {
  /** The log file. */
  readonly path: string;
  /** Append one line (best effort). */
  readonly write: (line: string) => void;
}

/** Open the boot log in `dir` (the boot cache), rotating it first past 5 MB. */
export async function openBootLog(dir: string = P.bootCache): Promise<BootLog> {
  const path = paths.join(dir, "boot.log");
  await fs.ensureDir(dir);
  const size = await fs
    .stat(path)
    .then((s) => s.size)
    .catch(() => 0);
  if (size > BOOT_LOG_MAX_BYTES) await fs.rename(path, `${path}.1`).catch(() => {});
  const f = await fs.open(path, { create: true, append: true });
  const enc = new TextEncoder();
  f.writeSync(enc.encode(`${new Date().toISOString()} == boot serve started\n`));
  return {
    path,
    write: (line) => {
      try {
        f.writeSync(enc.encode(line + "\n"));
      } catch {
        /* the log is best effort */
      }
    },
  };
}
