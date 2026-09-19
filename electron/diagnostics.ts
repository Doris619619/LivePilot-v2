/** 真实本机环境检查；不把 Docker、Git 和系统 Node 列为安装版依赖。 */
import { access, mkdir, writeFile, unlink, statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { net } from "electron";
import type { Check } from "../src/shared/desktop";
import type { Settings } from "./settings";
import { checkObsNetwork } from "./obs-network";
/** 每项独立返回修复说明，失败不会清空其他已完成配置。 */
export async function diagnose(settings: Settings, resources: string): Promise<Check[]> {
  const checks: Check[] = [{ id: "system", label: "Windows x64", status: process.platform === "win32" && process.arch === "x64" ? "ready" : "error", ...(process.platform !== "win32" || process.arch !== "x64" ? { message: "此安装版需要 Windows x64。" } : {}) }];
  try { await mkdir(settings.dataRoot, { recursive: true }); const probe = path.join(settings.dataRoot, ".write-check-" + randomUUID()); await writeFile(probe, "ok", { flag: "wx" }); await unlink(probe); checks.push({ id: "directory", label: "数据目录", status: "ready" }); }
  catch { checks.push({ id: "directory", label: "数据目录", status: "error", message: "目录不可写，请在设置中选择有权限的文件夹。" }); }
  try { const disk = await statfs(settings.dataRoot); checks.push({ id: "disk", label: "磁盘空间", status: disk.bavail * disk.bsize >= 3 * 1024 ** 3 ? "ready" : "error", ...(disk.bavail * disk.bsize < 3 * 1024 ** 3 ? { message: "至少预留 3 GB 用于 OBS，素材需要额外空间。" } : {}) }); }
  catch { checks.push({ id: "disk", label: "磁盘空间", status: "error", message: "无法读取磁盘空间。" }); }
  for (const [id, label, file] of [["node", "内置 Node 与 Agent", "vendor/node.exe"], ["agent", "Agent 程序", "agent/desktop-worker.cjs"], ["obs", "内置 OBS", "vendor/obs.zip"]]) {
    const exists = await access(path.join(resources, file)).then(() => true, () => false); checks.push({ id, label, status: exists ? "ready" : "missing", ...(!exists ? { message: "安装文件缺失，请重新安装完整 LiveNest 安装包。" } : {}) });
  }
  try { const response = await net.fetch((settings.identity?.origin || "https://livenest.duckdns.org") + "/api/health", { redirect: "error", signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(); await response.body?.cancel(); checks.push({ id: "cloud", label: "网页服务", status: "ready" }); }
  catch { checks.push({ id: "cloud", label: "网页服务", status: "error", message: "无法连接网页服务，请检查网络；离线帮助仍可使用。" }); }
  checks.push(...await Promise.all(settings.instances.map(checkObsNetwork)));
  return checks;
}
