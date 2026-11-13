// Spec 051: a machine that takes the installer image and then goes quiet.
// Ubuntu's network installer holds the whole image in memory; with too little
// RAM (below about 8 GiB) it stalls before asking for its configuration, and
// nothing on the boot server's screen says so. This watch notices: after the
// image is served to an address, the installer asks for its configuration
// from that address within minutes, or the boot window explains.

export const STALL_MS = 6 * 60_000;

export class StallWatch {
  #timers = new Map<string, unknown>();
  constructor(
    private onStall: (address: string) => void,
    private ms = STALL_MS,
    private set: (f: () => void, ms: number) => unknown = (f, ms) => {
      const id = setTimeout(f, ms);
      Deno.unrefTimer(id); // never keeps the process alive
      return id;
    },
    private clear: (id: unknown) => void = (id) => clearTimeout(id as number),
  ) {}

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

  stop(): void {
    for (const id of this.#timers.values()) this.clear(id);
    this.#timers.clear();
  }
}

export function stallMessage(host: string | undefined): string {
  return `${host ?? "this machine"} took the installer image ${
    STALL_MS / 60_000
  } minutes ago and has not asked for its configuration: its installer has most likely run out of memory. Ubuntu's network installer holds the whole image in memory and needs about 8 GiB of RAM. With less, install Ubuntu by hand (or from its cloud image) and finish it with: deno task archon host bootstrap ${
    host ?? "<host>"
  } --ssh <user>@<address>`;
}
