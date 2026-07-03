# New Seabury Tee-Time Bot

Automatic tee-time booking for The Club at New Seabury (member portal →
ForeTees). The club releases times **14 days out at 7:00 AM ET**; this books
the foursome's preferred time the second they open and enters **all four
member names immediately** (the club drops bookings left unnamed for 5
minutes).

Two pieces, one repo:

| Piece | What | Where it runs |
|---|---|---|
| `web/` | A one-page settings site: on/off switch, day picker, time range, four name boxes, test buttons, recent results. Family-password protected. | Vercel, e.g. `teetime.anthonyniccoli.com` |
| `bot/` | The sniper: logs in ~6:55, syncs to the server clock, strikes at 7:00:00, books, names everyone, pushes a confirmation to the phone. | GitHub Actions, daily (`.github/workflows/strike.yml`) — no home computer needed |

They meet in the middle at **`config.json`** (repo root): the web page edits
it through the GitHub API, the morning run reads it. No database.

> This books through the member's own account and only does what he'd do by
> hand, just faster. Worth a skim of the club's reservation rules, and worth
> being a good neighbor with.

## Setup (the technical person does this once)

### 1. Secrets — GitHub repo → Settings → Secrets and variables → Actions

- `PORTAL_USERNAME` / `PORTAL_PASSWORD` — the newseabury.com member login.

### 2. A token for the web page

GitHub → Settings → Developer settings → Fine-grained personal access tokens →
generate one scoped to **only this repo** with **Contents: Read & write** and
**Actions: Read & write**. This is how the settings page saves config and
starts test runs.

### 3. Deploy the web page on Vercel

- Import this repo; set **Root Directory = `web`**.
- Environment variables:
  - `GH_REPO` = `drmilesbennell/tee-time-bot`
  - `GH_TOKEN` = the token from step 2
  - `ADMIN_PIN` = the family password (share it with your father-in-law)
- Add the domain (e.g. `teetime.anthonyniccoli.com`) in Vercel → Domains, and
  at your DNS provider add a CNAME for `teetime` → `cname.vercel-dns.com`.

### 4. Phone notifications (2 minutes, recommended)

Install the free **ntfy** app on his phone, subscribe to a made-up secret
topic (e.g. `nseabury-fitz-8k3q`), and put that same string in `config.json`
under `notify.ntfyTopic` (commit it, or add a field to the web page later).
Booked / verify-names / failed alerts land on his phone instantly.

### 5. Turn it on

Open the site, enter the password, pick days + time range, type the four
names **exactly as the club directory lists them** ("Last, First"), flip the
switch to ON, hit Save.

## How he uses it (the whole manual)

- **Switch ON**: it books his days automatically. **OFF**: it does nothing.
- Pick days, pick a time range, type who's playing. **Save.**
- His phone buzzes at ~7:01 AM with either "booked, all names in ✓" or what
  needs attention.

## Testing (safe, do this before trusting it)

Cancellations are free until ~1 day before the round — **confirm that with
the pro shop first**, then:

1. **Practice run** (blue button, or `workflow_dispatch → dry-run`): logs in
   with the real account, opens the real tee sheet 14 days out, and reports
   every time it can see and which it would grab. Books nothing. If it sees
   what he sees in the app, the selectors are right.
2. **Live-fire test** (red button): books the best open time matching current
   settings, right now, names and all. Temporarily set the day/time range to
   something unpopular (a Tuesday 1–3 PM two weeks out), press it, watch the
   phone buzz, verify the booking and all four names in ForeTees — then
   **cancel the booking** in ForeTees and set the settings back.
3. **First real morning**: flip ON before his target Saturday two weeks out.
   The scheduled run fires at 6:35 ET, waits for exactly 7:00:00, and strikes.

Local CLI testing also works (`cd bot && npm install && npx playwright
install chromium`, put creds in `bot/.env`, then `npm run dry-run` or
`npm run strike-now`). `npm test` runs the unit tests.

## How the 7:00 strike wins

1. **6:35 ET** — GitHub Actions starts (scheduled early because GH cron can
   run late; the bot waits internally, and of the two DST schedules the
   too-early one exits via `MAX_WAIT_MIN`).
2. **~6:55** — fresh portal login, auto-discovers the ForeTees tee sheet,
   parks on the target date. DNS/TLS/session warm.
3. **Clock sync** — corrects for machine-vs-server clock drift using the
   server's own clock; fires ~200ms before 7:00:00 server time.
4. **Strike** — reloads the sheet every ~400ms for up to 3 minutes, ranks
   open slots against the time range, attacks the top three in order.
5. **Names in, same transaction** — types each last name, picks the member
   from the roster autocomplete, never guesses (ambiguous → TBD + an urgent
   "VERIFY NAMES NOW" phone push with the 5-minute warning).
6. **Proof** — screenshots to the run's artifacts, result pushed to the phone.

## Repo layout

```
config.json                    the settings (edited by web/, read by bot/)
.github/workflows/strike.yml   daily 6:35 ET runner + on-demand tests
bot/src/index.js               orchestrator: prewarm → sync → strike → notify
bot/src/foretees.js            portal login, sheet discovery, slot read, booking
bot/src/prefs.js               date & ranking logic (unit tested: bot/test/)
bot/src/clock.js               server clock offset + precise waits
bot/src/notify.js              ntfy.sh phone push
bot/src/login.js               optional interactive URL capture for local runs
web/                           Next.js settings page (Vercel)
```

If the scheduled runner ever proves flaky on GitHub's shared runners, the
same `bot/` runs unchanged on any $5 VPS or Raspberry Pi via cron — only the
scheduler moves; the web page and config stay put.
