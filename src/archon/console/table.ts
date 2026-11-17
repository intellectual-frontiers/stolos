/**
 * Spec 107-pairing-and-query FR-012, FR-013: the console's one table, a thin wrapper around AG Grid Community (MIT), written so that
 * commons can take it later: nothing here knows what a machine is. AG Grid is vendored, pinned by its SHA-256 and served by the
 * console itself (`assets.ts`, `AG_GRID`): the page never loads a script from another site. The grid gives paging, sorting, column
 * filters, a quick filter, resizing, pinning (the column menu), keyboard access, and CSV export.
 *
 * The table is fed by the page's own server-sent events: the server patches `<i hidden class="tbl-item" payload="...">` markers into
 * the table's `.tbl-feed` element (Datastar's `datastar-patch-elements`), and the page's script turns each into a change of the
 * grid. A change is `{ op: "reset" }` (clear the rows and the columns), or `{ op: "add", rows, remove }` (rows to add, each with a
 * unique `__id`, and the `__id`s of rows to drop). The columns follow the rows: `first` columns come first (the first pinned left),
 * then the others in the order they appear, then `last` ones.
 *
 * ```mermaid
 * flowchart LR
 *   s["server: one answer arrives"] -->|"datastar-patch-elements<br/>(append a .tbl-item)"| f[".tbl-feed"]
 *   f -->|"MutationObserver"| g["AG Grid: applyTransaction"]
 *   g --> u["paging, sorting, filters,<br/>resize, pin, keys, CSV"]
 * ```
 *
 * @example
 * ```ts
 * import { tableItem, tableMarkup } from "./table.ts";
 * const page = tableMarkup({ id: "answers", label: "Answers", csvName: "answers" });
 * const event = tableItem({ op: "add", rows: [{ __id: "alpha", machine: "alpha" }], remove: [] });
 * page.s.includes("tbl-grid"); // true
 * event.s.includes("payload="); // true
 * ```
 *
 * @module
 */
// Spec: 107-pairing-and-query FR-012, FR-013

import { AG_GRID } from "./assets.ts";
import { esc, html, type Html, raw } from "./html.ts";

/** What a table is told when it is made. */
export interface TableOptions {
  /** The table's id (a lowercase word): the page's elements are `<id>-feed` and the like. */
  id: string;
  /** What the grid is called to a screen reader. */
  label: string;
  /** The CSV's file name, without `.csv`. */
  csvName: string;
  /** Rows to a page (25 by default). */
  pageSize?: number;
  /** Columns that come first, in order; the first is pinned to the left. */
  first?: readonly string[];
  /** Columns that come last, in order. */
  last?: readonly string[];
  /** What the grid says before any row (default: "No rows yet"). */
  empty?: string;
}

/** One change to a table's rows. */
export type TableChange =
  | { op: "reset" }
  | {
      op: "add";
      rows: ReadonlyArray<Record<string, unknown> & { __id: string }>;
      remove: readonly string[];
    };

/** The script tag that loads AG Grid from this console (put it in the page once, before the table). */
export function tableScript(): Html {
  return raw(`<script src="${esc(AG_GRID.url)}"></script>`);
}

/** The marker an event appends to a table's feed: the change as JSON in an attribute (escaped), nothing to draw. */
export function tableItem(change: TableChange): Html {
  return raw(`<i hidden class="tbl-item" payload="${esc(JSON.stringify(change))}"></i>`);
}

/** The markup of a table: its toolbar (quick filter, CSV), the grid, the feed events append to, and the script that joins them. */
export function tableMarkup(o: TableOptions): Html {
  const config = JSON.stringify({
    pageSize: o.pageSize ?? 25,
    first: o.first ?? ["machine", "answer"],
    last: o.last ?? ["reason"],
    csvName: o.csvName,
    empty: o.empty ?? "No rows yet",
  });
  return html`
    <div class="tbl" id="${o.id}" data-tbl="${config}">
      <div class="row tbl-bar">
        <label class="field tbl-search"
          ><span>Filter every column</span
          ><input type="search" class="tbl-quick" placeholder="Type to filter" autocomplete="off"
        /></label>
        <button class="btn ghost tbl-csv" type="button">Download CSV</button>
      </div>
      <div class="tbl-grid" role="region" aria-label="${o.label}"></div>
      <div class="tbl-feed" id="${o.id}-feed" hidden></div>
    </div>
    ${raw(`<script>${TABLE_JS}</script>`)}
  `;
}

