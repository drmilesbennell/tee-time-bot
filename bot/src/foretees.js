// ForeTees adapter. ForeTees skins vary per club, so every hook here is
// best-effort with a config override (config.json "selectors"). Run
// `npm run dry-run` once after setup: it prints exactly which slots the bot
// sees and saves a debug snapshot to shots/ if it sees none.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sleep } from "./clock.js";
import { matchSuggestion, lastNameOf, sameName } from "./prefs.js";

const TIME_RE = /^\s*\d{1,2}:\d{2}\s*(?:AM|PM|A|P)?\s*$/i;

/**
 * Log in to the member portal fresh. Sessions saved days ago are often stale
 * by 6:55am, so the bot always logs in on the morning of the strike.
 */
export async function portalLogin(page, cfg) {
  const { portalLoginUrl } = cfg.club;
  const sel = cfg.selectors ?? {};
  await page.goto(portalLoginUrl, { waitUntil: "domcontentloaded" });

  const userSel = sel.portalUser || "input[type='text']";
  let user = page.locator(userSel).first();
  await user.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

  // The club has moved its login page before (the old /club/scripts .asp URL
  // now redirects to a formless "Not Found" page). If no login field shows
  // up, follow the site's own Member Login link before giving up.
  if (!(await user.isVisible().catch(() => false))) {
    const memberLink = page
      .locator("a[href*='login' i], a:has-text('Member Login'), a:has-text('Sign In')")
      .first();
    if (await memberLink.isVisible().catch(() => false)) {
      await memberLink.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      user = page.locator(userSel).first();
      await user.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    }
  }
  if (!(await user.isVisible().catch(() => false))) {
    throw new Error(
      `Login form not found: no visible ${userSel} at ${page.url()} ` +
      "(club.portalLoginUrl may be stale — find the current member login page " +
      "and update it, or selectors.portalUser, in config.json)"
    );
  }

  const pass = page.locator(sel.portalPass || "input[type='password']").first();
  await user.fill(cfg.credentials.username);
  await pass.fill(cfg.credentials.password);

  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page
      .locator(sel.portalSubmit || "button[type='submit'], input[type='submit']")
      .first()
      .click(),
  ]);

  // Still seeing a password box means the login failed.
  await sleep(1000);
  if (await page.locator("input[type='password']").first().isVisible().catch(() => false)) {
    throw new Error("Portal login appears to have failed — check PORTAL_USERNAME / PORTAL_PASSWORD in .env");
  }
}

/**
 * From the logged-in portal landing page, find the way to the ForeTees tee
 * sheet without any pre-captured URL (needed for headless/CI runs where
 * `npm run login` never happened). Clicks a "Tee Times"-ish link, follows
 * whatever SSO redirect or popup results, and returns the sheet page plus
 * a saved {url, template} in the same shape login.js produces.
 */
