/**
 * Spec 065: checks a username and password with Linux itself (PAM). The
 * console calls it in a worker thread ({@link pamAuthenticator}): pam_unix
 * waits about two seconds after a wrong password, and the web server must not
 * stop answering meanwhile. The service is
 * `archon-console` (/etc/pam.d/archon-console: common-auth and common-account,
 * as Ubuntu's own services use them); the console's account is in the shadow
 * group, so pam_unix can read the password hashes.
 *
 * libpam and libc are called through Deno's FFI; the PAM conversation answers
 * the username prompt and the password prompt, and nothing else.
 *
 * @module
 */

const PAM_PROMPT_ECHO_OFF = 1;
const PAM_PROMPT_ECHO_ON = 2;
const PAM_SUCCESS = 0;

const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");

let lib:
  | {
    pam: Deno.DynamicLibrary<{
      pam_start: { parameters: ["buffer", "buffer", "buffer", "buffer"]; result: "i32" };
      pam_authenticate: { parameters: ["pointer", "i32"]; result: "i32" };
      pam_acct_mgmt: { parameters: ["pointer", "i32"]; result: "i32" };
      pam_end: { parameters: ["pointer", "i32"]; result: "i32" };
    }>;
    libc: Deno.DynamicLibrary<{
      calloc: { parameters: ["usize", "usize"]; result: "pointer" };
      strdup: { parameters: ["buffer"]; result: "pointer" };
      memcpy: { parameters: ["pointer", "buffer", "usize"]; result: "pointer" };
    }>;
  }
  | undefined;

function open() {
  lib ??= {
    pam: Deno.dlopen("libpam.so.0", {
      pam_start: { parameters: ["buffer", "buffer", "buffer", "buffer"], result: "i32" },
      pam_authenticate: { parameters: ["pointer", "i32"], result: "i32" },
      pam_acct_mgmt: { parameters: ["pointer", "i32"], result: "i32" },
      pam_end: { parameters: ["pointer", "i32"], result: "i32" },
    }),
    libc: Deno.dlopen("libc.so.6", {
      calloc: { parameters: ["usize", "usize"], result: "pointer" },
      strdup: { parameters: ["buffer"], result: "pointer" },
      memcpy: { parameters: ["pointer", "buffer", "usize"], result: "pointer" },
    }),
  };
  return lib;
}

/** Whether `user` signs in with `password` through the PAM service `service`. */
export function pamCheck(service: string, user: string, password: string): boolean {
  const { pam, libc } = open();
  // The conversation: PAM asks; we answer the password (hidden prompt) and the
  // username (visible prompt). PAM frees the answers, so libc allocates them.
  const conv = new Deno.UnsafeCallback(
    { parameters: ["i32", "pointer", "pointer", "pointer"], result: "i32" } as const,
    (n, msgs, resp) => {
      if (!msgs || !resp || n <= 0 || n > 32) return 19; // PAM_CONV_ERR
      const list = libc.symbols.calloc(BigInt(n), 16n);
      if (!list) return 5; // PAM_BUF_ERR
      const view = new Deno.UnsafePointerView(msgs);
      for (let i = 0; i < n; i++) {
        const m = view.getPointer(i * 8);
        if (!m) continue;
        const style = new Deno.UnsafePointerView(m).getInt32(0);
        const answer = style === PAM_PROMPT_ECHO_OFF
          ? password
          : style === PAM_PROMPT_ECHO_ON
          ? user
          : undefined;
        if (answer === undefined) continue;
        const s = libc.symbols.strdup(cstr(answer));
        const slot = Deno.UnsafePointer.offset(list, i * 16);
        libc.symbols.memcpy(slot, new BigUint64Array([BigInt(Deno.UnsafePointer.value(s))]), 8n);
      }
      libc.symbols.memcpy(resp, new BigUint64Array([BigInt(Deno.UnsafePointer.value(list))]), 8n);
      return PAM_SUCCESS;
    },
  );
  try {
    // struct pam_conv { conv function; appdata_ptr }
    const convStruct = new BigUint64Array([BigInt(Deno.UnsafePointer.value(conv.pointer)), 0n]);
    const handleOut = new BigUint64Array(1);
    if (pam.symbols.pam_start(cstr(service), cstr(user), convStruct, handleOut) !== PAM_SUCCESS) {
      return false;
    }
    const h = Deno.UnsafePointer.create(handleOut[0]);
    let rc = pam.symbols.pam_authenticate(h, 0);
    if (rc === PAM_SUCCESS) rc = pam.symbols.pam_acct_mgmt(h, 0); // expired or locked accounts too
    pam.symbols.pam_end(h, rc);
    return rc === PAM_SUCCESS;
  } finally {
    conv.close();
  }
}

/** Checks a username and password: PAM on a server, a fake in tests. */
export interface Authenticator {
  /** Whether `user` signs in with `password`. */
  check(user: string, password: string): Promise<boolean>;
}

/** PAM in a worker thread, through the service `service` (/etc/pam.d/<service>). */
export function pamAuthenticator(service = "archon-console"): Authenticator {
  let worker: Worker | undefined;
  let next = 0;
  const waiting = new Map<number, (ok: boolean) => void>();
  const start = () => {
    worker = new Worker(new URL("./pam-worker.ts", import.meta.url).href, { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean }>) => {
      waiting.get(e.data.id)?.(e.data.ok);
      waiting.delete(e.data.id);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      for (const done of waiting.values()) done(false);
      waiting.clear();
      worker = undefined;
    };
  };
  return {
    check(user, password) {
      if (!worker) start();
      const id = ++next;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        worker!.postMessage({ id, service, user, password });
      });
    },
  };
}
