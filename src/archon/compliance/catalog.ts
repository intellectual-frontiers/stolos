/**
 * Spec 071: the official catalogs, never Stolos's own. The Secure Controls
 * Framework (SCF) workbook, as the SCF Council publishes it, gives each
 * control's name and its mappings (STRM) to SOC 2, HIPAA, PCI DSS, CMMC,
 * NIST SP 800-53 and 800-171, and FedRAMP. Stolos does not redistribute it:
 * each PC downloads the pinned release from the SCF's own repository, checks
 * its SHA-256, reads the workbook here, and keeps what it needs in its cache.
 * NIST's OSCAL catalogs (SP 800-53 Rev 5, SP 800-171 Rev 3) come the same way
 * from NIST's repository, for control titles in OSCAL exports.
 *
 * ```mermaid
 * flowchart LR
 *   scf["SCF Council: the workbook (pinned commit, SHA-256)"] --> read["read here (XLSX)"] --> cache["this PC's cache: catalog JSON"]
 *   nist["NIST: OSCAL catalogs (pinned commit, SHA-256)"] --> cache
 *   cache --> view["Compliance: names and framework mappings"] & oscal["OSCAL exports"]
 * ```
 *
 * @module
 */
// Spec: 071-catalogs-oscal

import {
  array,
  type Decoder,
  json,
  literal,
  mapDecoder,
  number,
  object,
  record,
  string,
} from "@intellectual-frontiers/core";
import {
  attribute,
  child,
  children,
  descendants,
  formatXmlError,
  readXml,
  textOf,
  unzip,
  type XmlElement,
} from "@intellectual-frontiers/formats";
import { sha256 } from "@intellectual-frontiers/crypto";
import { fs, path } from "@intellectual-frontiers/system";
import { P } from "../core/paths.ts";
import { type FrameworkId, FRAMEWORKS } from "./scf.ts";

/** A downloadable source, pinned. */
export interface PinnedSource {
  /** Its name for people. */
  title: string;
  /** Its version. */
  version: string;
  /** Where it is, at a pinned commit. */
  url: string;
  /** Its SHA-256. */
  sha256: string;
  /** Who publishes it, and on what terms. */
  publisher: string;
}

/** The SCF release Stolos reads. */
export const SCF_SOURCE: PinnedSource = {
  title: "Secure Controls Framework",
  version: "2026.3",
  url: "https://raw.githubusercontent.com/securecontrolsframework/securecontrolsframework/d08211314fc7ccfca8e6c84d2b27a2030339ef9c/secure-controls-framework-scf-2026-3.xlsx",
  sha256: "5a89bf2d3c106a9a87d4b6e3d62dd3e147d0e960d4c07473045a10aa8a7df697",
  publisher: "SCF Council (securecontrolsframework.com): free to use; not redistributed by Stolos",
};

/** NIST's OSCAL catalogs, at a pinned commit of usnistgov/oscal-content. */
export const NIST_SOURCES: Record<"nist80053" | "nist800171", PinnedSource> = {
  nist80053: {
    title: "NIST SP 800-53 Rev 5",
    version: "5",
    url: "https://raw.githubusercontent.com/usnistgov/oscal-content/f0de6d8d8c059d374f15e0ae07508d82e370fc1d/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json",
    sha256: "64ca6b4161de51ab6af098a7d101d326f14c95e1abf721396cd8a049e8115eeb",
    publisher: "NIST (public domain)",
  },
  nist800171: {
    title: "NIST SP 800-171 Rev 3",
    version: "3",
    url: "https://raw.githubusercontent.com/usnistgov/oscal-content/f0de6d8d8c059d374f15e0ae07508d82e370fc1d/nist.gov/SP800-171/rev3/json/NIST_SP800-171_rev3_catalog.json",
    sha256: "fd68bad4c1fee98dd1b2511884b585fb1f14265d4c5693d0492a25dd66e73dde",
    publisher: "NIST (public domain)",
  },
};

