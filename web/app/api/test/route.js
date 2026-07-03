import { authorized, dispatchStrike } from "../../../lib/github.js";

export async function POST(req) {
  if (!authorized(req)) return Response.json({ error: "bad pin" }, { status: 401 });
  const { mode } = await req.json();
  if (!["dry-run", "book-now"].includes(mode)) {
    return Response.json({ error: "bad mode" }, { status: 400 });
  }
  await dispatchStrike(mode);
  return Response.json({ ok: true });
}
