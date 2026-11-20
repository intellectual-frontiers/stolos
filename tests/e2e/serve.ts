/**
 * The end-to-end lab's file server (tests/e2e/ci.sh, spec 004): the engine under test (a Git
 * repository, for the fleet's `package.json`: `git+http://.../stolos.git#<commit>`), and the
 * throwaway fleet repository, both as Git over plain HTTP, from one folder, on the lab bridge only.
 *
 * Usage: `bun tests/e2e/serve.ts <folder> <address> <port>`.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/net";

const [root = ".", hostname = "127.0.0.1", port = "8000"] = proc.args;
const TYPES: Readonly<Record<string, string>> = {
  ts: "application/typescript; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  tgz: "application/gzip",
};

await serve({ hostname, port: Number(port) }, async (req) => {
  const rel = decodeURIComponent(new URL(req.url).pathname);
  if (rel.includes("..")) return new Response("no\n", { status: 400 });
  const file = path.join(root, rel);
  try {
    if (!(await fs.stat(file)).isFile) return new Response("not a file\n", { status: 404 });
    const type = TYPES[rel.split(".").pop() ?? ""] ?? "application/octet-stream";
    return new Response(new Uint8Array(await fs.readFile(file)), {
      headers: { "content-type": type },
    });
  } catch {
    return new Response("not found\n", { status: 404 });
  }
});
