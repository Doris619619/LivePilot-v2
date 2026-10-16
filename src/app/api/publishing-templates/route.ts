/** 账号通用视频配置包 API；不授予设备控制权，不投递发布任务。 */
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { readPublishingTemplates, savePublishingTemplate } from "@/server/publishing-templates";
import { publishingTemplateSchema } from "@/shared/publishing-template";
import { AppError } from "@/core/errors";
import { audit } from "@/core/audit";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 只返回当前登录账号的模板，不接受用户切换参数。 */
export async function GET(request: Request) {
  try { guard(request); const user = await authenticate(request); return Response.json({ profiles: await readPublishingTemplates(user) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failed(error); }
}
/** 同源、结构和并发检查后保存，错误时保留旧版本。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request);
    const parsed = publishingTemplateSchema.safeParse(await readJson(request, 32 * 1024));
    if (!parsed.success) throw new AppError("INPUT", parsed.error.issues[0]?.message || "视频配置无效。", 400);
    const result = await savePublishingTemplate(user, parsed.data);
    await audit(user.username, "publishing-template-save", "account", "succeeded");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failed(error); }
}
