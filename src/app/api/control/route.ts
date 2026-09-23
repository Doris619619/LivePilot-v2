/** 登录成员提交幂等命令；先持久化受理再由直播电脑异步执行。 */
import { cloudMode, target, remoteControl } from "@/server/remote";
import { controlSchema } from "@/shared/remote";
import { after } from "next/server";
import { z } from "zod";
import { service } from "@/server/service";
import { authorizeAgent } from "@/server/ownership";
import { authenticate, requireAdmin } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { AppError } from "@/server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
const base = { agentId: z.string().optional(), instanceId: z.string().min(1).max(32), requestId: z.string().uuid() };
const input = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("start"), video: z.string().min(1).max(255), music: z.string().min(1).max(255), videoAudio: z.boolean() }).strict(),
  z.object({ ...base, action: z.literal("stop") }).strict(),
  z.object({ ...base, action: z.literal("launch") }).strict(),
  z.object({ ...base, action: z.literal("clear-uncertain"), confirmed: z.literal(true) }).strict(),
]);
/** 202 只表示受理；最终成功由状态轮询展示，重复请求不重复执行。 */
export async function POST(request: Request) {
  try {
    guard(request, true);
    const user = await authenticate(request); if (!cloudMode()) requireAdmin(user);
    const parsed = input.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("INPUT", "请选择有效实例、媒体和操作，请求必须包含唯一标识。");
    if (cloudMode()) {
      const { agentId, instanceId, requestId, ...input } = parsed.data;
      await authorizeAgent(user, target({ agentId, instanceId }).agentId);
      const result = await remoteControl(target({ agentId, instanceId }), user.username, { kind: "control", input: controlSchema.parse(input) }, requestId);
      return Response.json(result, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    const app = service(parsed.data.instanceId);
    const result = await app.commands.accept(parsed.data, user.username);
    if (result.fresh) after(() => app.commands.run(result.operation.id));
    return Response.json({ operation: result.operation }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
