/** 未验证 OBS 独立保存为候选；撤销只归档配置，不删除文件、身份或已登记实例。 */
import { AppError } from "../src/core/errors";
import type { Settings } from "./settings";
import type { DesktopInstance } from "../src/shared/desktop";
/** 未结退役拥有唯一恢复记录；候选晋升和清单修改不能越过它创建第二笔库存事务。 */
export function assertInventorySettled(settings: Settings) {
  if (settings.retirementPending) throw new AppError("MAINTENANCE", "请先恢复上次退役：点击重新连接并恢复，核对原实例后再修改 OBS 配置。", 409);
}
/** 兼容旧版初始化失败留下的实例，成功实例及频道 ID 始终保留。 */
export function separateCandidates(settings: Settings) {
  settings.candidates ||= [];
  for (const item of settings.instances.filter(i => !i.initialized)) {
    if (!settings.candidates.some(i => i.id === item.id)) settings.candidates.push(item);
  }
  settings.instances = settings.instances.filter(i => i.initialized);
}
/** 候选仅在本地验证成功后晋升；云端提交失败仍保留这份可重试清单。 */
export function acceptCandidate(settings: Settings, candidate: DesktopInstance) {
  assertInventorySettled(settings);
  candidate.initialized = true;
  if (!settings.instances.some(i => i.id === candidate.id)) settings.instances.push(candidate);
  settings.candidates = settings.candidates?.filter(i => i.id !== candidate.id);
}
/** 归档而非删除候选，恢复旧设备不依赖失败候选的 WebSocket。 */
export function archiveCandidate(settings: Settings, id: string) {
  const item = settings.candidates?.find(i => i.id === id);
  if (!item) throw new AppError("DESKTOP", "待配置 OBS 不存在，已登记的实例不能撤销。");
  (settings.archivedCandidates ||= []).push(item);
  settings.candidates = settings.candidates?.filter(i => i.id !== id);
}
