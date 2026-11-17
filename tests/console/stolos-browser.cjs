/**
 * Specs 066 and 107-pairing-and-query: the Stolos Console in a real browser (Playwright, Chromium): the one-time launch
 * link, every page at desktop and phone width (nothing wider than the screen, every field labeled, no script errors),
 * a run streamed to the page, the machines page (This PC first with the controller's badge, the How it joined column
 * and filter, the controller's disabled actions), "Ask every machine" as an AG Grid that fills in as machines answer
 * (rows appear, a failing machine's row has its reason, sorting, paging, a filter, CSV, the keyboard) at desktop and
 * phone width, a refused query, the search, and the guards (another Host, a used link).
 * Usage: node tests/console/stolos-browser.cjs <port> [screenshot-dir]
 * (CHROME_PATH names a Chrome or Chromium to use instead of Playwright's own.)
 *
 * @module
 */

const { chromium } = require("playwright");
const http = require("http");
const port = process.argv[2] ?? 8098;
const shots = process.argv[3];
const base = `http://127.0.0.1:${port}`;
const PAGES = [
  "/",
  "/machines",
  "/machines/alice-mbp",
  "/machines/lab-pc",
  "/machines/bob-desk",
  "/machines/alpha",
  "/machines/scratch",
  "/machines/front-printer",
  "/machines/front-desk",
  "/add",
  "/add?what=adopt&name=alice-laptop&osquery=on",
  "/add?what=discover&name=front-desk",
  "/add?what=device&name=lobby-camera",
  "/add?what=cloud",
  "/clouds",
  "/boot",
  "/query",
  "/changes",
  "/trust",
  "/compliance",
  "/compliance?fw=hipaa",
  "/compliance?fw=soc2",
  "/activity",
  "/how",
  "/guide",
  "/guide/daily-use",
  "/actions/fleet",
  "/actions/machines",
  "/actions/adopted",
  "/actions/clouds",
  "/actions/trust",
  "/actions/vault",
];
const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
};
const get = (path, headers = {}) =>
  new Promise((ok) =>
    http.get({ host: "127.0.0.1", port, path, headers }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => ok({ status: r.statusCode, body: b }));
    }),
  );

/**
 * Spec 107: "Ask every machine" as an AG Grid that fills in as the machines answer, at one viewport: rows appear while
 * others are still asking, a failing machine's row has its reason, "N of M answered", sorting, a filter, resizing,
 * pinning, paging, the keyboard, CSV, and nothing wider than the screen.
 */
