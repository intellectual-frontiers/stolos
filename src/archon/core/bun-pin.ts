/**
 * The pinned runtimes (spec 096-bun-runtime FR-007): the one Bun every host, the boot server and
 * the operator's PC run the engine with, and the Node 26 that is the backup where Bun cannot run.
 * Each is a version and the SHA-256 of its official release archive for each platform; a download
 * is unpacked only where its SHA-256 is the one written here. Raising a pin is a change to this
 * file, reviewed like any other.
 *
 * - **Bun** 1.4.4, the version commons pins (`pmid:pin-bun` in commons'
 *   `ontology/supply-chain/packaging/pins.ttl`). Its archives are
 *   `https://github.com/oven-sh/bun/releases/download/bun-v<version>/bun-<target>.zip`, each holding
 *   `bun-<target>/bun` (`bun.exe` on Windows). The checksums of `linux-x64`, `linux-aarch64`,
 *   `darwin-x64`, `darwin-aarch64` and `windows-x64` are commons' own (`pmid:sum-bun-*`); the
 *   baseline builds (for a processor without AVX2) and `windows-aarch64` are from the release's
 *   `SHASUMS256.txt`.
 * - **Node** 26.13.1, from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`:
 *   `node-v<version>-<target>.tar.gz` (`.zip` on Windows), holding `node-v<version>-<target>/`.
 *
 * The module imports nothing at run time, so a CI step can read it with Node before anything is
 * installed (`node -e 'import("./src/archon/core/bun-pin.ts")'`). The bootstraps
 * (`bin/bootstrap.sh`, `bin/bootstrap.windows.ps1`) carry the same values, and the engine's tests
 * keep them equal.
 *
 * ```mermaid
 * flowchart LR
 *   pin["BUN_VERSION + SHA-256<br/>per platform"] --> dl["download the archive"]
 *   dl --> check{"SHA-256 is the pinned one?"}
 *   check -->|yes| unpack["unpack: bun"]
 *   check -->|no| stop["stop: nothing kept"]
 *   unpack --> run["bun archon.ts"]
 *   node["NODE_VERSION + SHA-256<br/>(the backup)"] -.->|Bun cannot run| run2["node --import (commons hook)<br/>archon.ts"]
 * ```
 *
 * @example
 * ```ts
 * import { bunDownload, bunTarget } from "@intellectual-frontiers/stolos/archon/core/bun-pin";
 * const target = bunTarget("linux", "x86_64");
 * if (target !== undefined) {
 *   const { url, sha256, member } = bunDownload(target);
 *   console.log(`curl -fsSLo bun.zip ${url} && check ${sha256}, then unzip ${member}`);
 * }
 * ```
 *
 * @module
 */

import type { proc } from "@intellectual-frontiers/commons/ts/runtime";

/** The Bun every machine runs (commons `pmid:pin-bun`). */
export const BUN_VERSION = "1.4.4";

/** The Node 26 that runs the same code where Bun cannot (spec 096 decision 1). */
export const NODE_VERSION = "26.13.1";

/**
 * A platform Bun publishes a build for, by Bun's own names: `-baseline` is the build for an x86-64
 * processor without AVX2.
 */
export type BunTarget =
  | "linux-x64"
  | "linux-x64-baseline"
  | "linux-aarch64"
  | "darwin-x64"
  | "darwin-x64-baseline"
  | "darwin-aarch64"
  | "windows-x64"
  | "windows-x64-baseline"
  | "windows-aarch64";

/** The SHA-256 of `bun-<target>.zip` of the pinned Bun, for each target. */
export const BUN_SHA256: Readonly<Record<BunTarget, string>> = {
  "linux-x64": "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
  "linux-x64-baseline": "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76",
  "linux-aarch64": "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e",
  "darwin-x64": "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e",
  "darwin-x64-baseline": "d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc",
  "darwin-aarch64": "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510",
  "windows-x64": "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5",
  "windows-x64-baseline": "0f20ce6674d4f2dbcc8c5d59fdf99f7ba45f8c3b367e0f5781cbfa30a1c78d99",
  "windows-aarch64": "2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09",
};

