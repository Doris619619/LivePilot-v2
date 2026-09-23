/** 桌面独立 Bearer 会话；固定云端 Host，不接受浏览器 Origin 或管理员身份。 */
import { z } from "zod";
import { authenticate, login, logout } from "@/server/access";
import { authorizeAgent } from "@/server/ownership";
import { config } from "@/core/config";
import { AppError } from "@/core/errors";
import { failed } from "@/server/http";
import { readJson } from "@/server/request-body";
export const runtime = "nodejs";
/** 桌面主进程通过 HTTPS 调用；不为网页设置 Cookie。 */
function guard(request: Request) { if (request.headers.get("host") !== new URL(config().origin).host || request.headers.has("origin")) throw new AppError("ORIGIN", "桌面登录来源无效。", 403); }
/** 已配对电脑只能由其客户查看和配置。 */
export async function GET(request: Request) { try { guard(request); const user = await authenticate(request, true); const id = new URL(request.url).searchParams.get("agentId"); if (id) await authorizeAgent(user, id); return Response.json({ user }, { headers: { "Cache-Control": "no-store" } }); } catch(e) { return failed(e); } }
/** 密码校验和限速复用网页账号库。 */
export async function POST(request: Request) { try { guard(request); const v = z.object({ username: z.string().regex(/^[A-Za-z0-9_]{2,32}$/), password: z.string().min(1).max(256) }).strict().parse(await readJson(request)); return Response.json(await login(v.username, v.password, true), { headers: { "Cache-Control": "no-store" } }); } catch(e) { return failed(e instanceof z.ZodError ? new AppError("INPUT", "请输入账号和密码。") : e); } }
/** 只撤销 UI 会话，设备凭据和直播继续有效。 */
export async function DELETE(request: Request) { try { guard(request); await logout(request, true); return Response.json({ ok: true }); } catch(e) { return failed(e); } }
