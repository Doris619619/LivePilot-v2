/** Agent 能力协商：旧 Cloud 拒绝新增能力时回退，保持原有发布和直播连接可用。 */
import { AppError } from "@/core/errors";
import { PROTOCOL } from "@/shared/remote";
import type { Transport } from "./transport";
type SessionInput = { bootId: string; instances: { id: string; name: string }[]; maintenance?: string };
type SessionResult = { session: string; protocol?: number; capabilities?: string[] };
/** 仅对明确的 400 协议拒绝回退一次；认证、网络和服务器错误仍交给原重连流程。 */
export async function connectSession(transport: Transport, input: SessionInput): Promise<SessionResult> {
  const legacy = ["publishing-v1", "publishing-v2", "publishing-accounts-v1"];
  const body = { protocol: PROTOCOL, ...input };
  try { return await transport.post<SessionResult>("/api/agent/session", { ...body, capabilities: [...legacy, "media-preview-v1"] }); }
  catch (error) {
    if (!(error instanceof AppError) || error.status !== 400) throw error;
    return transport.post<SessionResult>("/api/agent/session", { ...body, capabilities: legacy });
  }
}
