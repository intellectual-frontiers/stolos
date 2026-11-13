// 044-durable (Article 23): `archon data` shows whether this server is
// durable or ephemeral and why; `archon data set` changes one opt-in's
// choice. Calling durable data ephemeral needs --confirm-destroy <host>,
// typed by a person.

import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { journal } from "../core/log.ts";
import { loadHosts } from "../model/load.ts";
import type { DataClass } from "../model/types.ts";
import {
  dataSources,
  describeData,
  hostData,
  MEANING,
  USER_DATA_OPT_INS,
} from "../model/durable.ts";
import { caller, checkChoice, writeOptIn } from "./optin.ts";

/** Home directories on servers are ephemeral by rule (spec 044). */
export const HOME_RULE =
  "Home directories are not kept across a reinstall: keep data in a share, a bucket, or a database.";

/** Off-host copies are not built yet: a later spec adds the destination (a NAS). */
export const OFF_HOST =
  "no off-host copy yet: the destination is not chosen (a later spec adds it)";

/** Where each opt-in keeps its data, as the host can see it without root. */
export const DATA_DIRS = {
  pg: "/var/lib/postgresql",
  s3: "/srv/s3",
  smb: "/srv/smb/shared",
};

async function entries(path: string): Promise<string[] | undefined> {
  try {
    const out: string[] = [];
    for await (const e of Deno.readDir(path)) out.push(e.name);
    return out;
  } catch (e) {
    return e instanceof Deno.errors.NotFound ? [] : undefined; // undefined: cannot tell
  }
}

/**
 * The opt-ins whose data directory holds data on this host (Article 23's
 * fail-safe: data with no recorded choice counts as durable). PostgreSQL: a
 * cluster directory under /var/lib/postgresql/<version>/. S3: /srv/s3 is
 * private to the container's account, so its link count says whether RustFS
 * made anything in it (an empty directory has two). SMB: anything in the
 * shared folder. A directory that cannot be read counts as holding data.
 */
export async function dataOnDisk(dirs = DATA_DIRS): Promise<string[]> {
  const found: string[] = [];
  const versions = await entries(dirs.pg);
  if (versions === undefined) found.push("pg");
  else {
    for (const v of versions.filter((x) => /^\d+$/.test(x))) {
      const clusters = await entries(`${dirs.pg}/${v}`);
      if (clusters === undefined || clusters.length) {
        found.push("pg");
        break;
      }
    }
  }
  try {
    const st = await Deno.stat(dirs.s3);
    if (st.nlink === null || st.nlink > 2) found.push("s3");
    else if (st.nlink === 2) {
      const inside = await entries(dirs.s3);
      if (inside === undefined ? false : inside.length > 0) found.push("s3");
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) found.push("s3");
  }
  const shared = await entries(dirs.smb);
  if (shared === undefined || shared.length) found.push("smb");
  return found;
}

async function host(hostName: string) {
  const h = (await loadHosts()).find((x) => x.name === hostName);
  if (!h) throw new Error(`no host ${hostName} in the model`);
  return h;
}

export async function dataShow(hostName: string, json: boolean): Promise<number> {
  const h = await host(hostName);
  const d = hostData(h, await dataOnDisk());
  if (json) {
    console.log(JSON.stringify(
      {
        ...d,
        meaning: MEANING[d.class],
        offHost: d.class === "durable" ? null : undefined,
        home: "ephemeral",
      },
      null,
      2,
    ));
    return 0;
  }
  const p = ui.phase("Data");
  if (!d.sources.length) p.done(`${h.name} is ephemeral: nothing on it holds end users' data`);
  for (const s of d.sources) {
    const line = `${s.title}: ${s.data}${s.on ? "" : " (off, data kept)"}`;
    if (s.data === "unchosen") {
      p.warn(`${line}, so it counts as durable`, d.unchosen.find((u) => u.name === s.name)?.fix);
    } else p.note(line);
  }
  if (d.sources.length) p.done(`${h.name} is ${describeData(d)}: ${MEANING[d.class]}`);
  if (d.class === "durable") p.warn(OFF_HOST);
  ui.next.push(HOME_RULE);
  return d.unchosen.length ? 1 : 0;
}

export async function dataSet(
  hostName: string,
  name: string,
  data: DataClass,
  confirm: unknown,
): Promise<number> {
  const h = await host(hostName);
  if (h.guests?.some((g) => g.name === name)) {
    throw new Error(
      `guest ${name}: its data is chosen in the model (data: "durable" | "ephemeral")`,
    );
  }
  if (!(name in USER_DATA_OPT_INS)) {
    throw new Error(
      `${name} holds no end users' data; choices are for: ${
        Object.keys(USER_DATA_OPT_INS).join(", ")
      }`,
    );
  }
  const onDisk = await dataOnDisk();
  if (!dataSources(h, onDisk).some((s) => s.kind === "opt-in" && s.name === name)) {
    throw new Error(
      `${USER_DATA_OPT_INS[name]} has never been on here: the choice is made when it is turned on`,
    );
  }
  checkChoice(h, name, data, confirm, onDisk);
  const rec = h.optIn?.[name];
  const p = ui.phase("Data");
  const by = caller();
  await writeOptIn(h.name, name, rec?.enabled === true, by, P.state, data);
  p.done(`${USER_DATA_OPT_INS[name]}: ${data}; recorded in archon.sql ${h.name}/${name}.json`);
  const fresh = (await loadHosts()).find((x) => x.name === h.name)!;
  const { apply } = await import("../apply/apply.ts");
  const res = await apply(fresh, { check: false, only: ["files"] });
  const d = hostData(fresh, onDisk);
  await journal("archon-data", `${USER_DATA_OPT_INS[name]} on ${h.name} set ${data} by ${by}`);
  const { notify } = await import("../notify/events.ts");
  await notify({
    event: `${USER_DATA_OPT_INS[name]} data set ${data}`,
    level: data === "ephemeral" ? "warn" : "info",
    what: `${by} recorded the data of ${
      USER_DATA_OPT_INS[name]
    } on ${h.name} as ${data}. ${h.name} is now ${describeData(d)}.`,
    todo: "Nothing.",
    key: `data:${h.name}:${name}:${data}`,
  }).catch(() => {});
  ui.next.push(`${h.name} is ${describeData(d)}; recorded in its own archon.sql (archon state).`);
  return res.failed ? 1 : 0;
}
