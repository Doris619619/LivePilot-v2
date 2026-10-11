/** 已配对 Agent 从受认证控制端同步聊天环境密钥；只注入本进程，不回传 IPC 或写入实例密钥文件。 */
import { z } from "zod";
import { aiKeySchema } from "@/shared/broadcast-ai";
import { AppError } from "@/core/errors";
import type { Service } from "@/core/service";
import type { Transport } from "./transport";

const environmentSchema = z.object({ apiKey: aiKeySchema.optional() }).strict();
const unavailable = "AI互动环境暂时不可用，请稍后重试。";
const environments = new WeakMap<Pick<Transport, "post">, { original?: string; cloudProvided: boolean; pendingRefresh: Set<Service> }>();

/** 会话和心跳共用同步调度；失败退避、成功每分钟复查，同一时刻至多一个请求。 */
export class LiveChatEnvironmentSync {
  private supported = false;
  private nextAt = 0;
  private failures = 0;
  private pending?: Promise<void>;
  /** 同步端口不记录原始错误；报告只传成功与失败，凭据不离开同步函数。 */
  constructor(private sync: () => Promise<void>, private report: (failed: boolean) => void, private now = Date.now) {}
  /** 新会话立即允许检查；旧 Cloud 不调用新路由。 */
  connect(supported: boolean) { this.supported = supported; this.nextAt = 0; }
  /** 心跳调用不等待此请求；重入复用在途任务，网络故障不阻断既有广播控制。 */
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.supported || this.now() < this.nextAt) return Promise.resolve();
    this.pending = this.sync().then(() => {
      this.failures = 0; this.nextAt = this.now() + 60_000; this.report(false);
    }, () => {
      this.failures++; this.nextAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5)); this.report(true);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** 退出禁用新请求，并等在途同步结束后再关闭聊天运行器。 */
  async stop() { this.supported = false; await this.pending; }
}

/** 调用方先核对 Cloud 能力；记录首次本机环境，Cloud 撤销后恢复它，同 Key 不取消聊天。 */
export async function syncLiveChatEnvironment(transport: Pick<Transport, "post">, services: Iterable<Service>): Promise<void> {
  try {
    let environment = environments.get(transport);
    if (!environment) { environment = { original: process.env.DEEPSEEK_API_KEY, cloudProvided: false, pendingRefresh: new Set() }; environments.set(transport, environment); }
    const parsed = environmentSchema.safeParse(await transport.post<unknown>("/api/agent/live-chat-environment", {}));
    if (!parsed.success) throw new AppError("CHAT_ENVIRONMENT", unavailable, 503);
    const key = parsed.data.apiKey;
    if (!key && !environment.cloudProvided && !environment.pendingRefresh.size) return;
    const next = key ?? environment.original; const current = process.env.DEEPSEEK_API_KEY;
    environment.cloudProvided = !!key;
    if (next === undefined) delete process.env.DEEPSEEK_API_KEY;
    else if (!key || next !== current?.trim()) process.env.DEEPSEEK_API_KEY = next;
    if (next?.trim() !== current?.trim()) for (const service of services) environment.pendingRefresh.add(service);
    // 某个实例刷新失败后，即使环境 Key 相同，下一次仍必须补齐该实例。
    const pending = environment.pendingRefresh;
    const results = await Promise.allSettled([...pending].map(async service => { await service.refreshChatCredentials(); pending.delete(service); }));
    if (results.some(result => result.status === "rejected")) throw new AppError("CHAT_ENVIRONMENT", unavailable, 503);
  } catch {
    // 上游响应、验证细节及实例异常都不能把密钥带入日志或公开错误。
    throw new AppError("CHAT_ENVIRONMENT", unavailable, 503);
  }
}
