// The end-to-end lab's file server (tests/e2e/ci.sh): this checkout of the
// engine (as TypeScript, for @stolos/) and the throwaway fleet repository (git
// over dumb HTTP), from one folder, on the lab bridge only.
// usage: deno run -A tests/e2e/serve.ts <folder> <address> <port>

const [root, hostname, port] = Deno.args;
const TYPES: Record<string, string> = {
  ts: "application/typescript; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
};

Deno.serve({ hostname, port: Number(port) }, async (req) => {
  const path = decodeURIComponent(new URL(req.url).pathname);
  if (path.includes("..")) return new Response("no\n", { status: 400 });
  try {
    const file = await Deno.open(`${root}${path}`, { read: true });
    if ((await file.stat()).isDirectory) {
      file.close();
      return new Response("not a file\n", { status: 404 });
    }
    const type = TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";
    return new Response(file.readable, { headers: { "content-type": type } });
  } catch {
    return new Response("not found\n", { status: 404 });
  }
});
