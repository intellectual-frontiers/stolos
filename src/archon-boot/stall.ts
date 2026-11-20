/**
 * Spec 051: a machine that takes the installer image and then goes quiet.
 * Ubuntu's network installer holds the whole image in memory; with too little
 * RAM (below about 8 GiB) it stalls before asking for its configuration, and
 * nothing on the boot server's screen says so. This watch notices: after the
 * image is served to an address, the installer asks for its configuration
 * from that address within minutes, or the boot window explains.
 *
 * @module
 */
// Spec: 051-machine-identity

import { proc } from "@intellectual-frontiers/system";

/** How long an installer may go quiet after taking the image. */
export const STALL_MS = 6 * 60_000;

/** Starts a timer; gives what clears it. */
export type SetTimer = (f: () => void, ms: number) => unknown;

/** Watches installers that took the image (off by default: boot serve --stall-watch). Keyed by host when known, else by address. */
export class StallWatch {
  #timers = new Map<string, unknown>();
  private readonly onStall: (address: string) => void;
  private readonly ms: number;
  private readonly set: SetTimer;
  private readonly clear: (id: unknown) => void;
  /** onStall is called with the key when nothing more came within ms. */
  constructor(
    onStall: (address: string) => void,
    ms = STALL_MS,
    // A timer that never keeps the process alive.
    set: SetTimer = (f, ms) => proc.unrefTimer(f, ms),
    clear: (id: unknown) => void = (id) => (id as proc.Timer).clear(),
  ) {
    this.onStall = onStall;
    this.ms = ms;
    this.set = set;
    this.clear = clear;
  }

  /** The whole installer image was requested from this address. */
  imageServed(address: string): void {
    this.heard(address);
    this.#timers.set(
      address,
      this.set(() => {
        this.#timers.delete(address);
        this.onStall(address);
      }, this.ms),
    );
  }

  /** The installer at this address asked for something after the image: it runs. */
  heard(address: string): void {
    const id = this.#timers.get(address);
    if (id !== undefined) {
      this.clear(id);
      this.#timers.delete(address);
    }
  }

  /** Stop every timer. */
  stop(): void {
    for (const id of this.#timers.values()) this.clear(id);
    this.#timers.clear();
  }
}

/** What the boot window says about a stalled installer: the likely cause and the bootstrap path. */
export function stallMessage(host: string | undefined): string {
  return `${host ?? "this machine"} took the installer image ${
    STALL_MS / 60_000
  } minutes ago and has not asked for its configuration: its installer has most likely run out of memory. Ubuntu's network installer holds the whole image in memory and needs about 8 GiB of RAM. With less, install Ubuntu by hand (or from its cloud image) and finish it with: bun run stolos host bootstrap ${
    host ?? "<host>"
  } --ssh <user>@<address>`;
}
