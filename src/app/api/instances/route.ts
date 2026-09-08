/** 所有状态读取均要求有效成员会话。 */
import { authenticate } from "@/server/access";
/** 只返回配置中的实例清单，不触发 OBS 或 YouTube 操作。 */
import { instanceDescriptors } from "@/server/config";
import { guard, failed } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 读取公开实例名称；配置冲突时给出可处理的安全错误。 */
export async function GET(request: Request) {
  try { guard(request); await authenticate(request); return Response.json({ instances: instanceDescriptors() }, { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return failed(e); }
}
