/** 已授权网页读取频道播放列表或向选定 Agent 上传开播封面。 */
import { z } from "zod";
import { aiBriefSchema, aiKeySchema } from "@/shared/broadcast-ai";
import { aiStatus, saveAiKey, generateCopy } from "@/core/broadcast-ai";
import type { TaskPayload } from "@/shared/remote";
import { cloudMode, target, rpc, requireBroadcastDetails } from "@/server/remote";
import { authenticate, requireAdmin } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { service } from "@/server/service";
import { config } from "@/core/config";
import { Store } from "@/core/storage";
import { saveThumbnail } from "@/core/broadcast-assets";
import { thumbnailInputSchema } from "@/shared/broadcast";
import { AppError } from "@/core/errors";
import { audit } from "@/core/audit";
export const runtime = "nodejs";
const base = { agentId: z.string().optional(), instanceId: z.string().min(1).max(32) };
const schema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("ai-status") }).strict(),
  z.object({ ...base, action: z.literal("ai-key"), apiKey: aiKeySchema }).strict(),
  z.object({ ...base, action: z.literal("ai-generate"), brief: aiBriefSchema }).strict(),
  z.object({ ...base, action: z.literal("playlists") }).strict(),
  z.object({ ...base, action: z.literal("thumbnail"), input: thumbnailInputSchema }).strict(),
]);
/** 先鉴权再解析受限图片；云端只投递，YouTube 凭据和封面持久文件均在 Agent。 */
export async function POST(request: Request) {
  try {
    guard(request, true);
    const user = await authenticate(request); if (!cloudMode()) requireAdmin(user);
    const parsed = schema.safeParse(await readJson(request, 3 * 1024 ** 2));
    if (!parsed.success) throw new AppError("INPUT", "请检查目标实例、关键词、API Key 或封面格式。");
    const body = parsed.data;
    let result: unknown;
    if (cloudMode()) {
      const destination = target(body); await authorizeAgent(user, destination.agentId); await requireBroadcastDetails(destination);
      const payload: TaskPayload = body.action === "ai-status" ? { kind: "broadcast-ai-status" } : body.action === "ai-key" ? { kind: "broadcast-ai-key", apiKey: body.apiKey } : body.action === "ai-generate" ? { kind: "broadcast-ai-generate", brief: body.brief } : body.action === "playlists" ? { kind: "broadcast-playlists" } : { kind: "broadcast-thumbnail", input: body.input };
      result = await rpc(destination, user.username, payload);
    } else {
      const app = service(body.instanceId);
      const storage = new Store(config(body.instanceId).dataDir);
      result = body.action === "ai-status" ? await aiStatus(storage) : body.action === "ai-key" ? await saveAiKey(storage, body.apiKey) : body.action === "ai-generate" ? await generateCopy(storage, body.brief) : body.action === "playlists" ? { playlists: await app.youtube.playlists() } : await saveThumbnail(storage, body.input);
      await audit(user.username, "broadcast-" + body.action, body.instanceId, "succeeded");
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e); }
}
