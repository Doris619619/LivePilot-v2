/** 管理员预算及首次历史基线设置：同源写保护并记录业务审计。 */
import { failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { updateYouTubePolicy } from "@/cloud/youtube-usage";
import { youtubePolicyUpdateSchema } from "@/shared/youtube-usage";
import { youtubeAdmin } from "../http";
export const runtime = "nodejs";
/** 仅更新应用政策和历史基线，不能手工清除真实Google quota熔断。 */
export async function PUT(request: Request) { try { const user = await youtubeAdmin(request, true); const value = youtubePolicyUpdateSchema.parse(await readJson(request, 16_384)); return Response.json(await updateYouTubePolicy(value, user.username), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failed(error); } }
