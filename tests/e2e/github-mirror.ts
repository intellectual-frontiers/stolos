// The lab's GitHub API mirror (ARCHON_GITHUB_API, as `boot serve --github-api`
// gives a site): the machines look up tool releases here, and this asks GitHub
// once per URL with the job's GITHUB_TOKEN. Without it, GitHub's shared runner
// addresses exhaust the unauthenticated limit (60 an hour) and installs fail
// with "GitHub API 403". The token stays on the runner. Read-only: GET of
// /repos/<owner>/<repo>/releases/... and /rate_limit only.
//
//   deno run -A github-mirror.ts <address> <port>

const [address, port] = Deno.args;
const token = Deno.env.get("GITHUB_TOKEN");
const cache = new Map<string, { status: number; body: string }>();
const allowed = /^\/(repos\/[\w.-]+\/[\w.-]+\/releases(\/[\w./-]*)?|rate_limit)$/;

Deno.serve({ hostname: address, port: Number(port), onListen() {} }, async (req) => {
  const url = new URL(req.url);
  if (req.method !== "GET" || !allowed.test(url.pathname)) {
    return new Response("not mirrored\n", { status: 404 });
  }
  const key = url.pathname + url.search;
  let hit = cache.get(key);
  if (!hit || url.pathname === "/rate_limit") {
    const r = await fetch(`https://api.github.com${key}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "archon-e2e-mirror",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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
