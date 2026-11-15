/**
 * Spec 065: checks a username and password with Linux itself (PAM). The
 * console calls it in a worker thread ({@link pamAuthenticator}): pam_unix
 * waits about two seconds after a wrong password, and the web server must not
 * stop answering meanwhile. The service is
 * `archon-console` (/etc/pam.d/archon-console: common-auth and common-account,
 * as Ubuntu's own services use them); the console's account is in the shadow
 * group, so pam_unix can read the password hashes.
 *
 * libpam and libc are called through Bun's FFI (`bun:ffi`, spec 096 FR-010): this is the one
 * file of the engine that names it, and it loads it only on Bun. On Node the password sign-in
 * is refused as not supported ({@link PAM_UNSUPPORTED}). The PAM conversation answers the
 * username prompt and the password prompt, and nothing else.
 *
 * @module
 */

import { errors, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { Worker } from "node:worker_threads";

const PAM_PROMPT_ECHO_OFF = 1;
const PAM_PROMPT_ECHO_ON = 2;
const PAM_SUCCESS = 0;
const PAM_BUF_ERR = 5;
const PAM_CONV_ERR = 19;

/** Why the password sign-in is refused where the engine runs on Node (spec 096 FR-010). */
export const PAM_UNSUPPORTED =
  "password sign-in needs Bun (PAM is called through bun:ffi): run the console with Bun";

/** Whether this runtime can check a password with PAM: Bun only (spec 096 FR-010). */
export function pamSupported(runtime: string = proc.runtimeName()): boolean {
  return runtime === "bun";
}

const enc = new TextEncoder();

/** A C string: the text's UTF-8 bytes and a terminating NUL. */
export function cstr(s: string): Uint8Array {
  return enc.encode(s + "\0");
}

/**
 * The answer to one PAM conversation message, by its style: the password to a hidden prompt, the
 * username to a visible one, nothing to anything else (error and information messages).
 */
export function answerFor(style: number, user: string, password: string): string | undefined {
  if (style === PAM_PROMPT_ECHO_OFF) return password;
  if (style === PAM_PROMPT_ECHO_ON) return user;
  return undefined;
}

/** A 64-bit pointer's bytes, as libc's memcpy copies it into a `struct` (little-endian hosts). */
export function pointerBytes(pointer: number): BigUint64Array {
  return new BigUint64Array([BigInt(pointer)]);
}

// ------------------------------------------------------------------ bun:ffi, the part used here

/** A native pointer, as bun:ffi gives it: a number, or null for NULL. */
type Pointer = number;

/** An argument or result type of bun:ffi, by the names this binding uses. */
type FfiType = "i32" | "ptr" | "usize";

/** A C function's signature for bun:ffi. */
type Signature = { readonly args: readonly FfiType[]; readonly returns: FfiType };

/** The functions of libpam this binding calls. */
type PamSymbols = {
  pam_start(
    service: Uint8Array,
    user: Uint8Array,
    conv: BigUint64Array,
    handle: BigUint64Array,
  ): number;
  pam_start_confdir(
    service: Uint8Array,
    user: Uint8Array,
    conv: BigUint64Array,
    confdir: Uint8Array,
    handle: BigUint64Array,
  ): number;
  pam_authenticate(handle: Pointer, flags: number): number;
  pam_acct_mgmt(handle: Pointer, flags: number): number;
  pam_end(handle: Pointer, status: number): number;
};

/** The functions of libc this binding calls (PAM frees the answers, so libc allocates them). */
type LibcSymbols = {
  calloc(n: number, size: number): Pointer | null;
  strdup(s: Uint8Array): Pointer | null;
  memcpy(dest: Pointer, src: BigUint64Array, n: number): Pointer | null;
};

/** The PAM conversation function: how many messages, the messages, where to put the answers. */
type Conversation = (n: number, msgs: Pointer | null, resp: Pointer | null) => number;

/**
 * What this binding uses of `bun:ffi` (Bun's own type declarations are not installed: the engine
 * type-checks against Node's, and this file alone reaches Bun's API).
 */
type BunFfi = {
  dlopen(path: string, symbols: Readonly<Record<string, Signature>>): { readonly symbols: unknown };
  JSCallback: new (
    fn: Conversation,
    signature: Signature,
  ) => { readonly ptr: Pointer | null; close(): void };
  read: {
    ptr(p: Pointer, offset: number): Pointer | null;
    i32(p: Pointer, offset: number): number;
  };
};

const PAM_SIGNATURES: Readonly<Record<keyof PamSymbols, Signature>> = {
  pam_start: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  pam_start_confdir: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  pam_authenticate: { args: ["ptr", "i32"], returns: "i32" },
  pam_acct_mgmt: { args: ["ptr", "i32"], returns: "i32" },
  pam_end: { args: ["ptr", "i32"], returns: "i32" },
};

const LIBC_SIGNATURES: Readonly<Record<keyof LibcSymbols, Signature>> = {
  calloc: { args: ["usize", "usize"], returns: "ptr" },
  strdup: { args: ["ptr"], returns: "ptr" },
  memcpy: { args: ["ptr", "ptr", "usize"], returns: "ptr" },
};

/** The module's name, held in a variable so that Node, which never loads it, does not resolve it. */
const BUN_FFI = "bun:ffi";

/** Checks one username and password through a PAM service (and, in tests, a PAM configuration folder). */
export type PamCheck = (
  service: string,
  user: string,
  password: string,
  confdir?: string,
) => boolean;

/**
 * libpam and libc opened through bun:ffi, as a synchronous check (it blocks: call it in a worker).
 * Throws `NotSupported` on any runtime but Bun, before anything is loaded.
 */
export async function loadPam(): Promise<PamCheck> {
  if (!pamSupported()) throw new errors.NotSupported(PAM_UNSUPPORTED, "ENOTSUP");
  const ffi = (await import(BUN_FFI)) as BunFfi;
  const pam = ffi.dlopen("libpam.so.0", PAM_SIGNATURES).symbols as PamSymbols;
  const libc = ffi.dlopen("libc.so.6", LIBC_SIGNATURES).symbols as LibcSymbols;
  return (service, user, password, confdir) => {
    // The conversation: PAM asks; we answer the password (hidden prompt) and the
    // username (visible prompt). PAM frees the answers, so libc allocates them.
    const conv = new ffi.JSCallback(
      (n, msgs, resp) => {
        if (msgs === null || resp === null || n <= 0 || n > 32) return PAM_CONV_ERR;
        const list = libc.calloc(n, 16); // struct pam_response { char *resp; int resp_retcode; }
        if (list === null) return PAM_BUF_ERR;
        for (let i = 0; i < n; i++) {
          const m = ffi.read.ptr(msgs, i * 8);
          if (m === null) continue;
          const answer = answerFor(ffi.read.i32(m, 0), user, password);
          if (answer === undefined) continue;
          const s = libc.strdup(cstr(answer));
          if (s === null) return PAM_BUF_ERR;
          libc.memcpy(list + i * 16, pointerBytes(s), 8);
        }
        libc.memcpy(resp, pointerBytes(list), 8);
        return PAM_SUCCESS;
      },
      { args: ["i32", "ptr", "ptr", "ptr"], returns: "i32" },
    );
    try {
      if (conv.ptr === null) return false;
      // struct pam_conv { conv function; appdata_ptr }
      const convStruct = new BigUint64Array([BigInt(conv.ptr), 0n]);
      const handleOut = new BigUint64Array(1);
      const started =
        confdir === undefined
          ? pam.pam_start(cstr(service), cstr(user), convStruct, handleOut)
          : pam.pam_start_confdir(cstr(service), cstr(user), convStruct, cstr(confdir), handleOut);
      if (started !== PAM_SUCCESS) return false;
      const h = Number(handleOut[0] ?? 0n);
      let rc = pam.pam_authenticate(h, 0);
      if (rc === PAM_SUCCESS) rc = pam.pam_acct_mgmt(h, 0); // expired or locked accounts too
      pam.pam_end(h, rc);
      return rc === PAM_SUCCESS;
    } finally {
      conv.close();
    }
  };
}

// ------------------------------------------------------------------ the worker

/** What the console asks the worker (pam-worker.ts). */
export type PamRequest = {
  /** The request's number, given back with the answer. */
  readonly id: number;
  /** The PAM service (/etc/pam.d/<service>). */
  readonly service: string;
  /** The account's name. */
  readonly user: string;
  /** The password typed. */
  readonly password: string;
  /** A PAM configuration folder instead of /etc/pam.d (tests). */
  readonly confdir?: string;
};

/** What the worker answers. */
export type PamReply = {
  /** The request's number. */
  readonly id: number;
  /** Whether the account signs in with that password. */
  readonly ok: boolean;
};

/** A message as a request to the worker, or undefined where it is not one. */
export function pamRequest(m: unknown): PamRequest | undefined {
  if (typeof m !== "object" || m === null) return undefined;
  const r = m as Record<string, unknown>;
  const { id, service, user, password, confdir } = r;
  if (typeof id !== "number" || typeof service !== "string" || typeof user !== "string") {
    return undefined;
  }
  if (typeof password !== "string") return undefined;
  if (confdir !== undefined && typeof confdir !== "string") return undefined;
  return { id, service, user, password, ...(confdir === undefined ? {} : { confdir }) };
}

/** A message as the worker's answer, or undefined where it is not one. */
export function pamReply(m: unknown): PamReply | undefined {
  if (typeof m !== "object" || m === null) return undefined;
  const { id, ok } = m as Record<string, unknown>;
  return typeof id === "number" && typeof ok === "boolean" ? { id, ok } : undefined;
}

/** Checks a username and password: PAM on a server, a fake in tests. */
export interface Authenticator {
  /** Whether `user` signs in with `password`; rejects with `NotSupported` where the runtime cannot check. */
  check(user: string, password: string): Promise<boolean>;
}

/**
 * PAM in a worker thread, through the service `service` (/etc/pam.d/<service>, or `confdir`'s).
 * On Node every check rejects with `NotSupported` ({@link PAM_UNSUPPORTED}) and no worker starts.
 */
export function pamAuthenticator(
  service = "archon-console",
  o: { confdir?: string } = {},
): Authenticator & { close(): Promise<void> } {
  let worker: Worker | undefined;
  let next = 0;
  const waiting = new Map<number, (ok: boolean) => void>();
  const fail = (): void => {
    for (const done of waiting.values()) done(false);
    waiting.clear();
    worker = undefined;
  };
  const start = (): Worker => {
    const w = new Worker(new URL("./pam-worker.ts", import.meta.url));
    w.on("message", (m: unknown) => {
      const r = pamReply(m);
      if (!r) return;
      waiting.get(r.id)?.(r.ok);
      waiting.delete(r.id);
    });
    w.on("error", fail);
    w.on("exit", fail);
    worker = w;
    return w;
  };
  return {
    check(user: string, password: string): Promise<boolean> {
      if (!pamSupported())
        return Promise.reject(new errors.NotSupported(PAM_UNSUPPORTED, "ENOTSUP"));
      const w = worker ?? start();
      const id = ++next;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        const request: PamRequest = {
          id,
          service,
          user,
          password,
          ...(o.confdir === undefined ? {} : { confdir: o.confdir }),
        };
        w.postMessage(request);
      });
    },
    async close(): Promise<void> {
      const w = worker;
      worker = undefined;
      if (w) await w.terminate();
    },
  };
}
