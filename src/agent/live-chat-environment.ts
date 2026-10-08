/** 已配对 Agent 从受认证控制端同步聊天环境密钥；只注入本进程，不回传 IPC 或写入实例密钥文件。 */
import { z } from "zod";
import { aiKeySchema } from "@/shared/broadcast-ai";
import { AppError } from "@/core/errors";
import type { Service } from "@/core/service";
import type { Transport } from "./transport";

const environmentSchema = z.object({ apiKey: aiKeySchema.optional() }).strict();
const unavailable = "AI互动环境暂时不可用，请稍后重试。";
const environments = new WeakMap<Pick<Transport, "post">, { original?: string; cloudProvided: boolean }>();

/** 调用方先核对 Cloud 能力；记录首次本机环境，Cloud 撤销后恢复它，同 Key 不取消聊天。 */
export async function syncLiveChatEnvironment(transport: Pick<Transport, "post">, services: Iterable<Service>): Promise<void> {
  try {
    let environment = environments.get(transport);
    if (!environment) { environment = { original: process.env.DEEPSEEK_API_KEY, cloudProvided: false }; environments.set(transport, environment); }
    const parsed = environmentSchema.safeParse(await transport.post<unknown>("/api/agent/live-chat-environment", {}));
    if (!parsed.success) throw new AppError("CHAT_ENVIRONMENT", unavailable, 503);
    const key = parsed.data.apiKey;
    if (!key && !environment.cloudProvided) return;
    const next = key ?? environment.original; const current = process.env.DEEPSEEK_API_KEY;
    environment.cloudProvided = !!key;
    if (next === undefined) delete process.env.DEEPSEEK_API_KEY;
    else if (!key || next !== current?.trim()) process.env.DEEPSEEK_API_KEY = next;
    if (next?.trim() === current?.trim()) return;
    const results = await Promise.allSettled([...services].map(service => service.refreshChatCredentials()));
    if (results.some(result => result.status === "rejected")) throw new AppError("CHAT_ENVIRONMENT", unavailable, 503);
  } catch {
    // 上游响应、验证细节及实例异常都不能把密钥带入日志或公开错误。
    throw new AppError("CHAT_ENVIRONMENT", unavailable, 503);
  }
}
