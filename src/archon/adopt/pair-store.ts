/**
 * Specs 103-three-ports and 107-pairing-and-query: where a pairing session's state lives. A session (spec 098) has one record: the
 * code, the fleet, the wrong signatures counted per client address, and every machine that said hello, with its check-in waiting for
 * the person and the person's decision for it. `stolos pair` (the terminal, where the person approves) and every server that answers
 * a machine (the boot server, the console, or the pair-only server `stolos pair` runs itself) are different processes, so the record
 * is a store they share:
 *
 * - {@link MemoryPairStore}: one process (the tests, and a session with no other process);
 * - {@link FilePairStore}: a short-lived file in the secrets folder, owner only and ephemeral (never backed up), the same pattern as
 *   an armed install: the command writes, the servers read per request, and there is no new port. Every change is made under a lock
 *   file (`<file>-lock`, taken with `O_EXCL` by commons' `lock`), read fresh inside it, and written atomically (a temporary file
 *   renamed over the record), so two processes cannot lose each other's tries or machines.
 *
 * The record has no expiry: a session lasts until the person who started it stops it (spec 107-pairing-and-query FR-001). It is
 * bounded instead: at most {@link MAX_ADDRESSES} client addresses are counted and at most {@link MAX_MACHINES} machines are kept, so
 * a flood cannot grow the file without limit (FR-004).
 *
 * @example
 * ```ts
 * import { MemoryPairStore, newPairRecord } from "./pair-store.ts";
 * const store = new MemoryPairStore(newPairRecord({ code: "WDJB-MJHT", fleet: "lab", engine: "v1.0.0" }));
 * const r = await store.update((rec) => (rec.tries["10.0.0.9"] = 1));
 * r?.result; // 1
 * ```
 *
 * @module
 */
// Spec: 103-three-ports FR-006, FR-007
// Spec: 107-pairing-and-query FR-001, FR-004, FR-005

import { fs, lock, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { ownerOnly } from "../core/secrets.ts";
import type { PairingStage } from "../ontology.auto.ts";

/** How many wrong signatures one client address may send before it is refused for the rest of the session. */
export const MAX_TRIES = 5;

/** How many client addresses a session counts wrong signatures for (past it, a new address's wrong signature is refused uncounted). */
export const MAX_ADDRESSES = 256;

/** How many machines one session keeps (a hello from another is refused). */
export const MAX_MACHINES = 64;

/** The machine that said hello: its hostname, its name and probe key from the PC, and the address it came from. */
export interface Hello {
  /** Its hostname, as it said. */
  hostname: string;
  /** Its name in the fleet. */
  name: string;
  /** The probe key's public half the PC sent it. */
  key: string;
  /** The client address its hello came from. */
  address: string;
}

/** Why a session ended: the person who started it closed it. */
export type PairEnd = "closed";

/** One machine of a session: what it said, where it is, and what the person decided. */
export interface PairMachine extends Hello {
  /** Where it is (`stolos:PairingStage`). */
  stage: PairingStage;
  /** Its place in the queue of machines (the order they said hello). */
  seq: number;
  /** When it said hello (milliseconds). */
  helloAt: number;
  /** The signed check-in text, waiting for the person's decision. */
  checkIn?: { text: string; at: number };
  /** The person's decision on the check-in. */
  decision?: { ok: boolean; message: string };
  /** The machine was told the decision. */
  delivered?: boolean;
}

/** What a pairing session keeps, in one record (the file's content, as JSON). */
export interface PairRecord {
  /** The record's format. */
  v: 2;
  /** The code, as shown (WDJB-MJHT). A secret while the session lasts; every machine uses it. */
  code: string;
  /** The fleet's id. */
  fleet: string;
  /** The engine's tag (v1.2.3), for the scripts' messages. */
  engine: string;
  /** When the session began (milliseconds). */
  startedAt: number;
  /** The name `--name` gave to the first machine (else each machine's hostname decides). */
  name?: string;
  /** `--name` was given to a machine already. */
  nameUsed?: boolean;
  /** Who the machines belong to (`--owner`). */
  owner?: string;
  /** What the machines are, for people (`--title`). */
  title?: string;
  /** Wrong signatures by client address, over every door and every process. */
  tries: Record<string, number>;
  /** The machines, by lowercase hostname. */
  machines: Record<string, PairMachine>;
  /** The next machine's place in the queue. */
  next: number;
  /** Set once the session is over. */
  ended?: PairEnd;
}

/** A new record for a session. */
export function newPairRecord(o: {
  code: string;
  fleet: string;
  engine: string;
  now?: number;
  name?: string;
  owner?: string;
  title?: string;
}): PairRecord {
  return {
    v: 2,
    code: o.code,
    fleet: o.fleet,
    engine: o.engine,
    startedAt: o.now ?? Date.now(),
    ...(o.name ? { name: o.name } : {}),
    ...(o.owner ? { owner: o.owner } : {}),
    ...(o.title ? { title: o.title } : {}),
    tries: {},
    machines: {},
    next: 1,
  };
}

/** The client addresses refused for the rest of the session (five wrong signatures). */
export function blockedAddresses(r: Pick<PairRecord, "tries">): string[] {
  return Object.entries(r.tries)
    .filter(([, n]) => n >= MAX_TRIES)
    .map(([a]) => a);
}

/** The machines in the order they said hello. */
export function machinesOf(r: Pick<PairRecord, "machines">): PairMachine[] {
  return Object.values(r.machines).sort((a, b) => a.seq - b.seq);
}

/** What one change gave back: its own result, and the record as it is now. */
export interface Changed<T> {
  /** What the change function returned. */
  result: T;
  /** The record after the change. */
  record: PairRecord;
}

/** Where a pairing's record is kept: read it, change it atomically, replace it, remove it. */
export interface PairStore {
  /** The record, or undefined where no session is open. */
  read(): Promise<PairRecord | undefined>;
  /**
   * Change the record, atomically: `change` is given the record as it is now (read fresh) and edits it in place. Undefined where no
   * session is open.
   */
  update<T>(change: (record: PairRecord) => T): Promise<Changed<T> | undefined>;
  /** Start a session: the record replaces any other. */
  create(record: PairRecord): Promise<void>;
  /** End the session's record. */
  remove(): Promise<void>;
}

/** A store in this process's memory. */
export class MemoryPairStore implements PairStore {
  private record: PairRecord | undefined;

  /** A store, with a pairing already started or none. */
  constructor(record?: PairRecord) {
    this.record = record ? structuredClone(record) : undefined;
  }

  /** The record (a copy), or undefined. */
  read(): Promise<PairRecord | undefined> {
    return Promise.resolve(this.record ? structuredClone(this.record) : undefined);
  }

  /** Change the record in place (one change at a time: the function is synchronous). */
  update<T>(change: (record: PairRecord) => T): Promise<Changed<T> | undefined> {
    if (!this.record) return Promise.resolve(undefined);
    const result = change(this.record);
    return Promise.resolve({ result, record: structuredClone(this.record) });
  }

  /** Replace the record. */
  create(record: PairRecord): Promise<void> {
    this.record = structuredClone(record);
    return Promise.resolve();
  }

  /** Forget the record. */
  remove(): Promise<void> {
    this.record = undefined;
    return Promise.resolve();
  }
}

/** The file's last-resort wait for its lock: a change takes a few milliseconds, so this is far longer than any. */
const LOCK_WAIT_MS = 10_000;

/** A record that does not read as one (a partial write cannot happen, but a stranger's file can). */
function isRecord(v: unknown): v is PairRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<PairRecord>;
  return (
    r.v === 2 &&
    typeof r.code === "string" &&
    typeof r.fleet === "string" &&
    typeof r.tries === "object" &&
    r.tries !== null &&
    typeof r.machines === "object" &&
    r.machines !== null
  );
}

