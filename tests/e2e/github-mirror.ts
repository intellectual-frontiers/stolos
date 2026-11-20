/**
 * The lab's GitHub API mirror (tests/e2e/lib.sh; `ARCHON_GITHUB_API`, as `boot serve --github-api`
 * gives a site): the machines look up tool releases here, and this asks GitHub once per URL with
 * the job's `GITHUB_TOKEN`. Without it, GitHub's shared runner addresses exhaust the
 * unauthenticated limit (60 an hour) and installs fail with "GitHub API 403". The token stays on
 * the runner. Read-only: GET of `/repos/<owner>/<repo>/releases/...` and `/rate_limit` only.
 *
 * Usage: `bun tests/e2e/github-mirror.ts <address> <port>`.
 *
 * @module
 */
import { proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/net";

const [address = "127.0.0.1", port = "8001"] = proc.args;
const token = proc.env.get("GITHUB_TOKEN");
const cache = new Map<string, { status: number; body: string }>();
const allowed = /^\/(repos\/[\w.-]+\/[\w.-]+\/releases(\/[\w./-]*)?|rate_limit)$/;

await serve({ hostname: address, port: Number(port) }, async (req) => {
  const url = new URL(req.url);
  if (req.method !== "GET" || !allowed.test(url.pathname)) {
    return new Response("not mirrored\n", { status: 404 });
  }
  const key = url.pathname + url.search;
  let hit = cache.get(key);
  if (hit === undefined || url.pathname === "/rate_limit") {
    const r = await fetch(`https://api.github.com${key}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "archon-e2e-mirror",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });
    hit = { status: r.status, body: await r.text() };
    if (r.ok) cache.set(key, hit);
    console.log(`${r.status} ${key}`);
  }
  return new Response(hit.body, {
    status: hit.status,
    headers: { "content-type": "application/json" },
  });
});