export async function discoverSheet(page) {
  const link = page
    .locator("a", { hasText: /tee\s*.?times?|foretees|golf reservations/i })
    .first();
  if (await link.isVisible().catch(() => false)) {
    const popupPromise = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await link.click().catch(() => {});
    await popupPromise;
  } else {
    // Nav items tucked in collapsed/hover menus can't be clicked — go by href.
    const href =
      (await link.getAttribute("href").catch(() => null)) ??
      (await page.locator("a[href*='foretees' i]").first().getAttribute("href").catch(() => null));
    if (href && !/^(javascript:|#)/i.test(href)) {
      await page
        .goto(new URL(href, page.url()).href, { waitUntil: "domcontentloaded" })
        .catch(() => {});
    }
  }
  await sleep(2000); // let SSO redirects settle

  const pages = page.context().pages();
  const sheetPage =
    pages.findLast((p) => /foretees\.com/i.test(p.url())) ?? pages[pages.length - 1];
  await sheetPage.waitForLoadState("domcontentloaded").catch(() => {});
  const url = sheetPage.url();
  return { page: sheetPage, saved: { url, template: templatizeUrl(url) } };
}

/** If a URL embeds the currently-viewed date, swap it for a placeholder. */
export function templatizeUrl(u) {
  const ymd = u.match(/(20\d{2})(0[1-9]|1[0-2])([0-2]\d|3[01])/);
  if (ymd) return u.replace(ymd[0], "{YYYYMMDD}");
  const mdy = u.match(/(0[1-9]|1[0-2])%2F([0-2]\d|3[01])%2F(20\d{2})/i);
  if (mdy) return u.replace(mdy[0], "{MM/DD/YYYY}");
  return null;
}

/**
 * Navigate to the ForeTees tee sheet for `target` ({y,m,d,iso}).
 * `saved` is what login.js captured: { url, template } — if the captured URL
 * contained its date, we swap the target date straight into it; otherwise we
 * open the sheet and click the day on the calendar.
 */
export async function gotoSheet(page, saved, target, cfg) {
  if (saved.template) {
    const url = saved.template
      .replaceAll("{YYYYMMDD}", `${target.y}${pad(target.m)}${pad(target.d)}`)
      .replaceAll("{MM/DD/YYYY}", `${pad(target.m)}%2F${pad(target.d)}%2F${target.y}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return;
  }

  // Northstar tee-time portlet (the club's current sheet): its weekday tabs
  // only reach 7 days out, so pick the date in the jQuery-UI datepicker.
  // Re-picking also re-renders the slots fresh, so when we're already parked
  // on the sheet (every strike pass after the first) skip the full reload.
  let dateInput = page.locator("input.hasDatepicker").first();
  if (!(await dateInput.isVisible().catch(() => false))) {
    await page.goto(saved.url, { waitUntil: "domcontentloaded" });
    dateInput = page.locator("input.hasDatepicker").first();
  }
  if (await dateInput.isVisible().catch(() => false)) {
    await northstarSelectCourses(page, cfg?.want?.courses);
    await northstarPickDate(page, dateInput, target);
    return;
  }

  // Calendar fallback: click the target day number in a calendar widget.
  const day = String(target.d);
  const candidates = page.locator(
    `td a:text-is("${day}"), a:text-is("${day}"), td:text-is("${day}")`
  );
  const n = await candidates.count();
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return;
    }
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Ensure exactly the wanted courses are ticked in the sheet's
 * "Select Course(s)" menu (a PrimeFaces checkbox dropdown). Only checked
 * courses render slot sections. Empty/missing `wanted` leaves the site's
 * own selection alone.
 */
async function northstarSelectCourses(page, wanted) {
  if (!wanted?.length) return;
  const t = { timeout: 2500 };
  const want = wanted.map((c) => String(c).trim().toLowerCase());

  const trigger = page.locator(".ui-selectcheckboxmenu-trigger").first();
  if (!(await trigger.isVisible().catch(() => false))) return; // no course menu
  const panel = page.locator(".ui-selectcheckboxmenu-panel").last();
  if (!(await panel.isVisible().catch(() => false))) {
    await trigger.click(t).catch(() => {});
    await panel.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }

  const items = panel.locator("li.ui-selectcheckboxmenu-item");
  const n = await items.count();
  let changed = false;
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const name = ((await item.locator("label").innerText(t).catch(() => "")) || "").trim().toLowerCase();
    if (!name) continue;
    const checked = /ui-selectcheckboxmenu-checked/.test(
      (await item.getAttribute("class").catch(() => "")) || ""
    );
    if (checked !== want.includes(name)) {
      await item.locator(".ui-chkbox-box").first().click(t).catch(() => {});
      changed = true;
      await sleep(300); // each toggle re-renders the sheet over AJAX
    }
  }

  await panel.locator(".ui-selectcheckboxmenu-close").first().click(t).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  if (changed) {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await sleep(300);
  }
}

async function northstarPickDate(page, dateInput, target) {
  const want = `${pad(target.m)}/${pad(target.d)}/${target.y}`;
  const t = { timeout: 2500 }; // fail in seconds, not 30s-per-step cascades

  // The date input is readonly — the calendar opens from its trigger button.
  const picker = page.locator("#ui-datepicker-div");
  const trigger = page.locator("button.ui-datepicker-trigger").first();
  for (let attempt = 0; attempt < 2 && !(await picker.isVisible().catch(() => false)); attempt++) {
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click(t).catch(() => {});
    } else {
      await dateInput.click(t).catch(() => {});
    }
    await picker.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }
  if (!(await picker.isVisible().catch(() => false))) {
    throw new Error("Tee-sheet datepicker didn't open — can't select the target date.");
  }

  // This picker's header is month/year <select> dropdowns, not a text
  // title — set them directly (their change handlers re-render the days).
  const monthSel = picker.locator("select.ui-datepicker-month");
  if (await monthSel.count()) {
    await monthSel.selectOption(String(target.m - 1), t).catch(() => {}); // 0-based
    const yearSel = picker.locator("select.ui-datepicker-year");
    if (await yearSel.count()) await yearSel.selectOption(String(target.y), t).catch(() => {});
    await sleep(300);
  } else {
    for (let hop = 0; hop < 4; hop++) {
      const title = (await picker.locator(".ui-datepicker-title").innerText(t).catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();
      if (title === `${MONTHS[target.m - 1]} ${target.y}`) break;
      await picker.locator("a.ui-datepicker-next").click(t).catch(() => {});
      await sleep(250);
    }
  }

  // Selectable days are <a>; days outside the club's booking window render
  // as disabled <span>s. Click the day even if it's already selected: that
  // forces a fresh AJAX render, which the strike loop relies on.
  const dayLink = picker.locator(`a.ui-state-default:text-is("${target.d}")`).first();
  if (!(await dayLink.count())) {
    throw new Error(
      `Day ${target.d} isn't selectable in the tee-sheet calendar — ` +
      `the club may not have opened ${want} for booking yet.`
    );
  }
  await dayLink.click(t).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await sleep(400);

  const shown = (await dateInput.inputValue().catch(() => "")).trim();
  if (shown !== want) {
    // Never let a strike read (or book!) the wrong day's sheet.
    throw new Error(`Tee sheet is showing ${shown || "an unknown date"} — couldn't switch it to ${want}.`);
  }
}

/**
 * Read available tee times off the current sheet.
 * Returns [{ time, openSpots, locator }] in sheet order.
 */
export async function readSlots(page, cfg) {
  const sel = cfg.selectors ?? {};

  // Northstar tee-time portlet: slot rows are plain divs (time label + four
  // seat cells), invisible to the generic clickable-time scan below.
  if (!sel.slotTime && (await page.locator("div[id$='slotTeeDIV']").count()) > 0) {
    return readNorthstarSlots(page, cfg);
  }

  let timeEls;
  if (sel.slotTime) {
    timeEls = page.locator(sel.slotTime);
  } else {
    // Any clickable element whose text is a bare time ("8:07 AM").
    timeEls = page.locator("a, button, [onclick], input[type='button']");
  }

  const count = await timeEls.count();
  const slots = [];
  for (let i = 0; i < count; i++) {
    const el = timeEls.nth(i);
    const text = (await el.innerText().catch(() => "")) || (await el.inputValue().catch(() => ""));
    if (!TIME_RE.test(text)) continue;

    // Count open seats in the surrounding row if we can see them; if the
    // sheet doesn't say, report null and let the booking attempt find out.
    let openSpots = null;
    let rowText = await el.locator("xpath=ancestor::tr[1]").first().innerText().catch(() => "");
    if (!rowText) {
      rowText = await el
        .locator("xpath=ancestor::*[contains(@class,'row')][1]")
        .first()
        .innerText()
        .catch(() => "");
    }
    if (rowText) {
      const opens = rowText.match(/\bopen\b/gi);
      if (opens) openSpots = opens.length;
    }

    slots.push({ time: text.trim(), openSpots, locator: el });
  }
  return slots;
}

/**
 * Attempt to book one slot, entering every configured player name into the
 * booking form (the club drops bookings whose names aren't in within 5
 * minutes — we put them in within seconds, in the same transaction).
 *
 * Returns { success, players } where players is a per-name report:
 * "already-listed" | "picked" (chosen from roster autocomplete) |
 * "typed" (no autocomplete seen; text left in the box) | "tbd-fallback".
 */
export async function bookSlot(page, slot, cfg) {
  const T = 8000; // hard cap on any single booking action — never hang 30s

  // Open the slot (Northstar books in-page; older skins may pop a window).
  const popupPromise = page.context().waitForEvent("page", { timeout: 3000 }).catch(() => null);
  try {
    await slot.locator.click({ timeout: T });
  } catch {
    return { success: false, submitted: false, players: [] };
  }
  const popup = await popupPromise;
  const form = popup ?? page;
  await form.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(400);

  // Northstar booking form ("Player Information" / players table).
  const isNorthstar =
    (await form.locator("[id$='playersTable_data']").count().catch(() => 0)) > 0 ||
    (await form.locator("text=/player information/i").count().catch(() => 0)) > 0;
  if (isNorthstar) {
    return bookNorthstarForm(form, cfg, T);
  }

  // ---- Generic/legacy fallback (older ForeTees skins) ----
  const sel = cfg.selectors ?? {};
  const partySize = cfg.want?.partySize ?? 4;
  const players = await fillPlayers(form, cfg);
  const unfilled = partySize - players.filter((p) => p.how !== "failed").length;
  const tbd = form.locator(sel.tbdButton || "text=/^TBD$/i");
  for (let i = 0; i < Math.max(unfilled, 0); i++) {
    const btn = tbd.first();
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click({ timeout: T }).catch(() => {});
    await sleep(120);
  }
  const submit = form
    .locator(sel.bookSubmit || "text=/submit|\\bbook\\b|confirm|reserve/i")
    .first();
  if (!(await submit.isVisible().catch(() => false))) {
    if (popup) await popup.close().catch(() => {});
    return { success: false, submitted: false, players };
  }
  await submit.click({ timeout: T }).catch(() => {});
  await sleep(1200);
  const confirmBtn = form.locator("text=/^(yes|ok|continue|confirm)$/i").first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click({ timeout: T }).catch(() => {});
    await sleep(1200);
  }
  const bodyText = await form.locator("body").innerText().catch(() => "");
  const success = /confirm(ed|ation)|success|has been booked|your tee time/i.test(bodyText);
  if (popup && !success) await popup.close().catch(() => {});
  return { success, submitted: true, players };
}