async function gridChecks(page, label) {
  const at = (what) => `${label} grid: ${what}`;
  const col = (id) => page.locator(`.tbl .ag-row [col-id="${id}"]`);
  // The machines in the table, in the order shown (rows are placed by their row-index, not in the document's order).
  const machines = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".tbl .ag-row")]
        .map((r) => [
          Number(r.getAttribute("row-index")),
          r.querySelector('[col-id="machine"]')?.textContent.trim(),
        ])
        .filter(([, m]) => m)
        .sort((a, b) => a[0] - b[0])
        .map(([, m]) => m),
    );
  // The rows' data (a narrow screen draws only the columns it has room for).
  const data = () =>
    page.evaluate(() => {
      const out = [];
      document.querySelector(".tbl").tblApi.forEachNode((n) => out.push(n.data));
      return out;
    });
  await page.goto(`${base}/query`);
  await page
    .waitForSelector(".tbl .ag-root", { timeout: 10000 })
    .catch(() => problems.push(at("no grid (AG Grid did not start)")));
  check(
    (await page.evaluate(() => typeof window.agGrid)) === "object",
    at("AG Grid is not loaded"),
  );
  await page.click("#queryform button[type=submit]");
  // Rows appear as machines answer: some are answered while another is still being asked.
  await page
    .waitForFunction(
      () => {
        const t = [...document.querySelectorAll('.tbl .ag-row [col-id="answer"]')].map((c) =>
          c.textContent.trim(),
        );
        return t.includes("asking") && t.includes("answered");
      },
      null,
      { timeout: 8000 },
    )
    .catch(() => problems.push(at("the table did not fill in while machines were still asking")));
  await page
    .waitForFunction(
      () => document.querySelector("#runstate")?.textContent?.startsWith("Answered"),
      null,
      { timeout: 15000 },
    )
    .catch(() => problems.push(at("the query never finished")));
  check(
    (await page.textContent("#summary")).includes("3 of 5 answered"),
    at(`the line says: ${await page.textContent("#summary")}`),
  );
  const rows = await data();
  const by = Object.fromEntries(rows.map((r) => [r.machine, r]));
  check(rows.length === 5, at(`${rows.length} rows, not one per machine`));
  check(
    by["alice-mbp"]?.answer === "answered" && by["alice-mbp"]?.version === "15.1",
    at("alice-mbp's answer is not in its row"),
  );
  check(
    by["bob-desk"]?.answer === "failed" &&
      by["bob-desk"]?.reason === "osquery is not installed here",
    at("the failing machine has no reason in its row"),
  );
  check(
    by["front-pc"]?.answer === "timed-out" &&
      /^no answer in \d+ s$/.test(by["front-pc"]?.reason ?? ""),
    at("the machine that timed out has no row with its reason"),
  );
  // Sorting: by machine, ascending and then descending.
  await page.locator('.tbl .ag-header-cell[col-id="machine"] .ag-header-cell-label').click();
  const asc = await machines();
  check(
    JSON.stringify(asc) === JSON.stringify([...asc].sort()),
    at(`not sorted: ${asc.join(",")}`),
  );
  await page.locator('.tbl .ag-header-cell[col-id="machine"] .ag-header-cell-label').click();
  const desc = await machines();
  check(
    JSON.stringify(desc) === JSON.stringify([...asc].reverse()),
    at(`not sorted descending: ${desc.join(",")}`),
  );
  // A filter narrows the table.
  await page.fill(".tbl-quick", "bob");
  await page.waitForTimeout(300);
  check(
    (await machines()).join() === "bob-desk",
    at(`the filter shows ${(await machines()).join(",")}`),
  );
  await page.fill(".tbl-quick", "");
  await page.waitForTimeout(200);
  // A column can be resized, the first is pinned to the left, and another can be pinned.
  const width = () =>
    page.evaluate(
      () =>
        document.querySelector('.tbl .ag-header-cell[col-id="reason"]')?.getBoundingClientRect()
          .width ?? 0,
    );
  const w0 = await width();
  const h = w0
    ? await page
        .locator('.tbl .ag-header-cell[col-id="reason"] .ag-header-cell-resize')
        .boundingBox()
    : null;
  if (h && h.x + h.width < (await page.evaluate(() => window.innerWidth))) {
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 - 40, h.y + h.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    check(Math.abs((await width()) - w0) > 10, at("a column cannot be resized"));
  } else {
    // On a phone the last column is off to the side: resize the first one that is in view.
    const first = await page
      .locator('.tbl .ag-header-cell[col-id="answer"] .ag-header-cell-resize')
      .boundingBox();
    const aw = () =>
      page.evaluate(
        () =>
          document.querySelector('.tbl .ag-header-cell[col-id="answer"]').getBoundingClientRect()
            .width,
      );
    const a0 = await aw();
    if (first) {
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(first.x + first.width / 2 + 30, first.y + first.height / 2, {
        steps: 4,
      });
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    check(Math.abs((await aw()) - a0) > 10, at("a column cannot be resized"));
  }
  const pinned = () =>
    page.evaluate(() =>
      document
        .querySelector(".tbl")
        .tblApi.getColumnState()
        .filter((c) => c.pinned === "left")
        .map((c) => c.colId),
    );
  check((await pinned()).join() === "machine", at(`pinned: ${(await pinned()).join()}`));
  await page.evaluate(() =>
    document
      .querySelector(".tbl")
      .tblApi.applyColumnState({ state: [{ colId: "answer", pinned: "left" }] }),
  );
  // (AG Grid unpins a column that would take more than half of a narrow grid: on a phone only one stays pinned.)
  const wide = (await page.evaluate(() => window.innerWidth)) >= 700;
  check(
    wide ? (await pinned()).join() === "machine,answer" : (await pinned()).length === 1,
    at(`pinning: ${(await pinned()).join()}`),
  );
  await page.evaluate(() =>
    document
      .querySelector(".tbl")
      .tblApi.applyColumnState({ state: [{ colId: "answer", pinned: null }] }),
  );
  // The keyboard: a cell is focused, and the arrow keys move between rows.
  await page.locator('.tbl .ag-row[row-index="0"] [col-id="machine"]').first().click();
  await page.keyboard.press("ArrowDown");
  const focused = await page.evaluate(() =>
    document.activeElement?.closest(".ag-row")?.getAttribute("row-index"),
  );
  check(focused === "1", at(`the arrow key did not move to the next row (${focused})`));
  // CSV export.
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click(".tbl-csv"),
  ]).catch(() => []);
  if (dl) {
    const csv = require("fs").readFileSync(await dl.path(), "utf8");
    check(
      dl.suggestedFilename() === "fleet-query.csv",
      at(`the file is ${dl.suggestedFilename()}`),
    );
    check(
      csv.includes("machine") &&
        csv.includes("alice-mbp") &&
        csv.includes("osquery is not installed here"),
      at(`the CSV: ${csv.slice(0, 120)}`),
    );
  } else problems.push(at("no CSV download"));
  // Every field of the grid is labeled, and nothing is wider than the screen.
  const unlabeled = await page.evaluate(() =>
    [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
      .filter((el) => el.offsetParent !== null)
      .filter(
        (el) =>
          !el.closest("label") &&
          !el.getAttribute("aria-label") &&
          !el.getAttribute("aria-labelledby") &&
          !(el.id && document.querySelector(`label[for="${el.id}"]`)),
      )
      .map((el) => `${el.className || el.type}`),
  );
  check(unlabeled.length === 0, at(`fields without a label: ${unlabeled.join(", ")}`));
  check(
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1,
    at("wider than the screen"),
  );
  // Paging: 64 rows are more than a page; the next page is the next rows.
  await page.fill("input[name=sql]", "select port, address from listening_ports");
  await page.click("#queryform button[type=submit]");
  await page
    .waitForFunction(
      () => document.querySelector("#runstate")?.textContent?.startsWith("Answered"),
      null,
      { timeout: 15000 },
    )
    .catch(() => problems.push(at("the second query never finished")));
  await page
    .waitForFunction(
      () =>
        /of\s*64/.test(
          document.querySelector(".tbl .ag-paging-row-summary-panel")?.textContent ?? "",
        ),
      null,
      { timeout: 10000 },
    )
    .catch(() => problems.push(at("the second query's rows did not all arrive")));
  const summary = () => page.locator(".tbl .ag-paging-row-summary-panel").textContent();
  check(/1\D+25\D+64/.test(await summary()), at(`the first page says: ${await summary()}`));
  await page.locator('.tbl [aria-label="Next Page"]').click();
  check(/26\D+50\D+64/.test(await summary()), at(`the second page says: ${await summary()}`));
  check((await col("machine").count()) === 25, at("a page is not 25 rows"));
  check(
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1,
    at("wider than the screen after paging"),
  );
}

