/** 带实例 ID 的控制命令入口；保留同源校验及严格输入边界。 */
import { z } from "zod";
import { service } from "@/server/service";
import { guard, failed } from "@/server/http";
import { AppError } from "@/server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.discriminatedUnion("action", [
  z.object({ instanceId: z.string().min(1).max(32), action: z.literal("start"), video: z.string().min(1).max(255), music: z.string().min(1).max(255), videoAudio: z.boolean() }).strict(),
  z.object({ instanceId: z.string().min(1).max(32), action: z.literal("stop") }).strict(),
  z.object({ instanceId: z.string().min(1).max(32), action: z.literal("launch") }).strict(),
  z.object({ instanceId: z.string().min(1).max(32), action: z.literal("clear-uncertain"), confirmed: z.literal(true) }).strict(),
]);
/** 执行目标实例命令；操作失败仅使该实例进入可恢复状态。 */
export async function POST(request: Request) {
  try {
    guard(request, true);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError("INPUT", "请求必须是 JSON。");
    const text = await request.text();
    if (text.length > 4096) throw new AppError("INPUT", "请求过大。");
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new AppError("INPUT", "JSON 格式无效。"); }
    const parsed = input.safeParse(json);
    if (!parsed.success) throw new AppError("INPUT", "请选择有效的视频、音乐和原声选项。");
    const data = parsed.data;
    const app = service(data.instanceId);
    try {
      if (data.action === "start") await app.control.start({ video: data.video, music: data.music, videoAudio: data.videoAudio });
      else if (data.action === "stop") await app.control.stop();
      else if (data.action === "launch") await app.control.launch();
      else await app.control.clearUncertain();
    } finally { app.invalidate(); }
    return Response.json({ ok: true });
  } catch (e) { return failed(e); }
}
