/** 已鉴权的直播配置列表和保存入口；元数据留在服务端，应用配置不投递直播命令。 */
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { broadcastProfilesStore } from "@/server/broadcast-profiles";
import { readBroadcastProfiles, editBroadcastProfiles } from "@/core/broadcast-profiles";
import { broadcastProfileCommandSchema, broadcastProfileTargetSchema } from "@/shared/broadcast-profiles";
import { audit } from "@/core/audit";
import { broadcastOptionsSnapshot } from "@/shared/broadcast-options";
import { AppError } from "@/core/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 读取当前登录账号的通用配置；不返回文件路径或其他账号的列表。 */
export async function GET(request: Request) {
  try {
    guard(request); const user = await authenticate(request);
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = broadcastProfileTargetSchema.optional().safeParse(Object.keys(query).length ? query : undefined);
    if (!parsed.success) throw new AppError("INPUT", "旧配置迁入目标格式无效。", 400);
    const store = await broadcastProfilesStore(user, parsed.data);
    return Response.json({ profiles: await readBroadcastProfiles(store) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failed(error); }
}

/** 严格解析短请求并审计动作；不记录配置内容或上游请求。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request);
    const parsed = broadcastProfileCommandSchema.safeParse(await readJson(request, 32 * 1024));
    if (!parsed.success) throw new AppError("INPUT", parsed.error.issues[0]?.message || "直播配置输入无效。", 400);
    const command = parsed.data, store = await broadcastProfilesStore(user, command.target);
    const profiles = await editBroadcastProfiles(store, command.action === "save" ? { ...command, selection: broadcastOptionsSnapshot(command.selection) } : command);
    await audit(user.username, "broadcast-profile-" + command.action, "account", "succeeded");
    return Response.json({ profiles }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failed(error); }
}
