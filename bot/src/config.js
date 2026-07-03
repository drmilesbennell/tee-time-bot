import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const AUTH_DIR = path.join(ROOT, ".auth");
export const STATE_PATH = path.join(AUTH_DIR, "state.json");
export const SHEET_URL_PATH = path.join(AUTH_DIR, "sheet-url.json");

function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

export function loadConfig() {
  loadDotEnv();
  // Precedence: CONFIG_PATH env > bot/config.json (local override) >
  // ../config.json (repo root — the file the web settings page edits).
  const configPath = process.env.CONFIG_PATH
    ? path.resolve(process.env.CONFIG_PATH)
    : [path.join(ROOT, "config.json"), path.join(path.dirname(ROOT), "config.json")].find(existsSync);
  if (!configPath || !existsSync(configPath)) {
    throw new Error("No config.json found (looked in bot/ and repo root; CONFIG_PATH overrides).");
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));

  cfg.credentials = {
    username: process.env.PORTAL_USERNAME || "",
    password: process.env.PORTAL_PASSWORD || "",
  };

  if (!cfg.club?.portalLoginUrl) throw new Error("club.portalLoginUrl is required");
  if (!cfg.want?.timeWindows?.length) throw new Error("want.timeWindows is required");
  return cfg;
}

export { ROOT };
