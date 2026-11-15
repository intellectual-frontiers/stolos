/**
 * The pinned Bun (spec 096-bun-runtime FR-007): the runtime every host, the boot server and the
 * operator's PC run the engine with, and how a fleet checkout gets its engine.
 *
 * - **The pin**: one Bun version, and the SHA-256 of its release archive for each platform, kept
 *   here in the engine. The first boot (`render/autoinstall.ts`, also run by `stolos host
 *   bootstrap`) downloads the archive for its machine, checks its SHA-256 before unpacking it, and
 *   links `/usr/local/bin/bun`. Raising the pin is a change to this file, reviewed like any other.
 * - **The engine in a checkout**: a fleet repository depends on the engine's release tarball by
 *   its URL (`package.json`), and `bun.lock` holds its integrity. `bun install --frozen-lockfile`
 *   installs exactly that, or stops (E046-LOCK-INTEGRITY): the lock is the control.
 * - **The launcher** (`/usr/local/bin/archon`, `capabilities/cli.ts`) runs the checkout's
 *   `archon.ts` with Bun, and with Node 26 where Bun is not installed.
 *
 * ```mermaid
 * flowchart LR
 *   pin["BUN_VERSION + SHA-256<br/>per platform"] --> fb["first boot:<br/>download, check, unpack"]
 *   fb --> bun["/usr/local/bin/bun"]
 *   repo["/srv/archon<br/>package.json + bun.lock"] -->|"bun install --frozen-lockfile"| nm["node_modules/<br/>@intellectual-frontiers/stolos"]
 *   bun --> launcher["/usr/local/bin/archon:<br/>bun archon.ts"]
 *   nm --> launcher
 * ```
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { run, type RunResult } from "../core/exec.ts";

/** The Bun every machine runs (spec 096). */
export const BUN_VERSION = "1.4.4";

/** A platform Bun is pinned for. */
export type BunPlatform =
  | "linux-x64"
  | "linux-x64-baseline"
  | "linux-aarch64"
  | "darwin-x64"
  | "darwin-aarch64"
  | "windows-x64"
  | "windows-x64-baseline"
  | "windows-aarch64";

/** The release archive of the pinned Bun for each platform, by its SHA-256 (from Bun's SHASUMS256.txt). */
export const BUN_SHA256: Readonly<Record<BunPlatform, string>> = {
  "linux-x64": "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
  "linux-x64-baseline": "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76",
  "linux-aarch64": "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e",
  "darwin-x64": "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e",
  "darwin-aarch64": "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510",
  "windows-x64": "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5",
  "windows-x64-baseline": "0f20ce6674d4f2dbcc8c5d59fdf99f7ba45f8c3b367e0f5781cbfa30a1c78d99",
  "windows-aarch64": "2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09",
};

/** The release archive's URL for a platform. */
export function bunUrl(platform: BunPlatform, version = BUN_VERSION): string {
  return `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${platform}.zip`;
}

/** Where the pinned Bun is unpacked on a host, beside the other side-by-side tools (spec 010). */
export const BUN_HOME = `/opt/tools/bun/${BUN_VERSION}`;

/** The command every host runs Bun by. */
export const BUN_BIN = "/usr/local/bin/bun";

/**
 * A POSIX shell fragment that installs the pinned Bun on Linux (x86-64 or ARM64) unless that
 * version is already there: the archive for this machine (the baseline build where the CPU has no
 * AVX2), its SHA-256 checked before it is unpacked, then `/usr/local/bin/bun`. It needs curl and
 * unzip, and fails (with `set -e`) on any mismatch.
 */
export function bunInstallShell(): string {
  const linux = (["linux-x64", "linux-x64-baseline", "linux-aarch64"] as const)
    .map((p) => `    ${p}) S=${BUN_SHA256[p]} ;;`)
    .join("\n");
  return `if [ "$(${BUN_BIN} --version 2>/dev/null)" != "${BUN_VERSION}" ]; then
  case "$(uname -m)" in
    x86_64) P=linux-x64; grep -qw avx2 /proc/cpuinfo || P=linux-x64-baseline ;;
    aarch64|arm64) P=linux-aarch64 ;;
    *) echo "archon: no pinned Bun for $(uname -m)" >&2; exit 1 ;;
  esac
  case "$P" in
${linux}
  esac
  T=$(mktemp -d)
  curl -fsSL -o "$T/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-$P.zip"
  [ "$(sha256sum "$T/bun.zip" | cut -d' ' -f1)" = "$S" ] || { echo "archon: bun-$P.zip does not match its pinned SHA-256" >&2; exit 1; }
  install -d -m 0755 ${BUN_HOME}/bin
  unzip -q -o "$T/bun.zip" -d "$T"
  install -m 0755 "$T/bun-$P/bun" ${BUN_HOME}/bin/bun
  ln -sfn ${BUN_HOME}/bin/bun ${BUN_BIN}
  rm -rf "$T"
fi`;
}

/** The Bun to run: this process's own when it is Bun, else `bun` on the PATH, else the host's. */
export function bunExecutable(): string {
  if (proc.runtimeName() === "bun") return proc.execPath();
  return proc.which("bun") ?? BUN_BIN;
}

/**
 * The program that runs a fleet checkout's `stolos.ts` or `archon.ts`: Bun, or Node 26 where Bun
 * is not installed (spec 096 FR-007).
 */
export function engineRuntime(): string {
  if (proc.runtimeName() === "bun") return proc.execPath();
  return proc.which("bun") ?? (proc.runtimeName() === "node" ? proc.execPath() : "node");
}

/** How to install a checkout's dependencies. */
export type InstallOptions = {
  /** `--frozen-lockfile`: install what bun.lock holds, or stop (the default). */
  readonly frozen?: boolean;
  /** Run it as the checkout's owner (needs root). */
  readonly asUser?: string;
};

/**
 * `bun install` in a fleet checkout: the engine package (and its dependencies), checked against
 * bun.lock. With `frozen` (the default) an integrity or lock mismatch fails (E046-LOCK-INTEGRITY).
 */
export function installDependencies(repo: string, o: InstallOptions = {}): Promise<RunResult> {
  return run([bunExecutable(), "install", ...(o.frozen === false ? [] : ["--frozen-lockfile"])], {
    cwd: repo,
    ...(o.asUser === undefined ? {} : { asUser: o.asUser }),
  });
}
