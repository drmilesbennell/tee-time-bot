// Server-side GitHub helpers. The settings page has no database — the
// bot's config.json in this repo IS the database, edited via the GitHub
// contents API, and test runs are workflow_dispatch events.
//
// Env (set in Vercel):
//   GH_REPO   e.g. "drmilesbennell/tee-time-bot"
//   GH_TOKEN  fine-grained PAT for that repo: Contents read/write, Actions read/write
//   ADMIN_PIN the family password for the settings page

const API = "https://api.github.com";

function gh(path, init = {}) {
  return fetch(`${API}/repos/${process.env.GH_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
    cache: "no-store",
  });
}

export function authorized(req) {
  const pin = req.headers.get("x-pin");
  return Boolean(pin && process.env.ADMIN_PIN && pin === process.env.ADMIN_PIN);
}

export async function readConfig() {
  const res = await gh(`/contents/config.json`);
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
  const data = await res.json();
  return {
    config: JSON.parse(Buffer.from(data.content, "base64").toString("utf8")),
    sha: data.sha,
  };
}

export async function writeConfig(config, sha) {
  const res = await gh(`/contents/config.json`, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update tee-time settings from web page",
      content: Buffer.from(JSON.stringify(config, null, 2) + "\n").toString("base64"),
      sha,
    }),
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
}

export async function listRuns() {
  const res = await gh(`/actions/workflows/strike.yml/runs?per_page=10`);
  if (!res.ok) throw new Error(`GitHub runs failed: ${res.status}`);
  const data = await res.json();
  return (data.workflow_runs ?? []).map((r) => ({
    id: r.id,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    startedAt: r.run_started_at,
  }));
}

export async function dispatchStrike(mode) {
  const res = await gh(`/actions/workflows/strike.yml/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { mode } }),
  });
  if (res.status !== 204) throw new Error(`Dispatch failed: ${res.status} ${await res.text()}`);
}
