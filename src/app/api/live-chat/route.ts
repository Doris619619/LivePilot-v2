/** 已鉴权的直播聊天设置入口；Cloud 只投递互动配置，环境凭据只由目标 Agent 使用。 */
import { z } from "zod";
import { liveChatConfigSchema, liveChatStatusSchema, chatPreviewInputSchema, chatDecisionSchema, usesChatConversation } from "@/shared/live-chat";
import { idSchema, type TaskPayload } from "@/shared/remote";
import { cloudMode, target, rpc, requireLiveChat, requireChatConversation } from "@/server/remote";
import { authenticate, requireAdmin } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { service } from "@/server/service";
import { audit } from "@/core/audit";
import { AppError } from "@/core/errors";

export const runtime = "nodejs";
const destination = { agentId: idSchema.optional(), instanceId: idSchema };
const schema = z.discriminatedUnion("action", [
  z.object({ ...destination, action: z.literal("read") }).strict(),
  z.object({ ...destination, action: z.literal("configure"), config: liveChatConfigSchema }).strict(),
  z.object({ ...destination, action: z.literal("preview"), input: chatPreviewInputSchema }).strict(),
]);
/** 配置保存不占开播锁；仅审计动作与目标，不记录 Key、提示词或观众消息。 */
export async function POST(request: Request) {
  try {
    guard(request, true);
    const user = await authenticate(request);
    if (!cloudMode()) requireAdmin(user);
    const parsed = schema.safeParse(await readJson(request, 32 * 1024));
    if (!parsed.success) throw new AppError("INPUT", "请检查目标实例、互动风格和 5–60 秒间隔。");
    const body = parsed.data;
    let result: unknown;
    if (cloudMode()) {
      const selected = target(body);
      await authorizeAgent(user, selected.agentId);
      await requireLiveChat(selected);
      if (body.action === "preview" || body.action === "configure" && usesChatConversation(body.config)) await requireChatConversation(selected);
      const payload: TaskPayload = body.action === "read" ? { kind: "live-chat-read" } : body.action === "preview" ? { kind: "live-chat-preview", input: body.input } : { kind: "live-chat-configure", config: body.config };
      result = await rpc(selected, user.username, payload);
      if (body.action !== "read") await audit(user.username, "live-chat-" + body.action, selected.instanceId, "succeeded", selected.agentId);
    } else {
      const app = service(body.instanceId);
      result = body.action === "preview" ? await app.chatPreview.run(body.input) : body.action === "configure" ? await app.configureChat(body.config) : await app.chat.status();
      if (body.action !== "read") await audit(user.username, "live-chat-" + body.action, body.instanceId, "succeeded");
    }
    return Response.json(body.action === "preview" ? chatDecisionSchema.parse(result) : liveChatStatusSchema.parse(result), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failed(error); }
}
