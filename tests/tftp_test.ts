import { assert, assertEquals } from "./assert.ts";
import { negotiate, parseRequest, serveTftp } from "../src/archon-boot/tftp.ts";
import dgram from "node:dgram";
import { Buffer } from "node:buffer";

Deno.test("TFTP: read requests and option negotiation", () => {
  const rrq = new TextEncoder().encode("\0\x01bootx64.efi\0octet\0blksize\x001468\0tsize\x000\0");
  const r = parseRequest(rrq)!;
  assertEquals(r.file, "bootx64.efi");
  assertEquals(r.mode, "octet");
  const n = negotiate(r.opts, 966768);
  assertEquals(n.blksize, 1468);
  assertEquals(n.out, { blksize: "1468", tsize: "966768" });
  assertEquals(negotiate({ blksize: "65464" }, 1).blksize, 1468);
  assertEquals(parseRequest(new Uint8Array([0, 2, 0])), undefined);
});

Deno.test("TFTP: a transfer past block 65535 rolls over and arrives intact", async () => {
  const data = new Uint8Array(70000 * 8 + 3).map((_, i) => i * 7);
  const port = 16969 + Math.floor(Math.random() * 1000);
  const server = await serveTftp({
    port,
    emit: () => {},
    read: (p) => Promise.resolve(p === "big" ? data : undefined),
  });
  const got: Uint8Array[] = [];
  const c = dgram.createSocket("udp4");
  const done = new Promise<void>((resolve) => {
    c.on("message", (m: Buffer, r: { address: string; port: number }) => {
      if (m[1] === 6) return c.send(Buffer.from([0, 4, 0, 0]), r.port, r.address);
      if (m[1] !== 3) return;
      got.push(new Uint8Array(m.subarray(4)));
      c.send(Buffer.from([0, 4, m[2], m[3]]), r.port, r.address);
      if (m.length - 4 < 8) resolve();
    });
  });
  c.send(Buffer.from("\0\x01big\0octet\0blksize\x008\0"), port, "127.0.0.1");
  await done;
  c.close();
  server.close();
  const all = new Uint8Array(got.reduce((n, g) => n + g.length, 0));
  let o = 0;
  for (const g of got) all.set(g, (o += g.length) - g.length);
  assertEquals(all.length, data.length);
  assert(all.every((b, i) => b === data[i]));
});
