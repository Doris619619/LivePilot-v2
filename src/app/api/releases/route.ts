/** 公开历史版本列表，不要求客户登录；请求参数只能选择有限分页。 */
import { releaseHistory } from "@/server/releases";
export const runtime = "nodejs";
/** 上游失败保留明确重试入口，正常结果允许短期公共缓存。 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("page") || "1";
  if (!/^[1-9]\d{0,2}$/.test(raw)) return Response.json({ error: "页码无效。" }, { status: 400 });
  try { return Response.json(await releaseHistory(Number(raw)), { headers: { "Cache-Control": "public, max-age=60" } }); }
  catch { return Response.json({ error: "历史版本暂未读取，请重试或打开官方发行记录。" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
