// Download Ubuntu's boot files and installer image once, verify each against
// its pinned SHA-256 (Article 12), and cache them on the boot machine.

import { createHash } from "node:crypto";
import { P } from "../archon/core/paths.ts";
import { join } from "../archon/core/path.ts";
import { ensureDir, exists } from "../archon/core/fsx.ts";
import type { Phase } from "../archon/core/ui.ts";
import { UBUNTU } from "./pins.ts";

export const cacheDir = () => join(P.bootCache, UBUNTU.point);

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  const f = await Deno.open(path);
  for await (const chunk of f.readable) h.update(chunk);
  return h.digest("hex");
}

async function download(url: string, to: string, p: Phase, label: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = `${to}.partial`;
  const f = await Deno.open(tmp, { create: true, write: true, truncate: true });
  let got = 0;
  let last = 0;
  for await (const chunk of res.body) {
    await f.write(chunk);
    got += chunk.length;
    if (total && Date.now() - last > 250) {
      last = Date.now();
      p.step(
        Math.round((got / total) * 100),
        100,
        `${label} ${(got / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB`,
      );
    }
  }
  f.close();
  await Deno.rename(tmp, to);
}

/** Ensure one verified file in the cache; returns its path. */
async function ensure(name: string, url: string, sha: string, p: Phase): Promise<string> {
  const dir = cacheDir();
  await ensureDir(dir);
  const path = join(dir, name);
  if ((await exists(path)) && (await sha256File(path)) === sha) return path;
  p.status(`downloading ${name}`);
  await download(url, path, p, name);
  p.status(`verifying ${name}`);
  const got = await sha256File(path);
  if (got !== sha) {
    await Deno.remove(path).catch(() => {});
    throw new Error(
      `${name}: SHA-256 ${got} does not match the pin ${sha} (Article 12); nothing is served`,
    );
  }
  return path;
}

export interface Assets {
  files: Record<string, string>;
  iso: string;
}

export async function ensureAssets(p: Phase): Promise<Assets> {
  const files: Record<string, string> = {};
  for (const [name, sha] of Object.entries(UBUNTU.files)) {
    files[name] = await ensure(name, UBUNTU.netboot + name, sha, p);
  }
  const iso = await ensure(UBUNTU.iso.name, UBUNTU.iso.url, UBUNTU.iso.sha256, p);
  return { files, iso };
}
