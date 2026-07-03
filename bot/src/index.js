// Main runner. Schedule this daily a few minutes before release (see README):
//   50 6 * * *  cd .../tee-time-bot && npm run run
// It exits immediately on mornings when the released date isn't one you want.
//
// Flags:
//   --now        strike immediately instead of waiting for release time
//   --dry-run    log in, read the sheet, print what would be booked — no clicks
//   --date=YYYY-MM-DD  override the target date (testing)

import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import { loadConfig, STATE_PATH, SHEET_URL_PATH } from "./config.js";
import { targetDate, isWantedDay, releaseEpochMs, rankSlots } from "./prefs.js";
import { serverOffsetMs, waitUntil, sleep } from "./clock.js";
import { portalLogin, discoverSheet, gotoSheet, readSlots, bookSlot, dumpDebug } from "./foretees.js";
import { notify } from "./notify.js";

const flags = new Set(process.argv.slice(2));
const NOW = flags.has("--now");
const DRY = flags.has("--dry-run");
const dateOverride = process.argv.find((a) => a.startsWith("--date="))?.slice(7);

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const cfg = loadConfig();
if (cfg.enabled === false && !DRY && !flags.has("--force")) {
  log("Bot is switched OFF in settings (enabled: false). Nothing to do.");
  process.exit(0);
}
// A pre-captured sheet URL (npm run login) is a shortcut, not a requirement:
// without one, the bot discovers the ForeTees sheet after logging in.
let saved = existsSync(SHEET_URL_PATH)
  ? JSON.parse(readFileSync(SHEET_URL_PATH, "utf8"))
  : null;

// ---- What date are we shooting for, and do we even want it? ----
const now = new Date();
let target = targetDate(now, cfg.club.bookingHorizonDays, cfg.club.timezone);
if (dateOverride) {
  const [y, m, d] = dateOverride.split("-").map(Number);
  target = { y, m, d, weekday: "?", iso: dateOverride };
}
if (!dateOverride && !DRY && !isWantedDay(target.weekday, cfg.want.daysOfWeek)) {
  log(`Today releases ${target.iso} (${target.weekday}) — not in ${cfg.want.daysOfWeek.join("/")}, nothing to do.`);
  process.exit(0);
}
log(`Target: ${target.iso} (${target.weekday}), party of ${cfg.want.partySize}${DRY ? " [DRY RUN]" : ""}`);
if (cfg.want.players?.length) {
  log(`Roster to enter: ${cfg.want.players.join(" | ")}`);
  if (cfg.want.players.length < cfg.want.partySize) {
    log(`NOTE: only ${cfg.want.players.length} players configured for a party of ${cfg.want.partySize} — remaining seats fall back to TBD, which the club may drop after 5 minutes.`);
  }
} else {
  log("NOTE: want.players is empty — seats will be held as TBD, which the club drops after 5 minutes. Add all four member names to config.json.");
}

// ---- When do we fire? ----
let strikeAt = null; // local-clock epoch ms
if (!NOW) {
  const release = releaseEpochMs(now, cfg.club.releaseTime, cfg.club.timezone);
  if (release === null) {
    log(`Release time ${cfg.club.releaseTime} already passed today. Use --now to strike anyway.`);
    process.exit(1);
  }
  // If the laptop clock is 5s slow, 7:00:00 on the server is 6:59:55 local.
  const offset = await serverOffsetMs(cfg.club.portalLoginUrl);
  log(`Server clock offset: ${offset > 0 ? "+" : ""}${offset}ms (correcting)`);
  strikeAt = release - offset - (cfg.strike.leadMs ?? 200);

  // On CI two schedules cover daylight-saving shifts; the one that lands
  // way too early bows out and leaves the strike to its sibling.
  const maxWaitMin = Number(process.env.MAX_WAIT_MIN || 0);
  if (maxWaitMin && strikeAt - Date.now() > maxWaitMin * 60_000) {
    log(`Release is ${Math.round((strikeAt - Date.now()) / 60_000)}min away (> MAX_WAIT_MIN=${maxWaitMin}) — leaving this to the later scheduled run.`);
    process.exit(0);
  }
}

const browser = await chromium.launch({
  headless: cfg.browser?.headless ?? true,
  executablePath: process.env.CHROMIUM_PATH || cfg.browser?.executablePath || undefined,
});
const exitCode = await main().catch(async (err) => {
  console.error(err);
  await notify(cfg, "⛳ Bot error", err.message).catch(() => {});
  return 1;
});
await browser.close().catch(() => {});
process.exit(exitCode);

