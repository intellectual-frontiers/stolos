// deno-lint-ignore-file -- browser code (page.evaluate runs in Chromium), run by Node
// Spec 065: the Archon Console in a real browser (Playwright, Chromium): sign in, every page at desktop and
// phone width (nothing wider than the screen, every field labeled, no script errors), a run streamed to the
// page, the live log, the search, and a person who may only look. Usage: node tests/console/browser.cjs <port>
const { chromium } = require("playwright");
const base = `http://127.0.0.1:${process.argv[2] ?? 8099}`;
const PAGES = [
  "/",
  "/services",
  "/apps",
  "/data",
  "/logs",
  "/activity",
  "/how",
  "/guide",
  "/actions/server",
  "/actions/postgres",
  "/actions/storage",
  "/actions/web",
  "/actions/mail",
  "/actions/shell",
];
const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
};

async function signIn(page, user, pw) {
  await page.goto(`${base}/signin`);
  await page.fill("input[name=user]", user);
  await page.fill("input[name=password]", pw);
  await page.click("button[type=submit]");
  await page.waitForURL(`${base}/`);
}

(async () => {
  const browser = await chromium.launch();
  for (
    const [label, viewport] of [["desktop", { width: 1400, height: 900 }], ["phone", {
      width: 400,
      height: 860,
    }]]
  ) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => problems.push(`${label}: script error: ${e.message}`));
    await signIn(page, "alice", "right-password");
    for (const p of PAGES) {
      await page.goto(base + p);
      const r = await page.evaluate(() => ({
        wide: document.documentElement.scrollWidth - window.innerWidth,
        unlabeled: [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
          .filter((el) =>
            !el.closest("label") && !el.getAttribute("aria-label") &&
            !(el.id && document.querySelector(`label[for="${el.id}"]`))
          )
          .map((el) => el.name || el.type),
      }));
      check(r.wide <= 1, `${label} ${p}: ${r.wide}px wider than the screen`);
      check(
        r.unlabeled.length === 0,
        `${label} ${p}: fields without a label: ${r.unlabeled.join(", ")}`,
      );
    }
    await page.close();
  }
  // A run, live.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await signIn(page, "alice", "right-password");
  await page.goto(`${base}/actions/server?cmd=verify`);
  await page.click("#cmdform button[type=submit]");
  await page.waitForFunction(
    () => document.querySelector("#runstate")?.textContent === "Done",
    null,
    { timeout: 20000 },
  )
    .catch(() => problems.push("a run never reached Done"));
  check((await page.locator("#output > div").count()) >= 30, "the run's lines did not all arrive");
  // The live log.
  await page.goto(`${base}/logs?unit=traefik.service`);
  await page.waitForFunction(() => document.querySelectorAll("#logs > div").length >= 20, null, {
    timeout: 15000,
  })
    .catch(() => problems.push("the log did not stream"));
  // The search finds a command in another group.
  await page.goto(`${base}/actions/shell`);
  await page.fill("input[type=search]", "pg publish");
  await page.waitForTimeout(300);
  const found = await page.evaluate(() =>
    [...document.querySelectorAll(".cmdlist a")].filter((a) => a.offsetParent !== null).map((a) =>
      a.querySelector(".mono").textContent
    )
  );
  check(found.includes("pg publish"), `search found ${JSON.stringify(found)}`);
  // Someone who may only look.
  const viewer = await browser.newPage();
  await signIn(viewer, "bob", "bob-password");
  await viewer.goto(`${base}/actions/server?cmd=reboot`);
  check(
    (await viewer.locator("#cmdform button[type=submit]").count()) === 0,
    "a viewer sees a Run button for reboot",
  );
  await browser.close();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`console-browser: every check passed (${PAGES.length} pages, desktop and phone)`);
})();
