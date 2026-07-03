import { authorized, readConfig, writeConfig } from "../../../lib/github.js";

export async function GET(req) {
  if (!authorized(req)) return Response.json({ error: "bad pin" }, { status: 401 });
  const { config } = await readConfig();
  return Response.json({
    enabled: config.enabled !== false,
    daysOfWeek: config.want?.daysOfWeek ?? [],
    window: config.want?.timeWindows?.[0] ?? { start: "07:30", end: "10:00" },
    players: config.want?.players ?? [],
  });
}

export async function POST(req) {
  if (!authorized(req)) return Response.json({ error: "bad pin" }, { status: 401 });
  const body = await req.json();

  const players = (body.players ?? []).map((p) => String(p).trim()).filter(Boolean);
  const { config, sha } = await readConfig();
  config.enabled = Boolean(body.enabled);
  config.want ??= {};
  config.want.daysOfWeek = (body.daysOfWeek ?? []).filter((d) =>
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(d)
  );
  config.want.timeWindows = [
    {
      start: String(body.window?.start ?? "07:30"),
      end: String(body.window?.end ?? "10:00"),
    },
  ];
  config.want.players = players;
  // The party is however many names are filled in.
  config.want.partySize = Math.min(Math.max(players.length, 1), 4);

  await writeConfig(config, sha);
  return Response.json({ ok: true });
}