/** NIST's SP 800-53 Rev 5 moderate baseline (an OSCAL profile), which an SSP imports. */
export const NIST_MODERATE_PROFILE =
  "https://raw.githubusercontent.com/usnistgov/oscal-content/f0de6d8d8c059d374f15e0ae07508d82e370fc1d/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_MODERATE-baseline_profile.json";

/** The OSCAL version the exports are written to (the one NIST's catalogs above are in). */
export const OSCAL_VERSION = "1.2.3";

/**
 * The workbook column(s) each framework is in, by header. HIPAA is the union
 * of the Security Rule (NIST SP 800-66 R2) and the Administrative
 * Simplification (2013) columns: SCF fills each for different controls.
 */
export const SCF_COLUMNS: Record<FrameworkId, RegExp[]> = {
  soc2: [/^AICPA\s+TSC 2017:2022 \(used for SOC 2\)$/],
  hipaa: [
    /^USA\s+Federal\s+HIPAA Security Rule\s+NIST SP 800-66 R2$/,
    /^USA\s+Federal\s+HIPAA Administrative Simplification 2013$/,
  ],
  pci: [/^PCI DSS\s+4\.0\.1$/],
  cmmc: [/^USA\s+Federal\s+CMMC 2\.0\s+Level 2$/],
  nist80053: [/^NIST\s+800-53\s+R5\.2$/],
  nist800171: [/^NIST\s+800-171\s+R3$/],
  fedramp: [/^USA\s+Federal\s+FedRAMP R5\s+\(moderate\)$/],
};

/** The cached catalog's format: a cache in another is read again from the workbook. */
export const CATALOG_FORMAT = 1;

/** One SCF control, as the workbook has it. */
export interface ScfEntry {
  /** Its domain. */
  domain: string;
  /** Its name. */
  name: string;
  /** Its description. */
  description: string;
  /** Requirement ids it maps to, per framework (SCF's STRM). */
  maps: Record<FrameworkId, string[]>;
}

/** The catalog: SCF's controls, by id. */
export interface ScfCatalog {
  /** The format of this cache (CATALOG_FORMAT). */
  format: number;
  /** The SCF version. */
  version: string;
  /** Every control, by its SCF id. */
  controls: Record<string, ScfEntry>;
}

