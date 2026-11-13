// 032-web: the few Cloudflare API calls a server needs to keep its own DNS
// records (its name and wildcard, both to its private address, not proxied).
// The token needs Zone: Read and DNS: Edit on the zone (the same token
// Traefik uses for Let's Encrypt's DNS challenge).

const API = "https://api.cloudflare.com/client/v4";

export interface CfCredential {
  token: string;
  created?: string;
}

export interface ARecord {
  type: "A";
  name: string;
  content: string;
}

type Fetch = typeof fetch;

async function call<T>(
  f: Fetch,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await f(`${API}${path}`, {
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await r.json().catch(() => ({})) as {
    success?: boolean;
    errors?: Array<{ message: string }>;
    result?: T;
  };
  if (!r.ok || !body.success) {
    const why = body.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`;
    throw new Error(`Cloudflare ${init.method ?? "GET"} ${path.split("?")[0]}: ${why}`);
  }
  return body.result as T;
}

/** The zone's ID; fails clearly when the token cannot read it. */
export async function zoneId(token: string, zone: string, f: Fetch = fetch): Promise<string> {
  const zones = await call<Array<{ id: string; name: string }>>(
    f,
    token,
    `/zones?name=${encodeURIComponent(zone)}`,
  );
  const z = zones.find((x) => x.name === zone);
  if (!z) {
    throw new Error(
      `the token cannot see the zone ${zone} (it needs Zone: Read and DNS: Edit on ${zone})`,
    );
  }
  return z.id;
}

export interface Upserted {
  name: string;
  action: "unchanged" | "updated" | "created";
}

/** Make each record exist with this content (one per name and type). */
export async function upsertRecords(
  token: string,
  zone: string,
  records: ARecord[],
  comment: string,
  f: Fetch = fetch,
): Promise<Upserted[]> {
  const id = await zoneId(token, zone, f);
  const out: Upserted[] = [];
  for (const rec of records) {
    const found = await call<Array<{ id: string; content: string; proxied: boolean; ttl: number }>>(
      f,
      token,
      `/zones/${id}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`,
    );
    const body = JSON.stringify({ ...rec, ttl: 60, proxied: false, comment });
    if (found[0] && found[0].content === rec.content && !found[0].proxied && found[0].ttl === 60) {
      out.push({ name: rec.name, action: "unchanged" });
    } else if (found[0]) {
      await call(f, token, `/zones/${id}/dns_records/${found[0].id}`, { method: "PUT", body });
      out.push({ name: rec.name, action: "updated" });
    } else {
      await call(f, token, `/zones/${id}/dns_records`, { method: "POST", body });
      out.push({ name: rec.name, action: "created" });
    }
  }
  return out;
}

/** Spec 045 (retire): remove each A record with this name; the names removed. */
export async function deleteRecords(
  token: string,
  zone: string,
  names: string[],
  f: Fetch = fetch,
): Promise<string[]> {
  const id = await zoneId(token, zone, f);
  const removed: string[] = [];
  for (const name of names) {
    const found = await call<Array<{ id: string }>>(
      f,
      token,
      `/zones/${id}/dns_records?type=A&name=${encodeURIComponent(name)}`,
    );
    for (const r of found) {
      await call(f, token, `/zones/${id}/dns_records/${r.id}`, { method: "DELETE" });
    }
    if (found.length) removed.push(name);
  }
  return removed;
}
