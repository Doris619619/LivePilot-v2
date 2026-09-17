/** 本机服务和 Agent 的互斥进程锁，避免两个入口同时操作同一媒体与 OBS。 */
import { mkdirSync, openSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";
import { dataRoot } from "./config";
import { AppError } from "./errors";
const registry = globalThis as typeof globalThis & { livePilotHostLock?: string };
/** 第一次使用本机运行核心时独占数据根；异常退出由既有恢复工具核对 PID。 */
export function claimHost() {
  const filename = path.join(dataRoot(), "host.lock"); if (registry.livePilotHostLock === filename) return;
  mkdirSync(dataRoot(), { recursive: true }); let handle: number;
  try { handle = openSync(filename, "wx", 0o600); } catch { throw new AppError("HOST_BUSY", "本地服务或 Agent 已占用该配置；请停止旧进程，必要时核对 PID 后恢复 host 锁。", 409); }
  writeFileSync(handle, String(process.pid)); closeSync(handle); registry.livePilotHostLock = filename;
  process.once("exit", () => { try { unlinkSync(filename); } catch { /* 保留无法清理的锁供显式恢复。 */ } });
}