/** Every Bun target, in a fixed order. */
export const BUN_TARGETS: readonly BunTarget[] = [
  "linux-x64",
  "linux-x64-baseline",
  "linux-aarch64",
  "darwin-x64",
  "darwin-x64-baseline",
  "darwin-aarch64",
  "windows-x64",
  "windows-x64-baseline",
  "windows-aarch64",
];

/** A platform Node publishes a build for, by Node's own names. */
export type NodeTarget =
  "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win-x64" | "win-arm64";

/**
 * The SHA-256 of the pinned Node's archive for each target: `node-v<version>-<target>.tar.gz`, or
 * `.zip` for Windows (from the release's `SHASUMS256.txt`).
 */
export const NODE_SHA256: Readonly<Record<NodeTarget, string>> = {
  "linux-x64": "518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778",
  "linux-arm64": "80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d",
  "darwin-x64": "82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f",
  "darwin-arm64": "aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735",
  "win-x64": "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7",
  "win-arm64": "181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97",
};

/** Every Node target, in a fixed order. */
export const NODE_TARGETS: readonly NodeTarget[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win-x64",
  "win-arm64",
];

/** One pinned archive: where it is, what its SHA-256 must be, and the program inside it. */
export type PinnedDownload = {
  /** The archive's URL. */
  readonly url: string;
  /** Its SHA-256, 64 lower-case hexadecimal digits: anything else is not unpacked. */
  readonly sha256: string;
  /** Its kind, by how it is unpacked. */
  readonly archive: "zip" | "tar.gz";
  /** The program's path inside the archive (`bun-linux-x64/bun`, `node-v26.13.1-linux-x64/bin/node`). */
  readonly member: string;
};

/** The pinned Bun's archive for a target. */
export function bunDownload(target: BunTarget): PinnedDownload {
  const exe = target.startsWith("windows-") ? "bun.exe" : "bun";
  return {
    url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${target}.zip`,
    sha256: BUN_SHA256[target],
    archive: "zip",
    member: `bun-${target}/${exe}`,
  };
}

/** The pinned Node's archive for a target. */
export function nodeDownload(target: NodeTarget): PinnedDownload {
  const base = `node-v${NODE_VERSION}-${target}`;
  const windows = target.startsWith("win-");
  return {
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${base}.${windows ? "zip" : "tar.gz"}`,
    sha256: NODE_SHA256[target],
    archive: windows ? "zip" : "tar.gz",
    member: windows ? `${base}/node.exe` : `${base}/bin/node`,
  };
}

/**
 * The Bun target for an operating system and a processor (`proc.build`'s names), or undefined
 * where Bun has no build (then Node is the runtime). `baseline` asks for the build for an x86-64
 * processor without AVX2; it changes nothing on ARM.
 */
export function bunTarget(
  os: proc.Os,
  arch: proc.Arch,
  o: { readonly baseline?: boolean } = {},
): BunTarget | undefined {
  const name =
    os === "darwin"
      ? "darwin"
      : os === "linux"
        ? "linux"
        : os === "windows"
          ? "windows"
          : undefined;
  if (name === undefined) return undefined;
  if (arch === "aarch64") return `${name}-aarch64`;
  if (arch !== "x86_64") return undefined;
  return o.baseline === true ? `${name}-x64-baseline` : `${name}-x64`;
}

/** The Node target for an operating system and a processor, or undefined where none is pinned. */
export function nodeTarget(os: proc.Os, arch: proc.Arch): NodeTarget | undefined {
  const name =
    os === "darwin" ? "darwin" : os === "linux" ? "linux" : os === "windows" ? "win" : undefined;
  if (name === undefined) return undefined;
  if (arch === "aarch64") return `${name}-arm64`;
  return arch === "x86_64" ? `${name}-x64` : undefined;
}
