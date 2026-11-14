/**
 * A read-only TFTP server for PXE (spec 004): UEFI PXE firmware fetches shim
 * over TFTP, shim fetches GRUB, and GRUB its menu, kernel, and initrd, all from
 * the same server. Each read is answered by the same handler as HTTP, so PXE
 * and HTTP Boot serve identical files and menus. RFC 1350 with the blksize
 * (2348), tsize (2349), timeout (2349), and windowsize (7440) options; block
 * numbers roll over past 65535 (Ubuntu's initrd is ~100 MB).
 *
 * @module
 */

import type { ArchonEvent } from "../archon/telemetry/events.ts";
import dgram from "node:dgram";
import { Buffer } from "node:buffer";

const RRQ = 1, DATA = 3, ACK = 4, ERROR = 5, OACK = 6;

/** Options for the TFTP server. */
export interface TftpOptions {
  /** The UDP port to listen on (69 is TFTP's standard port). */
  port: number;
  /** Read a file for a client: bytes, or undefined when there is none. */
  read: (path: string, from: string) => Promise<Uint8Array | undefined>;
  /** Spec 049: structured events; the window and boot.log render them. */
  emit: (e: ArchonEvent) => void;
}

function errorPacket(code: number, msg: string): Buffer {
  return Buffer.concat([Buffer.from([0, ERROR, 0, code]), Buffer.from(msg + "\0")]);
}

/**
 * Parse a TFTP read request (RRQ): the file, the transfer mode (lowercased)
 * and the options (names lowercased). Undefined for anything else.
 */
export function parseRequest(
  msg: Uint8Array,
): { file: string; mode: string; opts: Record<string, string> } | undefined {
  if (msg.length < 4 || msg[0] !== 0 || msg[1] !== RRQ) return undefined;
  const parts = new TextDecoder().decode(msg.subarray(2)).split("\0");
  const [file, mode, ...rest] = parts;
  if (!file || !mode) return undefined;
  const opts: Record<string, string> = {};
  for (let i = 0; i + 1 < rest.length; i += 2) {
    if (rest[i]) opts[rest[i].toLowerCase()] = rest[i + 1];
  }
  return { file, mode: mode.toLowerCase(), opts };
}

/** Negotiate options: what we accept, as sent back in the OACK. */
export function negotiate(
  opts: Record<string, string>,
  size: number,
): {
  /** The accepted options, to send back in the OACK (empty when none were asked). */
  out: Record<string, string>;
  /** Bytes per DATA block: 512 unless asked, clamped to 8..1468. */
  blksize: number;
  /** Retransmit timeout in seconds: 1 unless asked, clamped to 1..255. */
  timeout: number;
  /** Blocks sent before waiting for an ACK: 1 unless asked, clamped to 1..64. */
  window: number;
} {
  const out: Record<string, string> = {};
  let blksize = 512, timeout = 1, window = 1;
  if (opts.blksize) {
    // 1468 fits an Ethernet frame without fragmentation.
    blksize = Math.max(8, Math.min(1468, Number(opts.blksize) || 512));
    out.blksize = String(blksize);
  }
  if (opts.tsize !== undefined) out.tsize = String(size);
  if (opts.timeout) {
    timeout = Math.max(1, Math.min(255, Number(opts.timeout) || 1));
    out.timeout = String(timeout);
  }
  if (opts.windowsize) {
    window = Math.max(1, Math.min(64, Number(opts.windowsize) || 1));
    out.windowsize = String(window);
  }
  return { out, blksize, timeout, window };
}