async function launch(page) {
  const t = (await get("/__test/launch")).body;
  await page.goto(`${base}/launch?t=${t}`);
  await page.waitForURL(`${base}/`);
  return t;
}

(async () => {
  // Guards, without a browser.
  check(
    (await get("/", { host: `evil.example:${port}` })).status === 421,
    "another Host was answered",
  );
  check((await get("/")).status === 401, "a page without a session was served");
  const browser = await chromium.launch(
    process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] }
      : {},
  );
  for (const [label, viewport] of [
    ["desktop", { width: 1400, height: 900 }],
    [
      "phone",
      {
        width: 390,
        height: 860,
      },
    ],
  ]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => problems.push(`${label}: script error: ${e.message}`));
    // Nothing is loaded from another site (spec 107: AG Grid and everything else is this console's own).
    page.on("request", (r) => {
      if (!/^(?:data|blob|about):/.test(r.url()) && !r.url().startsWith(base))
        problems.push(`${label}: requested ${r.url()}`);
    });
    const used = await launch(page);
    const again = await browser.newPage();
    await again.goto(`${base}/launch?t=${used}`);
    check(
      (await again.textContent("h1")).includes("Start the console"),
      `${label}: a used launch link worked again`,
    );
    await again.close();
    for (const p of PAGES) {
      const r0 = await page.goto(base + p);
      check(r0.status() === 200, `${label} ${p}: HTTP ${r0.status()}`);
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({
        wide: document.documentElement.scrollWidth - window.innerWidth,
        h1: document.querySelector("h1")?.textContent ?? "",
        unlabeled: [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
          .filter(
            (el) =>
              !el.closest("label") &&
              !el.getAttribute("aria-label") &&
              !(el.id && document.querySelector(`label[for="${el.id}"]`)),
          )
          .map((el) => el.name || el.type),
      }));
      check(r.wide <= 1, `${label} ${p}: ${r.wide}px wider than the screen`);
      check(r.h1.trim().length > 0, `${label} ${p}: no heading`);
      check(
        r.unlabeled.length === 0,
        `${label} ${p}: fields without a label: ${r.unlabeled.join(", ")}`,
      );
      if (shots && (label === "desktop" || ["/", "/machines", "/actions/adopted"].includes(p))) {
        await page.screenshot({
          path: `${shots}/${label}${p.replace(/\//g, "_") || "_"}.png`,
          fullPage: true,
        });
      }
    }
    await gridChecks(page, label);
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => problems.push(`script error: ${e.message}`));
  await launch(page);
  // A run, live, with the prefilled value from the address.
  await page.goto(`${base}/actions/adopted?cmd=host%20check&name=bob-desk`);
  check(
    (await page.inputValue("input[name=name]")) === "bob-desk",
    "the address did not fill the form",
  );
  await page.click("#cmdform button[type=submit]");
  await page
    .waitForFunction(() => document.querySelector("#runstate")?.textContent === "Done", null, {
      timeout: 20000,
    })
    .catch(() => problems.push("a run never reached Done"));
  check((await page.locator("#output > div").count()) >= 20, "the run's lines did not all arrive");
  check((await page.locator("#output .w").count()) >= 1, "a warning line was not colored");
  // The wizard: choose, get the line, paste a code, and it runs host adopt with it.
  await page.goto(`${base}/add`);
  await page.fill("input[name=name]", "alice-laptop");
  await page.click("form.card button[type=submit]");
  await page.waitForURL(/what=adopt/);
  check(
    (await page.textContent("pre.term")).includes("integrate.sh | sh -s -- --adopt"),
    "the wizard did not show the line",
  );
  await page.fill("textarea[name=check-in]", "stolos1:AAAA\nBBBB");
  await page.click("#cmdform button[type=submit]");
  await page
    .waitForFunction(() => document.querySelector("#runstate")?.textContent === "Done", null, {
      timeout: 20000,
    })
    .catch(() => problems.push("the pasted code did not run"));
  check(
    (await page.textContent("#output")).includes(
      "host adopt alice-laptop --check-in stolos1:AAAABBBB",
    ),
    `the run: ${(await page.textContent("#output")).slice(0, 200)}`,
  );
  // A refused fleet query says why, and asks nobody.
  await page.goto(`${base}/query`);
  await page.fill("input[name=sql]", "select * from shadow");
  await page.click("#queryform button[type=submit]");
  await page
    .waitForFunction(
      () => document.querySelector("#runstate")?.textContent?.startsWith("Refused"),
      null,
      { timeout: 15000 },
    )
    .catch(() => problems.push("a refused query did not say so"));
  check(
    (await page.textContent("#answer")).includes("never served"),
    "the refusal's reason is not shown",
  );
  check((await page.locator(".ag-row").count()) === 0, "a refused query put rows in the table");
  // The machine filter, and how each machine joined (spec 107): this PC first, with the controller's badge.
  await page.goto(`${base}/machines`);
  const visibleRows = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll("tbody tr[data-row]")].filter((r) => r.offsetParent !== null)
          .length,
    );
  check(
    (await visibleRows()) === (await page.locator("tbody tr[data-row]").count()),
    "a row was hidden before filtering",
  );
  const names = await page.locator("tbody tr[data-row] td:first-child a").allTextContents();
  check(names[0] === "lab-pc", `this PC is not first: ${names.join(",")}`);
  check(
    (await page.locator("#this-pc").textContent()).includes("Auto-adopted, controller"),
    "the controller has no badge in the This PC group",
  );
  check(
    (await page.locator("#this-pc th").first().textContent()).trim() === "This PC",
    "no This PC group",
  );
  check(
    (await page.locator("thead th", { hasText: "How it joined" }).count()) === 1,
    "no How it joined column",
  );
  await page.fill("input[type=search]", "macos");
  await page.waitForTimeout(300);
  check(
    (await visibleRows()) === 1,
    `the filter shows ${await visibleRows()} machines for "macos"`,
  );
  await page.fill("input[type=search]", "");
  for (const [way, expect] of [
    ["paired", ["alice-mbp"]],
    ["auto-adopted", ["lab-pc"]],
    ["managed", ["alpha", "beta", "wsl-alice"]],
    ["integrated", ["bob-desk", "front-printer"]],
    ["cloud", ["scratch"]],
  ]) {
    await page.selectOption("select", way);
    await page.waitForTimeout(250);
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll("tbody tr[data-row]")]
        .filter((r) => r.offsetParent !== null)
        .map((r) => r.querySelector("td a").textContent),
    );
    check(
      JSON.stringify(shown.sort()) === JSON.stringify([...expect].sort()),
      `filter ${way}: ${shown.join(",")}`,
    );
  }
  await page.selectOption("select", "");
  // The controller's page: no pairing, observed by the local probe, Release and Remove disabled with the reason.
  await page.goto(`${base}/machines/lab-pc`);
  const lab = await page.textContent("main");
  check(
    lab.includes("needs no pairing") && lab.includes("observed by the local probe"),
    "the controller's page does not say it needs no pairing",
  );
  check(
    (await page.locator("button[disabled]", { hasText: "Release" }).count()) === 1,
    "Release is not disabled for the controller",
  );
  check(
    (await page.locator("button[disabled]", { hasText: "Remove" }).count()) === 1,
    "Remove is not disabled for the controller",
  );
  check(
    ((await page.locator("button[disabled]").first().getAttribute("title")) ?? "").includes(
      "not released or removed here",
    ),
    "the disabled action does not say why",
  );
  // The search finds a command in another group.
  await page.goto(`${base}/actions/vault`);
  await page.fill(".cmdlist input[type=search]", "connect");
  await page.waitForTimeout(300);
  const found = await page.evaluate(() =>
    [...document.querySelectorAll(".cmdlist a")]
      .filter((a) => a.offsetParent !== null)
      .map((a) => a.querySelector(".mono").textContent),
  );
  check(found.includes("connect"), `search found ${JSON.stringify(found)}`);
  // Keys that change are not offered here.
  await page.goto(`${base}/actions/trust?cmd=keys%20rotate`);
  check(
    (await page.inputValue("#cmdform input[name=command]")) !== "keys rotate",
    "keys rotate is offered in the console",
  );
  await browser.close();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(
    `stolos-console-browser: every check passed (${PAGES.length} pages and the grid, desktop and phone)`,
  );
})();
