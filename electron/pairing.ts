/** 桌面配对事务：邀请只授权本次连接，已登记电脑始终保留原身份和本地配置。 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DESKTOP_ORIGIN } from "../src/shared/desktop";
import { idSchema } from "../src/shared/remote";
import type { Settings } from "./settings";
const invitationSchema = z.object({ origin: z.literal(DESKTOP_ORIGIN), agentId: idSchema, code: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** 请求前落盘随机凭据；响应丢失复用同一凭据重试，不换密钥、不迁移 OBS。 */
export async function pairDesktop(settings: Settings, invitation: unknown, save: () => Promise<void>, request: (url: string, init: RequestInit) => Promise<Response>) {
  if (typeof invitation !== "string" || invitation.length > 4096 || !invitation.trim().startsWith("LN1.")) throw new Error("请粘贴网页复制的完整配对码。");
  let value: z.infer<typeof invitationSchema>;
  try { value = invitationSchema.parse(JSON.parse(Buffer.from(invitation.trim().slice(4), "base64url").toString("utf8"))); } catch { throw new Error("配对码无效，请重新复制网页生成的配对码。"); }
  if (settings.identity && settings.identity.origin !== value.origin) throw new Error("网页地址与原配置不一致，原配置已保留。");
  settings.identity ||= { agentId: value.agentId, origin: value.origin, token: randomBytes(32).toString("hex") }; await save();
  const identity = settings.identity; const different = identity.agentId !== value.agentId;
  let response: Response;
  try { response = await request(value.origin + "/api/agent/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocol: 1, agentId: value.agentId, code: value.code, token: identity.token, currentAgentId: identity.agentId }), redirect: "error", signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error("连接结果尚未确认，请用同一个配对码重试。原配置已保留。"); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 ? "配对码无效、过期或已使用，请在网页生成新码后重试。" : "配对未完成，请确认网页已更新后重试。原配置已保留。"); }
  const result = z.object({ protocol: z.literal(1), agentId: idSchema.optional() }).safeParse(await response.json().catch(() => null));
  if (!result.success || (different && !result.data.agentId)) throw new Error("网页未确认配对结果，请更新网页服务后重试。原配置已保留。");
  const resolvedId = result.data.agentId || value.agentId;
  if (resolvedId !== identity.agentId && settings.paired) throw new Error("网页返回了不同设备，未覆盖原身份或授权。");
  // 只有从未完成登记的临时 ID 可改为新邀请 ID；随机凭据和加密密钥始终沿用。
  identity.agentId = resolvedId; settings.paired = true; await save();
}
