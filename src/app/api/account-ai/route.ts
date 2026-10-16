/** 当前登录账号的 AI 设置；不支持用请求参数代改其他账号，也不回显密钥。 */
import { authenticate } from "@/server/access";
import { accountAiStatus, saveAccountAi } from "@/server/account-ai";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 读取账号公开配置，禁用响应缓存。 */
export async function GET(request: Request) { try { guard(request); const user = await authenticate(request); return Response.json(await accountAiStatus(user.username), { headers: { "Cache-Control": "no-store" } }); } catch (e) { return failed(e); } }
/** 保存加密密钥和用途开关，离线设备在下次同步时接收。 */
export async function POST(request: Request) { try { guard(request, true); const user = await authenticate(request); return Response.json(await saveAccountAi(user.username, await readJson(request, 4096)), { headers: { "Cache-Control": "no-store" } }); } catch (e) { return failed(e); } }