/**
 * Book on the Northstar "Player Information" form. The logged-in member is
 * auto-added as Player 1; each additional seat is an empty row where you
 * click "+ Member", type a last name, and pick from the roster autocomplete.
 *
 * Returns { success, submitted, players }. `submitted` means Book Now was
 * clicked — if we then can't confirm, the caller must NOT try another slot
 * (that could double-book); it flags for manual verification instead.
 */
async function bookNorthstarForm(form, cfg, T) {
  const partySize = cfg.want?.partySize ?? 4;
  const wanted = (cfg.want?.players ?? []).map(String);
  const report = [];

  // 1. Number of players — a radio-button group; the digit lives in a
  //    span.ui-button-text (distinct from the hidden datepicker's day cells).
  //    Verify the radio actually took, and retry, before touching anything.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await isPartySize(form, partySize)) break;
    const sizeBtn = form
      .locator("span.ui-button-text", { hasText: new RegExp(`^\\s*${partySize}\\s*$`) })
      .first();
    if (!(await sizeBtn.count().catch(() => 0))) break;
    await sizeBtn.click({ timeout: T }).catch(() => {});
    await sleep(800); // players table rebuilds over AJAX
  }

  // 2. The club auto-adds the logged-in member as Player 1 — but a beat after
  //    the table renders. Wait for a filled row so we don't mistake the gap
  //    for "empty" and try to re-add that member (which collides and resets
  //    the form to a single player). The header also names them ("Welcome
  //    Mark Thompson!") — treat that person as already in the reservation.
  const me = await loggedInMemberName(form);
  await waitForAnyPlayer(form, 6000);

  // Snapshot the form as the bot sees it (useful while this is still new).
  await dumpDebug(form, cfg, "booking-form").catch(() => {});

  const existing = await filledPlayerNames(form);
  const isPresent = (n) => (me && sameName(me, n)) || existing.some((v) => sameName(v, n));
  const already = wanted.filter(isPresent);
  for (const n of already) report.push({ name: n, how: "already-listed" });
  const toEnter = wanted.filter((n) => !isPresent(n));

  // 3. Fill remaining names into empty rows (click "+ Member" to reveal the
  //    roster autocomplete for that row, then pick the matching member).
  for (const name of toEnter) {
    const how = await enterMember(form, name, T);
    report.push({ name, how });
  }

  // If a required player couldn't be entered, DON'T submit — the club rejects
  // it (e.g. Ocean's 2-player minimum) and we'd leave a doomed 5-minute hold.
  // Release the slot with Back instead and report which name failed.
  const missing = report.filter((p) => p.how === "failed").map((p) => p.name);
  if (missing.length) {
    await releaseForm(form, T);
    return { success: false, submitted: false, players: report, missing };
  }

  // 4. Book Now.
  const book = form.locator("a[id$='bookTeeTimeAction'], a:has-text('Book Now')").first();
  if (!(await book.isVisible().catch(() => false))) {
    await releaseForm(form, T);
    return { success: false, submitted: false, players: report };
  }
  await book.click({ timeout: T }).catch(() => {});
  await sleep(2000);

  // 5. Read the outcome. The club shows a "Restriction:" dialog for problems
  //    (e.g. "Minimum 2 players are necessary…") — surface its text so the
  //    caller knows this was a hard rejection, not just an unread confirmation.
  await dumpDebug(form, cfg, "after-book").catch(() => {});
  const restriction = await readRestriction(form);
  if (restriction) {
    return { success: false, submitted: true, players: report, restriction };
  }
  const bodyText = await form.locator("body").innerText().catch(() => "");
  const confirmed =
    /confirm(ed|ation)|success|has been booked|reservation (created|number)|your tee time|current registrations/i.test(bodyText);
  const formGone = (await form.locator("[id$='playersTable_data']").count().catch(() => 1)) === 0;
  const success = confirmed || formGone;
  return { success, submitted: true, players: report };
}