/**
 * The page's script for every `.tbl`: it makes the grid when AG Grid is there (the page says so plainly when it is not), watches the
 * feed, and follows the console's light and dark colors through its CSS variables.
 */
const TABLE_JS = `
(() => {
  const roots = [...document.querySelectorAll(".tbl:not([data-ready])")];
  for (const root of roots) {
    root.dataset.ready = "1";
    const cfg = JSON.parse(root.dataset.tbl || "{}");
    const gridDiv = root.querySelector(".tbl-grid");
    const feed = root.querySelector(".tbl-feed");
    if (!window.agGrid) {
      gridDiv.textContent = "The table's script is not available on this server yet.";
      continue;
    }
    const known = new Set();
    const rowsById = new Map();
    const columnDefs = () => {
      const keys = [...known];
      const order = [
        ...cfg.first.filter((k) => known.has(k)),
        ...keys.filter((k) => !cfg.first.includes(k) && !cfg.last.includes(k)),
        ...cfg.last.filter((k) => known.has(k)),
      ];
      return order.map((k, i) => ({
        field: k,
        headerName: k,
        pinned: i === 0 && k === cfg.first[0] ? "left" : undefined,
        minWidth: k === "reason" ? 200 : 110,
        flex: k === "reason" ? 2 : 1,
        cellClass: k === "answer" ? (p) => "ans ans-" + p.value : undefined,
      }));
    };
    const theme = agGrid.themeQuartz.withParams({
      fontFamily: "var(--sans)",
      fontSize: 13,
      backgroundColor: "var(--panel)",
      foregroundColor: "var(--ink)",
      borderColor: "var(--line)",
      headerBackgroundColor: "var(--rail)",
      headerTextColor: "var(--muted)",
      oddRowBackgroundColor: "var(--panel)",
      chromeBackgroundColor: "var(--panel)",
      accentColor: "var(--accent)",
      inputBorder: { color: "var(--line)" },
    });
    const api = agGrid.createGrid(gridDiv, {
      columnDefs: [],
      rowData: [],
      theme,
      getRowId: (p) => p.data.__id,
      defaultColDef: { sortable: true, filter: true, resizable: true, minWidth: 90 },
      pagination: true,
      paginationPageSize: cfg.pageSize,
      paginationPageSizeSelector: [10, 25, 50, 100],
      domLayout: "autoHeight",
      animateRows: false,
      overlayNoRowsTemplate: cfg.empty,
      enableCellTextSelection: true,
      suppressDragLeaveHidesColumns: true,
    });
    root.tblApi = api;
    const apply = (c) => {
      if (c.op === "reset") {
        known.clear();
        rowsById.clear();
        api.setGridOption("columnDefs", []);
        api.setGridOption("rowData", []);
        return;
      }
      const before = known.size;
      for (const r of c.rows) for (const k of Object.keys(r)) if (k !== "__id") known.add(k);
      if (known.size !== before) api.setGridOption("columnDefs", columnDefs());
      api.applyTransaction({
        remove: c.remove.map((id) => rowsById.get(id)).filter(Boolean),
        add: c.rows,
      });
      for (const id of c.remove) rowsById.delete(id);
      for (const r of c.rows) rowsById.set(r.__id, r);
    };
    const take = (node) => {
      if (!(node instanceof Element)) return;
      const items = node.matches(".tbl-item") ? [node] : [...node.querySelectorAll(".tbl-item")];
      for (const n of items) {
        try { apply(JSON.parse(n.getAttribute("payload") || "{}")); } catch {}
        n.remove();
      }
    };
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(take))).observe(feed, { childList: true, subtree: true });
    take(feed);
    root.querySelector(".tbl-quick").addEventListener("input", (e) => api.setGridOption("quickFilterText", e.target.value));
    root.querySelector(".tbl-csv").addEventListener("click", () => api.exportDataAsCsv({ fileName: cfg.csvName + ".csv" }));
  }
})();
`;
