/** 专用设备接口：独立 Bearer 认证，不接受浏览器会话或任意业务调用。 */
import { z } from "zod";
import { PROTOCOL, idSchema, uuidSchema, reportSchema } from "@/shared/remote";
import { snapshotSchema } from "@/shared/remote-validation";
import { cloudMode, config } from "@/core/config";
import { AppError, sleep } from "@/core/errors";
import { readJson } from "@/server/request-body";
import { failed } from "@/server/http";
import { authenticateAgent, pairAgent, openSession, heartbeatAgent } from "@/cloud/agents";
import { pollTasks, reportTasks } from "@/cloud/tasks";
import { claimChannel } from "@/cloud/bindings";
import { downloadSlot } from "@/cloud/relay";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ path: string[] }> };
/** Agent 使用专用凭据，固定 Host 并拒绝来自网页的 Origin。 */
function guardAgent(request: Request) {
  if (!cloudMode()) throw new AppError("MODE", "此入口仅在云端启用。", 404);
  if (request.headers.get("host") !== new URL(config().origin).host || request.headers.has("origin")) throw new AppError("HOST", "设备请求来源无效。", 403);
}
/** 长轮询仅等待短任务；未收到任务时 20 秒返回，独立心跳照常运行。 */
export async function GET(request: Request, context: Context) {
  try {
    guardAgent(request); const agent = await authenticateAgent(request); const route = (await context.params).path;
    if (route.length === 2 && route[0] === "chunks") return downloadSlot(agent.id, uuidSchema.parse(route[1]));
    if (route.join("/") !== "poll") throw new AppError("ROUTE", "设备接口不存在。", 404);
    const deadline = Date.now() + 20_000;
    do {
      await authenticateAgent(request); const tasks = await pollTasks(agent.id);
      if (tasks.length) return Response.json({ protocol: PROTOCOL, tasks });
      if (request.signal.aborted) break; await sleep(500);
    } while (Date.now() < deadline);
    return Response.json({ protocol: PROTOCOL, tasks: [] });
  } catch (e) { return failed(e); }
}
/** 配对、建立会话、心跳和频道归属均有独立输入白名单。 */
export async function POST(request: Request, context: Context) {
  try {
    guardAgent(request); const route = (await context.params).path.join("/"); const raw = await readJson(request, 2 * 1024 * 1024);
    if (route === "pair") {
      const value = z.object({ protocol: z.literal(PROTOCOL), agentId: idSchema, code: z.string().length(64), token: z.string().length(64) }).strict().parse(raw);
      return Response.json(await pairAgent(value.agentId, value.code, value.token));
    }
    const agent = await authenticateAgent(request, route !== "session");
    if (route === "session") {
      const value = z.object({ protocol: z.literal(PROTOCOL), bootId: uuidSchema, instances: z.array(z.object({ id: idSchema, name: z.string().min(1).max(80) }).strict()).min(1).max(64) }).strict().parse(raw);
      if (new Set(value.instances.map(i => i.id)).size !== value.instances.length) throw new AppError("INSTANCE", "实例清单包含重复 ID。");
      return Response.json(await openSession(agent.id, value.bootId, value.instances));
    }
    if (route === "heartbeat") {
      const value = z.object({ protocol: z.literal(PROTOCOL), snapshots: z.array(snapshotSchema).max(64), reports: z.array(reportSchema).max(32) }).strict().parse(raw);
      const acknowledged = await reportTasks(agent.id, value.reports);
      await heartbeatAgent(agent.id, agent.session!, value.snapshots);
      return Response.json({ acknowledged });
    }
    if (route === "bindings") {
      const value = z.object({ instanceId: idSchema, channelId: z.string().min(1).max(128), confirm: z.boolean() }).strict().parse(raw);
      await claimChannel({ agentId: agent.id, instanceId: value.instanceId }, value.channelId, value.confirm); return Response.json({ ok: true });
    }
    throw new AppError("ROUTE", "设备接口不存在。", 404);
  } catch (e) { if (e instanceof z.ZodError) return failed(new AppError("PROTOCOL", "设备协议不匹配或请求无效。")); return failed(e); }
}
