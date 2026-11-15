// deno-lint-ignore-file -- browser code (page.evaluate runs in Chromium), run by Node
// Spec 066: the Stolos Console in a real browser (Playwright, Chromium): the one-time launch link, every page
// at desktop and phone width (nothing wider than the screen, every field labeled, no script errors), a run
// streamed to the page, a fleet query as a table (and a refused one), the machine filter, the search, and the
// guards (another Host, a used link). Usage: node tests/console/stolos-browser.cjs <port> [screenshot-dir]
const { chromium } = require("playwright");
const http = require("http");
const port = process.argv[2] ?? 8098;
const shots = process.argv[3];
const base = `http://127.0.0.1:${port}`;
const PAGES = [
  "/",
  "/machines",
  "/machines/alice-mbp",
  "/machines/bob-desk",
  "/machines/alpha",
  "/machines/scratch",
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
    })
  );

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
  const browser = await chromium.launch();
  for (
    const [label, viewport] of [["desktop", { width: 1400, height: 900 }], ["phone", {
      width: 390,
      height: 860,
    }]]
  ) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => problems.push(`${label}: script error: ${e.message}`));
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
          .filter((el) =>
            !el.closest("label") && !el.getAttribute("aria-label") &&
            !(el.id && document.querySelector(`label[for="${el.id}"]`))
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
  await page.waitForFunction(
    () => document.querySelector("#runstate")?.textContent === "Done",
    null,
    { timeout: 20000 },
  )
    .catch(() => problems.push("a run never reached Done"));
  check((await page.locator("#output > div").count()) >= 20, "the run's lines did not all arrive");
  check(await page.locator("#output .w").count() >= 1, "a warning line was not colored");
  // A fleet query, as a table; a refused one says why.
  await page.goto(`${base}/query`);
  await page.click("#queryform button[type=submit]");
  await page.waitForSelector("#answer table", { timeout: 15000 }).catch(() =>
    problems.push("no answer table")
  );
  const cells = await page.locator("#answer td").allTextContents();
  check(cells.includes("alice-mbp") && cells.includes("15.1"), `the answer: ${cells.join("|")}`);
  check(
    (await page.locator("#answer .notice").count()) === 1,
    "the machine that did not answer is not named",
  );
  await page.fill("input[name=sql]", "select * from shadow");
  await page.click("#queryform button[type=submit]");
  await page.waitForFunction(
    () => document.querySelector("#runstate")?.textContent?.startsWith("Refused"),
    null,
    { timeout: 15000 },
  )
    .catch(() => problems.push("a refused query did not say so"));
  check(
    (await page.textContent("#answer")).includes("never served"),
    "the refusal's reason is not shown",
  );
  // The machine filter.
  await page.goto(`${base}/machines`);
  await page.fill("input[type=search]", "macos");
  await page.waitForTimeout(300);
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll("tbody tr")].filter((r) => r.offsetParent !== null).length
  );
  check(shown === 1, `the filter shows ${shown} machines for "macos"`);
  // The search finds a command in another group.
  await page.goto(`${base}/actions/vault`);
  await page.fill(".cmdlist input[type=search]", "cloud connect");
  await page.waitForTimeout(300);
  const found = await page.evaluate(() =>
    [...document.querySelectorAll(".cmdlist a")].filter((a) => a.offsetParent !== null).map((a) =>
      a.querySelector(".mono").textContent
    )
  );
  check(found.includes("cloud connect"), `search found ${JSON.stringify(found)}`);
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
    `stolos-console-browser: every check passed (${PAGES.length} pages, desktop and phone)`,
  );
})();