/** One worksheet of an XLSX (kernel `unzip` and `readXml`), by its name, as rows of cells keyed by column letter. */
export async function readSheet(
  xlsx: Uint8Array,
  name: string,
): Promise<Array<Record<string, string>>> {
  const files = await unzip(xlsx);
  if (files.kind === "err") throw new Error(`the workbook is not a ZIP (${files.error.kind})`);
  const xml = (p: string): XmlElement | undefined => {
    const b = files.value.get(p);
    if (b === undefined) return undefined;
    const r = readXml(new TextDecoder().decode(b), { keepWhitespace: true });
    if (r.kind === "err") throw new Error(`${p}: ${formatXmlError(r.error)}`);
    return r.value;
  };
  const shared = xml("xl/sharedStrings.xml");
  const strings = shared
    ? children(shared, "si").map((si) =>
        descendants(si, "t")
          .map((t) => textOf(t))
          .join(""),
      )
    : [];
  const wb = xml("xl/workbook.xml");
  const sheetEl = wb
    ? descendants(wb, "sheet").find((x) => attribute(x, "name") === name)
    : undefined;
  const rid = attribute(sheetEl, "id");
  if (!rid) throw new Error(`the workbook has no sheet "${name}"`);
  const rels = xml("xl/_rels/workbook.xml.rels");
  const target = rels
    ? attribute(
        descendants(rels, "Relationship").find((x) => attribute(x, "Id") === rid),
        "Target",
      )
    : undefined;
  if (!target) throw new Error(`the workbook's sheet "${name}" has no file`);
  const sheet = xml(`xl/${target.replace(/^\/?xl\//, "")}`);
  const rows: Array<Record<string, string>> = [];
  for (const row of sheet ? descendants(sheet, "row") : []) {
    const cells: Record<string, string> = {};
    for (const c of children(row, "c")) {
      const col = /^([A-Z]+)\d+$/.exec(attribute(c, "r") ?? "")?.[1];
      if (col === undefined) continue;
      const type = attribute(c, "t");
      const v = child(c, "v");
      if (type === "s" && v !== undefined) cells[col] = strings[Number(textOf(v))] ?? "";
      else if (type === "inlineStr") {
        cells[col] = descendants(c, "t")
          .map((t) => textOf(t))
          .join("");
      } else if (v !== undefined) cells[col] = textOf(v);
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * A requirement id as the framework writes it: without SCF's leading "§"
 * (HIPAA), and with CMMC's practice ids in CMMC's own form (the workbook has
 * "IAL2.-3.5.3" for CMMC's "IA.L2-3.5.3").
 */
export function tidyRequirement(x: string): string {
  return x
    .replace(/^\s*§\s*/, "")
    .trim()
    .replace(/^([A-Z]{2})L(\d)\.-/, "$1.L$2-");
}

/** The SCF catalog from the workbook. */
export async function parseScf(
  xlsx: Uint8Array,
  version = SCF_SOURCE.version,
): Promise<ScfCatalog> {
  const rows = await readSheet(xlsx, `SCF ${version}`);
  const header = rows[0] ?? {};
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const colOf = (re: RegExp) => Object.entries(header).find(([, v]) => re.test(v.trim()))?.[0];
  const idCol = colOf(/^SCF #$/),
    nameCol = colOf(/^SCF Control$/),
    domCol = colOf(/^SCF Domain$/);
  const descCol = colOf(/^Secure Controls Framework \(SCF\)\s+Control Description$/);
  if (!idCol || !nameCol) {
    throw new Error("the workbook's SCF sheet has no SCF # or SCF Control column");
  }
  const cols = Object.entries(SCF_COLUMNS).map(
    ([k, res]) => [k, res.map(colOf).filter((c): c is string => !!c)] as const,
  );
  if (!cols.some(([, c]) => c.length)) {
    throw new Error("the workbook has none of the framework columns");
  }
  const controls: Record<string, ScfEntry> = {};
  for (const r of rows.slice(1)) {
    const id = norm(r[idCol] ?? "");
    if (!/^[A-Z]{3}-\d{2}(\.\d+)?$/.test(id)) continue;
    controls[id] = {
      domain: norm(r[domCol ?? ""] ?? ""),
      name: norm(r[nameCol] ?? ""),
      description: norm(r[descCol ?? ""] ?? ""),
      maps: Object.fromEntries(
        cols.map(([k, cs]) => [
          k,
          [
            ...new Set(
              cs
                .flatMap((c) => (r[c] ?? "").split(/\r?\n/))
                .map((x) => tidyRequirement(x))
                .filter(Boolean),
            ),
          ],
        ]),
      ) as Record<FrameworkId, string[]>,
    };
  }
  return { format: CATALOG_FORMAT, version, controls };
}

/** Download a pinned source, refusing it unless its SHA-256 matches. */
export async function fetchPinned(
  s: PinnedSource,
  get: (url: string) => Promise<Uint8Array> = async (u: string) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
): Promise<Uint8Array> {
  const b = await get(s.url);
  const got = await sha256(b);
  if (s.sha256 && got !== s.sha256) {
    throw new Error(`${s.title} ${s.version}: SHA-256 ${got}, expected ${s.sha256}: not used`);
  }
  return b;
}

/** Where the catalogs are cached on this PC. */
export function catalogCache(): string {
  return P.catalogs;
}

/** The SCF catalog: from the cache, or downloaded, checked, read, and cached once. */
export async function loadScf(
  o: { cacheDir?: string; download?: boolean; get?: (url: string) => Promise<Uint8Array> } = {},
): Promise<ScfCatalog | undefined> {
  const dir = o.cacheDir ?? catalogCache();
  const file = path.join(dir, `scf-${SCF_SOURCE.version}.json`);
  const cached = json((await fs.readTextOr(file)) ?? "", scfCatalogDecoder);
  if (
    cached.kind === "ok" &&
    cached.value.format === CATALOG_FORMAT &&
    cached.value.version === SCF_SOURCE.version
  ) {
    return cached.value;
  }
  if (!o.download) return undefined;
  const cat = await parseScf(await fetchPinned(SCF_SOURCE, o.get));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeTextFile(file, JSON.stringify(cat));
  return cat;
}

/** A NIST catalog's control titles, by OSCAL control id (ac-2.1, SP_800_171_03.05.03). */
export interface NistCatalog {
  /** The format of this cache (CATALOG_FORMAT). */
  format: number;
  /** Which catalog. */
  id: keyof typeof NIST_SOURCES;
  /** Its pinned URL (an OSCAL export's source). */
  url: string;
  /** Each control's title, by its OSCAL id. */
  titles: Record<string, string>;
}

/** Control titles from an OSCAL catalog (JSON). */
export function parseOscalCatalog(json: unknown, id: keyof typeof NIST_SOURCES): NistCatalog {
  type C = { id: string; title: string; controls?: C[] };
  const cat = (json as { catalog?: { groups?: Array<{ controls?: C[] }>; controls?: C[] } })
    .catalog;
  if (!cat) throw new Error(`${NIST_SOURCES[id].title}: not an OSCAL catalog`);
  const titles: Record<string, string> = {};
  const walk = (cs: C[] = []) => {
    for (const c of cs) {
      titles[c.id] = c.title;
      walk(c.controls);
    }
  };
  for (const g of cat.groups ?? []) walk(g.controls);
  walk(cat.controls);
  return { format: CATALOG_FORMAT, id, url: NIST_SOURCES[id].url, titles };
}

/** A NIST catalog: from the cache, or downloaded, checked, read, and cached once. */
export async function loadNist(
  id: keyof typeof NIST_SOURCES,
  o: { cacheDir?: string; download?: boolean; get?: (url: string) => Promise<Uint8Array> } = {},
): Promise<NistCatalog | undefined> {
  const file = path.join(o.cacheDir ?? catalogCache(), `${id}.json`);
  const cached = json((await fs.readTextOr(file)) ?? "", nistCatalogDecoder);
  if (
    cached.kind === "ok" &&
    cached.value.format === CATALOG_FORMAT &&
    cached.value.url === NIST_SOURCES[id].url
  ) {
    return cached.value;
  }
  if (!o.download) return undefined;
  const b = await fetchPinned(NIST_SOURCES[id], o.get);
  const cat = parseOscalCatalog(JSON.parse(new TextDecoder().decode(b)), id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeTextFile(file, JSON.stringify(cat));
  return cat;
}

const NIST_IDS = ["nist80053", "nist800171"] as const;

const nistCatalogDecoder: Decoder<NistCatalog> = mapDecoder(
  object({ format: number, id: literal(...NIST_IDS), url: string, titles: record(string) }),
  (c): NistCatalog => ({ ...c, titles: { ...c.titles } }),
);

const scfCatalogDecoder: Decoder<ScfCatalog> = mapDecoder(
  object({
    format: number,
    version: string,
    controls: record(
      object({
        domain: string,
        name: string,
        description: string,
        maps: record(array(string)),
      }),
    ),
  }),
  (c): ScfCatalog => ({
    ...c,
    controls: Object.fromEntries(
      Object.entries(c.controls).map(([id, e]) => [
        id,
        {
          ...e,
          maps: Object.fromEntries(
            FRAMEWORKS.map((f) => [f.id, [...(e.maps[f.id] ?? [])]]),
          ) as Record<FrameworkId, string[]>,
        },
      ]),
    ),
  }),
);

/** A SOC 2 mapping without its points of focus (CC6.1, not CC6.1-POF10), for summaries. */
export function criteriaOnly(ids: string[]): string[] {
  return [...new Set(ids.map((i) => i.replace(/-POF\d+$/, "")))];
}
