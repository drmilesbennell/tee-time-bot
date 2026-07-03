import { authorized, listRuns } from "../../../lib/github.js";

export async function GET(req) {
  if (!authorized(req)) return Response.json({ error: "bad pin" }, { status: 401 });
  return Response.json({ runs: await listRuns() });
}