/**
 * Enter one member into the first empty player row: click "+ Member" to
 * reveal that row's roster autocomplete, type the last name, and pick the
 * matching member from the row's own suggestion panel. Logs the suggestions
 * it saw (they only exist server-side at runtime) and verifies the pick
 * actually landed in the field. Returns "picked" or "failed".
 */
async function enterMember(form, name, T) {
  const rows = form.locator("[id$='playersTable_data'] > tr");
  const rowCount = await rows.count().catch(() => 0);
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const filled = await row.locator("[id$=':player_input']").first().inputValue({ timeout: 600 }).catch(() => "");
    if (filled) continue; // row already has a player

    const memberBtn = row.locator("a.player-type-member").first();
    if (!(await memberBtn.isVisible().catch(() => false))) continue;
    await memberBtn.click({ timeout: T }).catch(() => {});

    const input = row.locator("[id$=':player_input']").first();
    await input.waitFor({ state: "visible", timeout: T }).catch(() => {});
    await input.click({ timeout: T }).catch(() => {});
    await input.pressSequentially(lastNameOf(name), { delay: 40 }).catch(() => {});

    // The suggestions render into THIS row's panel (role=listbox), server-side.
    const panel = row.locator("[id$=':player_panel']").first();
    const itemSel = "li.ui-autocomplete-item, [role='option'], li";
    let texts = [];
    for (let tries = 0; tries < 14; tries++) {
      await sleep(250);
      texts = (await panel.locator(itemSel).allInnerTexts().catch(() => []))
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (texts.length) break;
    }
    console.log(`[book] "${name}" → ${texts.length} suggestion(s): ${JSON.stringify(texts.slice(0, 8))}`);

    const idx = matchSuggestion(texts, name);
    if (idx < 0) {
      await input.fill("", { timeout: T }).catch(() => {});
      return "failed";
    }
    await panel.locator(itemSel).nth(idx).click({ timeout: T }).catch(() => {});
    await sleep(600); // selection fires an AJAX update of the row
    const landed = await row.locator("[id$=':player_input']").first().inputValue({ timeout: T }).catch(() => "");
    console.log(`[book] "${name}" selected → field now: ${JSON.stringify(landed)}`);
    return landed ? "picked" : "failed";
  }
  return "failed"; // no empty row to place them in
}

