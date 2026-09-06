import "server-only";
import path from "node:path";
import { AppError } from "./errors";
export function config() {
  const origin = process.env.LIVEPILOT_ORIGIN || "http://127.0.0.1:3010";
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new AppError("CONFIG", "LIVEPILOT_ORIGIN 必须是 http://127.0.0.1:端口。");
  const wsUrl = process.env.LIVEPILOT_OBS_WS_URL || "ws://127.0.0.1:4455";
  const ws = new URL(wsUrl);
  if (ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1" || !ws.port || ws.username || ws.password || ws.pathname !== "/" || ws.search || ws.hash) {
    throw new AppError("CONFIG", "OBS WebSocket 必须使用 ws://127.0.0.1:端口。");
  }
  const privacy = process.env.LIVEPILOT_PRIVACY || "unlisted";
  if (!["private", "unlisted", "public"].includes(privacy)) throw new AppError("CONFIG", "LIVEPILOT_PRIVACY 必须是 private、unlisted 或 public。");
  const kids = process.env.LIVEPILOT_MADE_FOR_KIDS || "false";
  if (!["true", "false"].includes(kids)) throw new AppError("CONFIG", "LIVEPILOT_MADE_FOR_KIDS 必须是 true 或 false。");
  return {
    origin, wsUrl, wsPort: Number(ws.port),
    obsExe: process.env.LIVEPILOT_OBS_EXE || "",
    obsPassword: process.env.LIVEPILOT_OBS_WS_PASSWORD || "",
    mediaRoot: process.env.LIVEPILOT_MEDIA_ROOT || "",
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    encryptionKey: process.env.LIVEPILOT_ENCRYPTION_KEY || "",
    dataDir: path.resolve(".data"),
    redirectUri: origin + "/api/youtube/callback", privacy, madeForKids: kids === "true",
  };
}
export function missingConfig() {
  const c = config();
  return Object.entries({
    LIVEPILOT_OBS_EXE: c.obsExe, LIVEPILOT_OBS_WS_PASSWORD: c.obsPassword,
    LIVEPILOT_MEDIA_ROOT: c.mediaRoot, GOOGLE_CLIENT_ID: c.clientId,
    GOOGLE_CLIENT_SECRET: c.clientSecret, LIVEPILOT_ENCRYPTION_KEY: c.encryptionKey,
  }).filter(([, value]) => !value).map(([key]) => key);
}
