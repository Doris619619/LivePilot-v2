/** 不含配置和设备信息的进程健康检查，供反向代理与部署验证。 */
export const dynamic = "force-dynamic";
/** 仅证明 HTTP 进程可用，不代表设备在线或直播成功。 */
export async function GET() { return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } }); }