async function transfer(
  data: Uint8Array,
  client: { address: string; port: number },
  opts: Record<string, string>,
): Promise<void> {
  const { out, blksize, timeout, window } = negotiate(opts, data.length);
  const blocks = Math.floor(data.length / blksize) + 1; // the last block is short (maybe empty)
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, r));
  const send = (b: Buffer) => sock.send(b, client.port, client.address);
  const block = (i: number) => {
    const chunk = data.subarray((i - 1) * blksize, Math.min(i * blksize, data.length));
    return Buffer.concat([Buffer.from([0, DATA, (i >> 8) & 0xff, i & 0xff]), Buffer.from(chunk)]);
  };
  // Wait for the ACK of an absolute block number in (lo, hi]; returns it, or -1 on timeout.
  let pending: ((wire: number) => void) | undefined;
  sock.on("message", (m: Buffer, r: { address: string; port: number }) => {
    if (r.address !== client.address || r.port !== client.port) {
      sock.send(errorPacket(5, "unknown transfer ID"), r.port, r.address);
      return;
    }
    if (m[1] === ERROR) pending?.(-2);
    else if (m[1] === ACK) pending?.((m[2] << 8) | m[3]);
  });
  const ackOf = (lo: number, hi: number): Promise<number> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        pending = undefined;
        resolve(-1);
      }, timeout * 1000);
      pending = (wire) => {
        if (wire === -2) {
          clearTimeout(t);
          pending = undefined;
          return resolve(-2);
        }
        for (let abs = hi; abs >= lo; abs--) {
          if ((abs & 0xffff) === wire) {
            clearTimeout(t);
            pending = undefined;
            return resolve(abs);
          }
        }
      };
    });
  try {
    if (Object.keys(out).length) {
      const oack = Buffer.concat([
        Buffer.from([0, OACK]),
        ...Object.entries(out).map(([k, v]) => Buffer.from(`${k}\0${v}\0`)),
      ]);
      let ok = false;
      for (let tries = 0; tries < 6 && !ok; tries++) {
        send(oack);
        const a = await ackOf(0, 0);
        if (a === -2) return;
        ok = a === 0;
      }
      if (!ok) return;
    }
    let acked = 0;
    let tries = 0;
    while (acked < blocks) {
      const last = Math.min(acked + window, blocks);
      for (let i = acked + 1; i <= last; i++) send(block(i));
      const a = await ackOf(acked + 1, last);
      if (a === -2) return;
      if (a < 0) {
        if (++tries >= 6) return;
        continue;
      }
      tries = 0;
      acked = a;
    }
  } finally {
    sock.close();
  }
}

/**
 * Serve TFTP reads on `o.port` (all IPv4 addresses). Resolves once bound, with
 * a `close` to stop it; rejects with a plain explanation when the port is in
 * use or needs privileges.
 */
export function serveTftp(o: TftpOptions): Promise<{ close: () => void }> {
  const sock = dgram.createSocket("udp4");
  sock.on("message", async (m: Buffer, r: { address: string; port: number }) => {
    const req = parseRequest(new Uint8Array(m));
    if (!req) {
      sock.send(errorPacket(4, "only reads are served"), r.port, r.address);
      return;
    }
    try {
      const data = await o.read(req.file, r.address);
      if (!data) {
        sock.send(errorPacket(1, "file not found"), r.port, r.address);
        return;
      }
      await transfer(data, r, req.opts);
    } catch (e) {
      o.emit({
        name: "boot.error",
        address: r.address,
        message: `TFTP ${req.file}: ${(e as Error).message}`,
        attrs: { via: "TFTP", file: req.file },
      });
    }
  });
  return new Promise((resolve, reject) => {
    sock.once("error", (e: Error & { code?: string }) =>
      reject(
        e.code === "EADDRINUSE"
          ? new Error(
            `UDP port ${o.port} is in use: stop the other TFTP server (Tftpd64, Windows Deployment Services)`,
          )
          : e.code === "EACCES"
          ? new Error(
            `UDP port ${o.port} needs privileges on Linux: run boot serve with sudo, or use --tftp-port and point the router there`,
          )
          : e,
      ));
    sock.bind(o.port, "0.0.0.0", () => resolve({ close: () => sock.close() }));
  });
}
