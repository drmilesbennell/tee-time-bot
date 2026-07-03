import test from "node:test";
import assert from "node:assert/strict";
import {
  targetDate,
  isWantedDay,
  releaseEpochMs,
  parseTimeToMinutes,
  rankSlots,
  lastNameOf,
  matchSuggestion,
} from "../src/prefs.js";

const TZ = "America/New_York";

test("targetDate is exactly 14 days out, same weekday", () => {
  // 2026-07-03 06:50 ET is a Friday
  const now = new Date("2026-07-03T10:50:00Z");
  const t = targetDate(now, 14, TZ);
  assert.equal(t.iso, "2026-07-17");
  assert.equal(t.weekday, "Fri");
});

test("targetDate handles month rollover", () => {
  const now = new Date("2026-07-25T10:50:00Z");
  assert.equal(targetDate(now, 14, TZ).iso, "2026-08-08");
});

test("targetDate uses club timezone, not UTC", () => {
  // 03:00Z on July 4 is still July 3 in New York
  const now = new Date("2026-07-04T03:00:00Z");
  assert.equal(targetDate(now, 14, TZ).iso, "2026-07-17");
});

test("isWantedDay matches abbreviations case-insensitively", () => {
  assert.ok(isWantedDay("Sat", ["saturday", "sunday"]));
  assert.ok(!isWantedDay("Wed", ["Sat", "Sun"]));
  assert.ok(isWantedDay("Wed", [])); // empty = every day
});

test("releaseEpochMs is the upcoming 7am ET", () => {
  const now = new Date("2026-07-03T10:50:00Z"); // 06:50 ET
  const rel = releaseEpochMs(now, "07:00:00", TZ);
  assert.equal(rel - now.getTime(), 10 * 60 * 1000);
});

test("releaseEpochMs returns null if release already passed", () => {
  const now = new Date("2026-07-03T11:01:00Z"); // 07:01 ET
  assert.equal(releaseEpochMs(now, "07:00:00", TZ), null);
});

test("parseTimeToMinutes handles am/pm and 24h", () => {
  assert.equal(parseTimeToMinutes("7:30 AM"), 450);
  assert.equal(parseTimeToMinutes("12:10 PM"), 730);
  assert.equal(parseTimeToMinutes("12:05 AM"), 5);
  assert.equal(parseTimeToMinutes("13:45"), 825);
  assert.equal(parseTimeToMinutes("Open"), null);
});

const windows = [
  { start: "07:30", end: "09:00" },
  { start: "09:00", end: "10:30" },
];

test("rankSlots prefers first window, earliest within it", () => {
  const slots = [
    { time: "9:40 AM", openSpots: 4 },
    { time: "8:10 AM", openSpots: 4 },
    { time: "7:50 AM", openSpots: 4 },
    { time: "6:50 AM", openSpots: 4 }, // outside all windows
  ];
  const ranked = rankSlots(slots, windows, { partySize: 4 });
  assert.deepEqual(ranked.map((s) => s.time), ["7:50 AM", "8:10 AM", "9:40 AM"]);
});

test("rankSlots drops slots without room for the party", () => {
  const slots = [
    { time: "7:50 AM", openSpots: 2 },
    { time: "8:10 AM", openSpots: 4 },
  ];
  const ranked = rankSlots(slots, windows, { partySize: 4 });
  assert.deepEqual(ranked.map((s) => s.time), ["8:10 AM"]);
});

test("rankSlots keeps slots with unknown capacity (find out by trying)", () => {
  const slots = [{ time: "7:50 AM", openSpots: null }];
  assert.equal(rankSlots(slots, windows, { partySize: 4 }).length, 1);
});

test("lastNameOf handles both name orders", () => {
  assert.equal(lastNameOf("Niccoli, Joseph"), "niccoli");
  assert.equal(lastNameOf("Joe Niccoli"), "niccoli");
  assert.equal(lastNameOf("Niccoli"), "niccoli");
});

test("matchSuggestion prefers a full-name match", () => {
  const texts = ["Niccoli, Anthony", "Niccoli, Joseph Sr", "Smith, Joseph"];
  assert.equal(matchSuggestion(texts, "Niccoli, Joseph"), 1);
});

test("matchSuggestion accepts a unique last-name match", () => {
  const texts = ["Smith, Bob", "Jones, Pat"];
  assert.equal(matchSuggestion(texts, "Robert Smith"), 0);
});

test("matchSuggestion refuses ambiguous last-name matches", () => {
  // Two Niccolis and the requested first name matches neither exactly —
  // better to fall back to TBD than book the wrong member.
  const texts = ["Niccoli, Anthony", "Niccoli, Marie"];
  assert.equal(matchSuggestion(texts, "Niccoli, Joseph"), -1);
});

test("matchSuggestion handles empty suggestion lists", () => {
  assert.equal(matchSuggestion([], "Niccoli, Joseph"), -1);
  assert.equal(matchSuggestion(null, "Niccoli, Joseph"), -1);
});

test("rankSlots prefer=latest flips ordering within a window", () => {
  const slots = [
    { time: "7:50 AM", openSpots: 4 },
    { time: "8:40 AM", openSpots: 4 },
  ];
  const ranked = rankSlots(slots, windows, { partySize: 4, prefer: "latest" });
  assert.deepEqual(ranked.map((s) => s.time), ["8:40 AM", "7:50 AM"]);
});