async function main() {
  const context = await browser.newContext(
    existsSync(STATE_PATH) ? { storageState: STATE_PATH } : {}
  );
  const page = await context.newPage();

  try {
    // ---- Prewarm: log in and park on the sheet before the gun goes off ----
    if (strikeAt) {
      const prewarmAt = strikeAt - (cfg.strike.prewarmMinutes ?? 5) * 60_000;
      if (prewarmAt > Date.now()) {
        log(`Waiting to prewarm at ${new Date(prewarmAt).toISOString()}`);
        await waitUntil(prewarmAt);
      }
    }

    log("Logging in to member portal...");
    await portalLogin(page, cfg);
    let sheetPage = page;
    if (!saved) {
      log("Logged in. Discovering the ForeTees tee sheet...");
      const found = await discoverSheet(page);
      sheetPage = found.page;
      saved = found.saved;
      if (!/foretees\.com|tee.?time/i.test(saved.url) && !saved.template) {
        log(`WARNING: couldn't confirm a ForeTees page (landed on ${saved.url}) — proceeding, but if this fails run \`npm run login\` once to capture the sheet URL.`);
      }
      log(`Sheet: ${saved.template ?? saved.url}`);
    }
    log("Opening tee sheet for the target date...");
    await gotoSheet(sheetPage, saved, target, cfg);

    if (strikeAt) {
      log(`Armed. Striking at ${new Date(strikeAt).toISOString()}`);
      await waitUntil(strikeAt);
    }

    // ---- Strike loop: reload, rank, book, repeat ----
    const deadline = Date.now() + (cfg.strike.strikeWindowSec ?? 180) * 1000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      await gotoSheet(sheetPage, saved, target, cfg);
      const slots = await readSlots(sheetPage, cfg);
      const ranked = rankSlots(slots, cfg.want.timeWindows, {
        partySize: cfg.want.partySize,
        prefer: cfg.want.prefer,
      });
      log(`Pass ${attempt}: ${slots.length} times on sheet, ${ranked.length} match your windows` +
          (ranked.length
            ? ` — best: ${ranked.slice(0, 3).map((s) => s.time + (s.course ? ` (${s.course})` : "")).join(", ")}`
            : ""));

      if (DRY) {
        if (!slots.length) {
          const dir = await dumpDebug(sheetPage, cfg, "dry-run-empty");
          log(`No times detected — sheet snapshot saved to ${dir}/ so selectors can be tuned.`);
        }
        log("Dry run complete. No booking attempted.");
        return 0;
      }

      for (const slot of ranked.slice(0, 3)) {
        log(`Attempting ${slot.time}${slot.course ? ` on ${slot.course}` : ""}...`);
        const result = await bookSlot(sheetPage, slot, cfg);
        if (result.success) {
          await dumpDebug(sheetPage, cfg, `booked-${target.iso}`);
          const roster = result.players
            .map((p) => `${p.name} (${p.how})`)
            .join(", ");
          log(`Booked ${slot.time}${slot.course ? ` on ${slot.course}` : ""}. Players: ${roster || "(none configured)"}`);
          const failed = result.players.filter((p) => p.how === "failed");
          const typed = result.players.filter((p) => p.how === "typed");
          if (failed.length || typed.length) {
            const parts = [];
            if (failed.length) parts.push(`no roster match, left as TBD: ${failed.map((p) => p.name).join(", ")}`);
            if (typed.length) parts.push(`typed but not confirmed against the roster: ${typed.map((p) => p.name).join(", ")}`);
            await notify(cfg, "⛳ Booked — VERIFY NAMES NOW",
              `${target.iso} at ${slot.time}${slot.course ? ` on ${slot.course}` : ""} is yours, but check the players (${parts.join("; ")}). ` +
              `Open ForeTees and make sure all ${cfg.want.partySize} names are in within 5 minutes or the club drops the booking!`);
          } else {
            await notify(cfg, "⛳ Tee time booked!",
              `${target.iso} at ${slot.time}${slot.course ? ` on ${slot.course}` : ""}, all ${cfg.want.partySize} names confirmed from the roster. Screenshot saved.`);
          }
          return 0;
        }
        log(`${slot.time} slipped away (someone else got it, or the form didn't confirm). Next...`);
      }

      if (!slots.length && attempt === 3) {
        await dumpDebug(sheetPage, cfg, "empty-sheet");
      }
      await sleep(cfg.strike.reloadDelayMs ?? 400);
    }

    await dumpDebug(sheetPage, cfg, `missed-${target.iso}`);
    await notify(cfg, "⛳ No tee time",
      `Couldn't land a slot for ${target.iso} within the strike window. Screenshot of the final sheet saved.`);
    return 1;
  } catch (err) {
    await dumpDebug(page, cfg, "error").catch(() => {});
    throw err;
  }
}
