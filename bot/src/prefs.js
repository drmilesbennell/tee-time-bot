// Pure date/slot-preference logic. No I/O — unit-tested in test/prefs.test.js.

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Parts of `now` (a Date) in the club's timezone. */
export function zonedParts(now, timezone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

/**
 * The date the club releases at `releaseTime` today: today + horizonDays,
 * computed in the club's timezone. Returns { y, m, d, weekday, iso }.
 */
export function targetDate(now, horizonDays, timezone) {
  const p = zonedParts(now, timezone);
  // Noon UTC avoids DST edge cases when adding whole days.
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  base.setUTCDate(base.getUTCDate() + horizonDays);
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + 1;
  const d = base.getUTCDate();
  return {
    y,
    m,
    d,
    weekday: DAY_NAMES[base.getUTCDay()],
    iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  };
}

export function isWantedDay(weekday, daysOfWeek) {
  if (!daysOfWeek?.length) return true;
  return daysOfWeek.map((d) => d.slice(0, 3).toLowerCase()).includes(weekday.slice(0, 3).toLowerCase());
}

/**
 * Epoch ms of the next occurrence of `releaseTime` ("HH:MM:SS") in the club
 * timezone, relative to `now`. If today's release already passed, returns null.
 */
export function releaseEpochMs(now, releaseTime, timezone) {
  const [h, mi, s] = releaseTime.split(":").map(Number);
  const p = zonedParts(now, timezone);
  const nowSecs = p.hour * 3600 + p.minute * 60 + p.second;
  const relSecs = h * 3600 + mi * 60 + (s || 0);
  if (relSecs <= nowSecs) return null;
  return now.getTime() + (relSecs - nowSecs) * 1000;
}

/** "8:07 AM" | "12:30 PM" | "07:15" -> minutes since midnight, or null. */
export function parseTimeToMinutes(text) {
  const m = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM|A|P)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toUpperCase();
  if (ap?.startsWith("P") && h !== 12) h += 12;
  if (ap?.startsWith("A") && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "Niccoli, Joseph" -> "niccoli"; "Joe Niccoli" -> "niccoli". */
export function lastNameOf(name) {
  const s = String(name).trim();
  if (s.includes(",")) return s.split(",")[0].trim().toLowerCase();
  const words = s.split(/\s+/);
  return (words[words.length - 1] || "").toLowerCase();
}

/**
 * Pick the roster-autocomplete entry for `name` from suggestion texts.
 * Exact-ish full-name match wins; otherwise a unique last-name match.
 * Returns the index, or -1 if nothing matches confidently (caller falls
 * back to TBD rather than booking a stranger into the slot).
 */
export function matchSuggestion(texts, name) {
  const norm = (t) => t.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const want = norm(name);
  const wantTokens = want.split(" ").filter(Boolean);
  const last = lastNameOf(name);
  if (!texts?.length) return -1;

  const full = texts.findIndex((t) => norm(t).includes(want));
  if (full !== -1) return full;

  // Order-independent: config "Thompson, Patti" should match a suggestion
  // rendered "Patti Thompson" — every name token present as a whole word.
  if (wantTokens.length >= 2) {
    const bySubset = texts.findIndex((t) => {
      const tt = norm(t);
      return wantTokens.every((tok) => new RegExp(`\\b${tok}\\b`).test(tt));
    });
    if (bySubset !== -1) return bySubset;
  }

  const byLast = texts
    .map((t, i) => ({ t: norm(t), i }))
    .filter(({ t }) => last && new RegExp(`\\b${last}\\b`).test(t));
  return byLast.length === 1 ? byLast[0].i : -1;
}

/**
 * Do a form-displayed name ("Mark Thompson") and a config name
 * ("Thompson, Mark") refer to the same person? Compares the set of name
 * tokens, so word order and a "Last, First" comma don't matter.
 */
export function sameName(a, b) {
  const toks = (s) =>
    String(s).toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  const ta = toks(a);
  return ta.length > 0 && ta === toks(b);
}

/**
 * Rank available slots against preference windows.
 * slots: [{ time: "8:07 AM", openSpots: number, ...passthrough }]
 * windows: [{ start: "07:30", end: "09:00" }] in priority order.
 * Returns slots that fit, best first: window priority, then earliest
 * (or latest, per `prefer`) within each window.
 */
export function rankSlots(slots, windows, { partySize = 1, prefer = "earliest" } = {}) {
  const wins = windows.map((w) => ({
    start: parseTimeToMinutes(w.start),
    end: parseTimeToMinutes(w.end),
  }));
  const scored = [];
  for (const slot of slots) {
    const mins = parseTimeToMinutes(slot.time);
    if (mins === null) continue;
    if (slot.openSpots != null && slot.openSpots < partySize) continue;
    const wi = wins.findIndex((w) => mins >= w.start && mins <= w.end);
    if (wi === -1) continue;
    scored.push({ slot, wi, mins });
  }
  scored.sort((a, b) => a.wi - b.wi || (prefer === "latest" ? b.mins - a.mins : a.mins - b.mins));
  return scored.map((s) => s.slot);
}
