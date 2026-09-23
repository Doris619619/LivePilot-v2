/** 心跳问题反馈不依赖故障磁盘；旧云端只收到原协议字段。 */
import type { AgentSnapshot, TaskReport } from "../shared/remote";
import { makeProblem, type Problem } from "../shared/problems";
import type { Worker } from "./worker";
/** 剥离仅由 problem-v1 承载的字段，兼容旧云端严格报告 schema。 */
export function legacyFeedback<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item) => ["problem", "problems", "authorization", "query", "processKnown", "verification"].includes(key) ? undefined : item));
}
/** 读取报告失败仍发送心跳及安全问题，不使整台电脑假离线。 */
export async function heartbeatFeedback(worker: Worker, snapshots: AgentSnapshot[], health: Map<string, Problem>, structured: boolean) {
  let reports: TaskReport[] = [];
  try { reports = await worker.reports(); health.delete("reports"); }
  catch { health.set("reports", makeProblem("RESULT_SAVE", "本机任务记录暂不可读取，执行结果待核对。", {source:"agent",stage:"读取操作记录"})); }
  const body = { protocol: 1, snapshots, reports, ...(structured ? { problems: [...health.values(), ...worker.problems.values()].slice(0, 128) } : {}) };
  return structured ? body : legacyFeedback(body);
}

/** 云端接收成功与本机确认落盘分开，磁盘失败不能使设备假离线。 */
export async function acknowledgeFeedback(worker: Worker, ids: string[], health: Map<string, Problem>) {
  try { await worker.acknowledge(ids); health.delete("acknowledge"); }
  catch { health.set("acknowledge",makeProblem("RESULT_SAVE","云端已收到结果，但本机确认记录未能保存。请检查磁盘与权限，不要重复执行操作。",{source:"agent",stage:"保存云端接收确认",outcome:"completed"})); }
}