/** Cancel an in-progress reservation so it doesn't sit as a 5-minute hold. */
async function releaseForm(form, T) {
  const back = form.locator("a:has-text('Back'), button:has-text('Back')").first();
  if (await back.isVisible().catch(() => false)) {
    await back.click({ timeout: T }).catch(() => {});
    await sleep(800);
  }
}

async function isPartySize(form, n) {
  return (await form
    .locator(`input[type='radio'][value='${n}']`)
    .first()
    .isChecked()
    .catch(() => false));
}

async function loggedInMemberName(form) {
  const txt = await form.locator("text=/welcome\\s+\\S/i").first().innerText().catch(() => "");
  const m = txt.match(/welcome\s+(.+?)\s*!?$/i);
  return m ? m[1].trim() : "";
}

async function filledPlayerNames(form) {
  return form
    .locator("[id$=':player_input']")
    .evaluateAll((els) => els.map((e) => (e.value || "").trim()).filter(Boolean))
    .catch(() => []);
}

async function waitForAnyPlayer(form, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await filledPlayerNames(form)).length) return;
    await sleep(300);
  }
}

async function readRestriction(form) {
  const dlg = form.locator(".ui-dialog:visible", { hasText: /restriction|minimum|not allowed|cannot/i }).first();
  if (!(await dlg.isVisible().catch(() => false))) return "";
  const label = (await dlg.locator("dt label, .ui-datalist-item, p").first().innerText().catch(() => "")).trim();
  return label || (await dlg.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Enter each configured player into the booking form. ForeTees player rows
 * are text inputs backed by a roster autocomplete: type a name, pick the
 * matching member from the dropdown. A name that's already on the form
 * (e.g. the logged-in member auto-added as player 1) is skipped.
 */
export async function fillPlayers(form, cfg) {
  const sel = cfg.selectors ?? {};
  const wanted = cfg.want?.players ?? [];
  const report = [];

  for (const name of wanted) {
    if (await formContains(form, name)) {
      report.push({ name, how: "already-listed" });
      continue;
    }
    const input = await firstEmptyInput(form, sel.playerInput || "input[type='text']");
    if (!input) {
      report.push({ name, how: "failed" });
      continue;
    }

    await input.click().catch(() => {});
    // Search the way a human does: type the LAST name key-by-key (rosters
    // are "Last, First", so this fires the autocomplete regardless of how
    // the name was written in config), then pick the matching member.
    await input.pressSequentially(lastNameOf(name), { delay: 30 }).catch(() => {});

    const suggestions = form.locator(
      sel.suggestionItem ||
        ".ui-autocomplete li, .ui-menu-item, ul[class*='autocomplete' i] li, [class*='suggest' i] li"
    );
    await suggestions.first().waitFor({ state: "visible", timeout: 1500 }).catch(() => {});
    const texts = await suggestions.allInnerTexts().catch(() => []);
    const idx = matchSuggestion(texts, name);

    if (idx >= 0) {
      await suggestions.nth(idx).click().catch(() => {});
      report.push({ name, how: "picked" });
    } else if (texts.length > 0) {
      // Autocomplete offered options but none matched this name — don't
      // book a stranger; clear the box and let the TBD fallback hold the seat.
      await input.fill("").catch(() => {});
      report.push({ name, how: "failed" });
    } else {
      // No autocomplete on this skin — type the full name and leave it.
      await input.fill("").catch(() => {});
      await input.pressSequentially(name, { delay: 30 }).catch(() => {});
      report.push({ name, how: "typed" });
    }
    await sleep(150);
  }
  return report;
}

async function readNorthstarSlots(page, cfg) {
  // Each checked course renders its own section; map section index -> name
  // so slots carry their course (and unwanted courses can be filtered out).
  const wantCourses = (cfg?.want?.courses ?? []).map((c) => String(c).trim().toLowerCase());
  const headings = (await page.locator("label.course-slots-heading").allInnerTexts().catch(() => []))
    .map((h) => h.trim());

  const rows = page.locator("div[id$='slotTeeDIV']");
  const n = await rows.count();
  const slots = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const id = (await row.getAttribute("id").catch(() => "")) || "";
    const section = id.match(/teeTimeCourses:(\d+):/);
    const course = section ? headings[Number(section[1])] ?? null : null;
    if (wantCourses.length && course && !wantCourses.includes(course.toLowerCase())) continue;

    const time = (await row.locator("label.custom-time-label").first().innerText().catch(() => "")).trim();
    if (!TIME_RE.test(time)) continue;
    // Each open seat renders an "Available" link; a full row has none.
    const openSpots = await row.locator("[id$='allSlotsLink']").count();
    // Click target: an enabled seat link (disabled ones render as spans),
    // else the row's Reserve button if it's already expanded.
    let locator = row.locator("a[id$='allSlotsLink']:not(.ui-state-disabled)").first();
    if (!(await locator.count())) {
      locator = row.locator("a[id$='reserve_button'], [id$='allSlotsLink']").first();
    }
    slots.push({ time, openSpots, course, locator });
  }
  return slots;
}

async function formContains(form, name) {
  const want = name.toLowerCase();
  const text = await form.locator("body").innerText().catch(() => "");
  if (text.toLowerCase().includes(want)) return true;
  const values = await form
    .locator("input")
    .evaluateAll((els) => els.map((e) => e.value || ""))
    .catch(() => []);
  return values.some((v) => v.toLowerCase().includes(want));
}

async function firstEmptyInput(form, selector) {
  const inputs = form.locator(selector);
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    // Player rows carry contact fields too — never type a name into those.
    const meta = await el
      .evaluate((e) => `${e.id} ${e.name} ${e.placeholder} ${e.getAttribute("aria-label") || ""}`)
      .catch(() => "");
    if (/phone|email|cell/i.test(meta)) continue;
    if ((await el.inputValue().catch(() => "x")) === "") return el;
  }
  return null;
}

export async function dumpDebug(page, cfg, label) {
  const dir = path.resolve(cfg.browser?.screenshotDir || "shots");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await page.screenshot({ path: path.join(dir, `${label}-${stamp}.png`), fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  writeFileSync(path.join(dir, `${label}-${stamp}.html`), html);
  return dir;
}

const pad = (n) => String(n).padStart(2, "0");
