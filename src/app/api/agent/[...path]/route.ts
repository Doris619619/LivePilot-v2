/** 专用设备接口：独立 Bearer 认证，不接受浏览器会话或任意业务调用。 */
import { authenticate } from "@/server/access";
import { problemSchema } from "@/shared/problems";
import { z } from "zod";
import { publishingReportSchema } from "@/shared/publishing";
import { reportPublishing, chargePublishing, publishingCleanups, completePublishingCleanup } from "@/cloud/publishing";
import { agentStore } from "@/cloud/agents";
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
import { beginMaintenance, changeMaintenance } from "@/cloud/maintenance";
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
      const value = z.object({ protocol: z.literal(PROTOCOL), agentId: idSchema, code: z.string().length(64), token: z.string().length(64), currentAgentId: idSchema.optional() }).strict().parse(raw);
      const customer = await authenticate(request, true);
      return Response.json(await pairAgent(value.agentId, value.code, value.token, value.currentAgentId, customer.username));
    }
    const agent = await authenticateAgent(request, route !== "session");
    if (route === "publishing/sync") { const v = z.object({ reports: z.array(publishingReportSchema).max(32), busy: z.boolean() }).strict().parse(raw); const acknowledged = await reportPublishing(agent.id, v.reports); await agentStore(agent.id).write("publishing-runtime.json", { busy: v.busy, at: Date.now() }); return Response.json({ acknowledged, cleanups: await publishingCleanups(agent.id) }); }
    if (route === "publishing/quota") { const v = z.object({ id: uuidSchema, receipt: uuidSchema, units: z.number().int().min(0).max(400), upload: z.boolean() }).strict().parse(raw); return Response.json(await chargePublishing(agent.id, v.id, v.receipt, v.units, v.upload)); }
    if (route === "publishing/cleanup") { const v = z.object({ id: uuidSchema }).strict().parse(raw); return Response.json(await completePublishingCleanup(agent.id, v.id)); }
    // 维护同样要求既有的有效会话，桌面通过 Agent IPC 调用。
    if (route === "maintenance-begin") { const value = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw); return Response.json(await beginMaintenance(agent.id, value.token)); }
    if (route === "maintenance-end" || route === "instances") {
      const value = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), instances: z.array(z.object({ id: idSchema, name: z.string().min(1).max(80) }).strict()).min(1).max(64).optional() }).strict().parse(raw);
      if ((route === "instances") !== !!value.instances || (value.instances && new Set(value.instances.map(i => i.id)).size !== value.instances.length)) throw new AppError("INPUT", "实例清单无效。");
      return Response.json(await changeMaintenance(agent.id, value.token, value.instances));
    }
    // 桌面初始化沿用现有认证条件，不增加任何免会话路由。
    // 用户要求的 Google 应用配置仅交给已配对且持有有效会话的 Agent，禁止缓存。
    if (route === "bootstrap") {
      z.object({}).strict().parse(raw); const c = config();
      if (!c.clientId || !c.clientSecret) throw new AppError("CONFIG", "云端尚未配置 Google 应用，请联系管理员。", 503);
      return Response.json({ clientId: c.clientId, clientSecret: c.clientSecret }, { headers: { "Cache-Control": "no-store" } });
    }
    if (route === "session") {
      const value = z.object({ protocol: z.literal(PROTOCOL), bootId: uuidSchema, instances: z.array(z.object({ id: idSchema, name: z.string().min(1).max(80) }).strict()).min(1).max(64), maintenance: z.string().regex(/^[a-f0-9]{64}$/).optional(), capabilities: z.array(z.enum(["publishing-v1", "publishing-v2"])).max(2).optional() }).strict().parse(raw);
      if (new Set(value.instances.map(i => i.id)).size !== value.instances.length) throw new AppError("INSTANCE", "实例清单包含重复 ID。");
      // 仅在设备身份通过认证且持有已登记维护凭据时恢复中断的清单事务。
      if (value.maintenance) await changeMaintenance(agent.id, value.maintenance, value.instances, true);
      const session = await openSession(agent.id, value.bootId, value.instances); await agentStore(agent.id).write("capabilities.json", value.capabilities || []);
      return Response.json({ ...session, capabilities: ["problem-v1", "publishing-v1", "publishing-v2"] });
    }
    if (route === "heartbeat") {
      const value = z.object({ protocol: z.literal(PROTOCOL), snapshots: z.array(snapshotSchema).max(64), problems: z.array(problemSchema).max(128).optional(), reports: z.array(reportSchema).max(32) }).strict().parse(raw);
      const acknowledged = await reportTasks(agent.id, value.reports);
      await heartbeatAgent(agent.id, agent.session!, value.snapshots, value.problems);
      return Response.json({ acknowledged });
    }
    if (route === "bindings") {
      const value = z.object({ instanceId: idSchema, channelId: z.string().min(1).max(128), confirm: z.boolean() }).strict().parse(raw);
      await claimChannel({ agentId: agent.id, instanceId: value.instanceId }, value.channelId, value.confirm); return Response.json({ ok: true });
    }
    throw new AppError("ROUTE", "设备接口不存在。", 404);
  } catch (e) { if (e instanceof z.ZodError) return failed(new AppError("PROTOCOL", "设备协议不匹配或请求无效。")); return failed(e); }
}
