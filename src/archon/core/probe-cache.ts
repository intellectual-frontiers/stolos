/**
 * What an earlier run found out about this PC, kept for a short time so that the next run does not
 * ask the system again (spec 106-one-passphrase-speed FR-008): the firewall check, which on Windows
 * reads every rule of Defender through PowerShell, is the first. One file, `probe-cache.json`, in the
 * program's state folder (never in Git); each entry is a key (what was asked, and of which system),
 * the answer (the warnings, never the rules) and the time it was made. An entry older than its time
 * to live is not used, so a rule that changed is never hidden for longer than that.
 *
 * It is not used, and not written, by a report (verbose by default), by `--verbose`, or by `--fresh`;
 * an answer that could not be completed is never kept. Within one run a question is asked of the
 * system at most once, even where the file is bypassed.
 *
 * @module
 */
// Spec: 106-one-passphrase-speed FR-008

import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { stateFolder, ui } from "./ui.ts";

/** How long an answer is kept: five minutes (spec 106-one-passphrase-speed FR-008). */
export const PROBE_TTL_MS = 5 * 60_000;

/** One kept answer. */
interface Entry {
  /** When it was made (milliseconds since 1970). */
  at: number;
  /** What it says. */
  value: unknown;
}

/** Whether `--fresh` was given to this run (or to the run that started this one). */
let fresh = proc.env.get("STOLOS_FRESH") === "1";

/** `--fresh`: do not use what an earlier run remembered; children started by this run follow it. */
export function setFresh(on: boolean): void {
  fresh = on;
  if (on) proc.env.set("STOLOS_FRESH", "1");
}

/** Whether what an earlier run remembered is left alone: a report, `--verbose`, or `--fresh`. */
export function bypassed(): boolean {
  return fresh || ui.mode === "verbose";
}

/** Where the answers are kept. */
export function probeCacheFile(): string {
  return path.join(stateFolder(), "probe-cache.json");
}

function readAll(file: string): Record<string, Entry> {
  try {
    const d: unknown = JSON.parse(fs.readTextFileSync(file));
    const out: Record<string, Entry> = {};
    if (typeof d === "object" && d !== null) {
      for (const [k, v] of Object.entries(d)) {
        if (typeof v === "object" && v !== null && typeof Reflect.get(v, "at") === "number") {
          out[k] = { at: Reflect.get(v, "at") as number, value: Reflect.get(v, "value") };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** The questions asked of the system during this run, and their answers. */
const thisRun = new Map<string, Promise<unknown>>();

/** Forget this run's answers (a test's). */
export function forgetRun(): void {
  thisRun.clear();
}

/** What a cached question is given (tests replace the clock and the file). */
export interface ProbeOptions {
  /** The file (default: {@link probeCacheFile}). */
  file?: string;
  /** The clock in milliseconds (default: `Date.now`). */
  now?: () => number;
  /** How long an answer is kept (default: {@link PROBE_TTL_MS}). */
  ttlMs?: number;
  /** Leave the file alone (default: {@link bypassed}). */
  bypass?: boolean;
  /** Where the answer is not worth keeping (the check could not be completed): true keeps it. */
  keep?: (value: unknown) => boolean;
}

/**
 * The answer to `key`: this run's, else a kept one younger than its time to live, else `ask()`,
 * which is kept (unless `keep` says it was incomplete, or the file is bypassed).
 */
export function probed<T>(key: string, ask: () => Promise<T>, o: ProbeOptions = {}): Promise<T> {
  const before = thisRun.get(key);
  if (before) return before as Promise<T>;
  const run = (async (): Promise<T> => {
    const file = o.file ?? probeCacheFile();
    const now = o.now ?? Date.now;
    const ttl = o.ttlMs ?? PROBE_TTL_MS;
    const bypass = o.bypass ?? bypassed();
    if (!bypass) {
      const hit = readAll(file)[key];
      if (hit && now() - hit.at >= 0 && now() - hit.at < ttl) {
        ui.log(`   probe cache: hit ${key.slice(0, 40)}`);
        return hit.value as T;
      }
    }
    const value = await ask();
    if (!bypass && (o.keep?.(value) ?? true)) {
      try {
        const all = readAll(file);
        for (const [k, e] of Object.entries(all)) if (now() - e.at >= ttl) delete all[k];
        all[key] = { at: now(), value };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeTextFileSync(file, JSON.stringify(all));
      } catch {
        /* a check asked again is harmless */
      }
    }
    return value;
  })();
  thisRun.set(key, run);
  // A failed question is not kept for the rest of the run.
  run.catch(() => thisRun.delete(key));
  return run;
}
