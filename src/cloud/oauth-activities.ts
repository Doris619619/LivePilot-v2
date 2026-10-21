/** OAuth 活动以发起任务身份隔离，取消一个标签页不能释放另一条授权的维护保护。 */
import { unseal } from "@/core/storage";
import { agentStore } from "./agents";
import { transaction } from "./store";
import type { TaskRecord } from "./tasks";
type ActivityState = { token?: string; activities: Record<string, number> };
/** 旧活动键仍可读取，新事务附带任务 ID，互不覆盖租约。 */
export function oauthActivityKey(instanceId: string, taskId?: string) { return "oauth:" + instanceId + (taskId ? ":" + taskId : ""); }
/** 调用方持 tasks.lock；凭事务 ID 或加密回执的 Cookie 找到确切 begin，兼容旧单租约。 */
export function clearOAuthActivity(state: ActivityState, instanceId: string, records: TaskRecord[], taskId?: string, cookie?: string) {
  const begins = records.filter(record => record.kind === "oauth-begin" && record.instanceId === instanceId);
  const begin = taskId ? begins.find(record => record.id === taskId) : begins.find(record => record.result && unseal<{ cookie?: string }>(record.result).cookie === cookie);
  if (!begin) return;
  delete state.activities[oauthActivityKey(instanceId, begin.id)];
  // 旧版本只存一个租约；仅最新 begin 可以释放，旧回调不能抹掉后发事务。
  if (begins.at(-1)?.id === begin.id) delete state.activities[oauthActivityKey(instanceId)];
}
/** 明确取消不依赖设备在线；只清经过浏览器凭据验证的事务活动，不派发任何本机动作。 */
export async function releaseOAuthActivity(agentId: string, instanceId: string, taskId?: string, cookie?: string) {
  const store = agentStore(agentId);
  await transaction(store, async () => {
    const state = await store.read<ActivityState>("maintenance.json"); if (!state) return;
    const queue = await store.read<{ records: TaskRecord[] }>("tasks.json");
    clearOAuthActivity(state, instanceId, queue?.records || [], taskId, cookie);
    await store.write("maintenance.json", state);
  }, "tasks.lock");
}
