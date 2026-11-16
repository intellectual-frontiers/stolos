/**
 * Spec 067: the probe an adopted machine runs for Stolos. It is a POSIX shell
 * script in the account's own `~/.local/bin/stolos-probe` (no root, nothing
 * listening), started only by the probe key: its line in `authorized_keys`
 * forces `command="~/.local/bin/stolos-probe"`, so that key runs this script
 * and nothing else. The script answers a fixed set of read-only probes, named
 * in SSH_ORIGINAL_COMMAND:
 *
 * - `facts`: the OS, hardware, disk, security settings, software, ports;
 * - `osquery <base64 SQL>`: one SELECT through osqueryi, when installed;
 * - `version`: the probe's version.
 *
 * Its output is `@section` lines followed by `key=value` lines, read by
 * {@link parseProbe}. It works on macOS and Linux (Debian, Ubuntu, Arch and
 * Omarchy, Fedora); anything it cannot know it reports as `unknown`.
 *
 * @module
 */
// Spec: 067-adopt

import { engineFile } from "../core/assets.ts";

/** The probe script (POSIX sh): bin/stolos-probe.sh, embedded in the engine and published with each release. */
export const PROBE_SCRIPT: string = engineFile("bin/stolos-probe.sh");

/** The probe's version (its `version` answer): written into each observation. */
export const PROBE_VERSION: string = PROBE_SCRIPT.match(/^# stolos-probe (\d+):/m)?.[1] ?? "?";

/** The Windows probe (PowerShell): bin/stolos-probe.ps1, the same requests and output (spec 069). */
export const PROBE_SCRIPT_WINDOWS: string = engineFile("bin/stolos-probe.ps1");

/** A probe's output: sections, each a map of key to value. */
export type ProbeOutput = Record<string, Record<string, string>>;

/** Read `@section` and `key=value` lines. */
export function parseProbe(text: string): ProbeOutput {
  const out: ProbeOutput = {};
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@")) {
      section = line.slice(1).trim();
      out[section] ??= {};
      continue;
    }
    const i = line.indexOf("=");
    const fields = out[section];
    if (!fields || i <= 0) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** The line in authorized_keys that lets the probe key run the probe and nothing else. */
export function authorizedLine(publicKey: string, fleet: string): string {
  return `command="$HOME/.local/bin/stolos-probe",restrict ${publicKey
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ")} stolos-probe@${fleet}`;
}
