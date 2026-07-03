// Clock sync + precise waiting. Your laptop's clock can be seconds off; the
// club's server clock is what decides whether you were "first". We estimate
// (serverTime - localTime) from HTTP Date headers and correct for it.

/**
 * Estimate server-vs-local clock offset in ms by sampling the Date header.
 * Takes the sample with the lowest round-trip (least network noise).
 * Date headers only have 1s resolution, so this is ±~500ms — good enough to
 * stop a 5-seconds-slow laptop clock from losing the race.
 */
export async function serverOffsetMs(url, samples = 5) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "manual" });
      const t1 = Date.now();
      const dateHeader = res.headers.get("date");
      if (!dateHeader) continue;
      const rtt = t1 - t0;
      const serverMs = new Date(dateHeader).getTime() + 500 + rtt / 2;
      const offset = serverMs - t1;
      if (!best || rtt < best.rtt) best = { rtt, offset };
    } catch {
      // network hiccup — try the next sample
    }
  }
  return best ? Math.round(best.offset) : 0;
}

/** Sleep until local epoch ms `targetMs`, coarse sleeps then a tight tail. */
export async function waitUntil(targetMs) {
  for (;;) {
    const remaining = targetMs - Date.now();
    if (remaining <= 0) return;
    if (remaining > 500) await sleep(Math.min(remaining - 400, 10_000));
    else if (remaining > 25) await sleep(10);
    else await sleep(2);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
