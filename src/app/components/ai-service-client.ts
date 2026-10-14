/** 文案服务的浏览器请求只投递到选定实例；密钥不写入浏览器存储。 */
"use client";
import type { InstanceDescriptor } from "@/shared/types";
import { api } from "../client-request";

/** 状态查询和保存复用既有 Agent 协议；保存成功不等于服务商连接验证成功。 */
export function aiServiceRequest<T>(instance: Pick<InstanceDescriptor, "id" | "agentId">, action: "ai-status" | "ai-key" | "ai-generate", input: { apiKey?: string; brief?: string } = {}, signal?: AbortSignal) {
  return api<T>("/api/broadcast-assets", {
    method: "POST", timeoutMs: 60_000, signal,
    headers: { "Content-Type": "application/json", "X-LivePilot": "1" },
    body: JSON.stringify({ action, instanceId: instance.id, ...(instance.agentId ? { agentId: instance.agentId } : {}), ...input }),
  });
}
