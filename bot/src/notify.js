// Phone push via ntfy.sh (free, no account): subscribe to your topic in the
// ntfy app, set notify.ntfyTopic in config.json to the same string.
// Pick something unguessable, e.g. "nseabury-tt-8f3k2".

export async function notify(cfg, title, message) {
  const line = `[notify] ${title}: ${message}`;
  console.log(line);
  const topic = cfg.notify?.ntfyTopic;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: "golf" },
      body: message,
    });
  } catch (err) {
    console.error(`[notify] push failed: ${err.message}`);
  }
}
