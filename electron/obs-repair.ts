/** 自有 OBS 连接修复：只在目标已停止且维护已确认后备份、修改 WebSocket 设置。 */
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configureCore, config } from "../src/core/config";
import { ObsProcessManager } from "../src/core/obs/process";
import { environment, type Settings } from "./settings";
import type { DesktopInstance } from "../src/shared/desktop";
import { freePort } from "./obs-setup";

/** 不停止运行中或状态未知的 OBS；用户关闭后才能修复，包括密码无法认证的情况。 */
export async function repairManagedObs(settings: Settings, item: DesktopInstance, lock: () => Promise<void>) {
  if (!item.managed) throw new Error("不能修改手动接入的 OBS。");
  const root = path.resolve(item.exe, "../../..");
  if (await readFile(path.join(root, ".livenest-owner"), "utf8") !== item.id) throw new Error("OBS 目录归属不匹配，未修改配置。");
  configureCore(() => environment({ ...settings, instances: [...settings.instances.filter(i => i.id !== item.id), item] }));
  const inspect = () => new ObsProcessManager(() => config(item.id)).inspect();
  if ((await inspect()).pid) throw new Error("请先在 OBS 中确认结束推流和录制并关闭此 OBS，再修复连接。未修改或重启运行中的 OBS。");
  await lock();
  if ((await inspect()).pid) throw new Error("OBS 已重新运行，已取消修复。");
  const excluded = [...settings.instances, ...(settings.candidates || []), ...(settings.archivedCandidates || [])].filter(i => i.id !== item.id).map(i => i.port);
  const port = await freePort(excluded, item.port);
  const filename = path.join(root, "config", "obs-studio", "plugin_config", "obs-websocket", "config.json");
  let previous: Record<string, unknown>;
  try { previous = JSON.parse(await readFile(filename, "utf8")); if (!previous || Array.isArray(previous) || typeof previous !== "object") throw new Error(); }
  catch { throw new Error("OBS 连接配置无法读取，请保留原文件并检查格式和权限。"); }
  const candidate = { ...item, port };
  await copyFile(filename, filename + ".backup-" + randomUUID());
  if ((await inspect()).pid) throw new Error("OBS 已重新运行，已取消修复。");
  const temp = filename + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify({ ...previous, server_enabled: true, auth_required: true, server_port: port, server_password: item.password }));
  await rename(temp, filename);
  return candidate;
}
