// One-time interactive setup: you log in like a human, the bot memorizes the
// route. Run `npm run login`, then in the browser window that opens:
//   1. Log in to newseabury.com with your member credentials
//   2. Click through to Tee Times (ForeTees) and open the tee sheet
//   3. Use the sheet's calendar to open ANY FUTURE DATE
//   4. Come back to this terminal and press Enter
// We save the tee-sheet URL (and, if the date appears in the URL, a template
// so the bot can jump straight to any date) plus your session cookies.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import readline from "node:readline/promises";
import { loadConfig, AUTH_DIR, STATE_PATH, SHEET_URL_PATH } from "./config.js";
import { templatizeUrl } from "./foretees.js";

const cfg = loadConfig();

const browser = await chromium.launch({
  headless: false,
  executablePath: process.env.CHROMIUM_PATH || cfg.browser?.executablePath || undefined,
});
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(cfg.club.portalLoginUrl);

console.log("\nBrowser opened. Log in, open the ForeTees tee sheet, navigate to a FUTURE date,");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("then press Enter here to capture the session... ");
rl.close();

// Prefer whichever open page is on ForeTees; fall back to the last page.
const pages = context.pages();
const sheetPage =
  pages.findLast((p) => /foretees\.com/i.test(p.url())) ?? pages[pages.length - 1];
const url = sheetPage.url();

const template = templatizeUrl(url);
mkdirSync(AUTH_DIR, { recursive: true });
await context.storageState({ path: STATE_PATH });
writeFileSync(SHEET_URL_PATH, JSON.stringify({ url, template }, null, 2));

console.log(`\nCaptured sheet URL: ${url}`);
console.log(
  template
    ? `Date found in URL — bot can jump directly to any date.\nTemplate: ${template}`
    : "No date found in the URL — the bot will use the calendar to pick the day (slightly slower)."
);
console.log(`Session + URL saved under ${AUTH_DIR}/. You're set — see README for scheduling.`);
await browser.close();