/**
 * The record as a file, owner only (POSIX 0600 in a 0700 folder; Windows: the folder limited to this user, which the file inherits),
 * written atomically and changed under a lock.
 */
export class FilePairStore implements PairStore {
  private readonly file: string;
  private prepared = false;

  /** A store over `file` (in the secrets folder; its folder is made on the first write). */
  constructor(file: string) {
    this.file = file;
  }

  private async prepare(): Promise<void> {
    if (this.prepared) return;
    const dir = path.dirname(this.file);
    const fresh = !(await fs.exists(dir));
    await fs.ensureDir(dir);
    if (proc.build.os !== "windows") await fs.chmod(dir, 0o700).catch(() => undefined);
    else if (fresh) await ownerOnly(dir);
    this.prepared = true;
  }

  /** The record, read again where another process was writing (a rename is atomic, but Windows may hold the file for a moment). */
  async read(): Promise<PairRecord | undefined> {
    for (let i = 0; i < 5; i++) {
      const text = await fs.readTextOr(this.file);
      if (text === undefined) return undefined;
      try {
        const v: unknown = JSON.parse(text);
        if (isRecord(v)) return v;
        return undefined;
      } catch {
        await proc.sleep(20);
      }
    }
    return undefined;
  }

  private async write(record: PairRecord): Promise<void> {
    const tmp = `${this.file}-tmp`;
    await fs.writeTextFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    if (proc.build.os !== "windows") await fs.chmod(tmp, 0o600);
    // Windows refuses a rename over a file another process is reading at that moment: it is a moment.
    for (let i = 0; ; i++) {
      try {
        await fs.rename(tmp, this.file);
        return;
      } catch (e) {
        if (i >= 20) throw e;
        await proc.sleep(25);
      }
    }
  }

  private async locked<T>(f: () => Promise<T>): Promise<T> {
    await this.prepare();
    const held = await lock.acquireLock(`${this.file}-lock`, {
      wait: true,
      pollMs: 15,
      timeoutMs: LOCK_WAIT_MS,
      command: "stolos pair",
    });
    if (!held) throw new Error("the pairing's file is locked by another process");
    try {
      return await f();
    } finally {
      held.release();
    }
  }

  /** Read, change and write back, under the lock. */
  update<T>(change: (record: PairRecord) => T): Promise<Changed<T> | undefined> {
    return this.locked(async () => {
      const record = await this.read();
      if (!record) return undefined;
      const result = change(record);
      await this.write(record);
      return { result, record };
    });
  }

  /** Write the record, replacing any other. */
  create(record: PairRecord): Promise<void> {
    return this.locked(() => this.write(record));
  }

  /** Delete the record. */
  async remove(): Promise<void> {
    await this.locked(async () => {
      await fs.remove(this.file).catch(() => undefined);
    });
  }
}
