/** 专用设备接口：独立 Bearer 认证，不接受浏览器会话或任意业务调用。 */
import { accountAiEnvironment } from "@/server/account-ai";
import { authenticate } from "@/server/access";
import { problemSchema } from "@/shared/problems";
import { z } from "zod";
import { publishingReportSchema, publishingAccountReportSchema } from "@/shared/publishing";
import { aiKeySchema } from "@/shared/broadcast-ai";
import { agentPublishingAccounts, claimPublishingAccount, syncPublishingAccounts } from "@/cloud/publishing-accounts";
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
import { instanceInventory, renameInstance, retireInstance } from "@/cloud/instance-inventory";
import { pollPreview, acceptPreview } from "@/cloud/preview-relay";
import { admitYouTube, reportYouTubeResult } from "@/cloud/youtube-usage";
import { ingestYouTubeUsage } from "@/cloud/youtube-usage-events";
import { youtubeAdmitSchema, youtubeResultSchema, youtubeUsageBatchSchema } from "@/shared/youtube-usage";
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
    if (route.join("/") === "media-preview/poll") {
      const deadline = Date.now() + 15_000;
      do { await authenticateAgent(request); const requests = pollPreview(agent.id); if (requests.length) return Response.json({ requests }, { headers: { "Cache-Control": "no-store" } }); if (request.signal.aborted) break; await sleep(200); } while (Date.now() < deadline);
      return Response.json({ requests: [] }, { headers: { "Cache-Control": "no-store" } });
    }
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
    guardAgent(request); const route = (await context.params).path.join("/");
    if (route.startsWith("media-preview/")) { const agent = await authenticateAgent(request); await acceptPreview(agent.id, uuidSchema.parse(route.slice("media-preview/".length)), request); return Response.json({ ok: true }); }
    const raw = await readJson(request, 2 * 1024 * 1024);
    if (route === "pair") {
      const value = z.object({ protocol: z.literal(PROTOCOL), agentId: idSchema, code: z.string().length(64), token: z.string().length(64), currentAgentId: idSchema.optional() }).strict().parse(raw);
      const customer = await authenticate(request, true);
      return Response.json(await pairAgent(value.agentId, value.code, value.token, value.currentAgentId, customer.username));
    }
    const agent = await authenticateAgent(request, !["session", "instance-inventory"].includes(route));
    // 只读库存可在会话建立前核对；仍要求当前设备 Bearer，任何写入仍要求有效会话。
    if (route === "instance-inventory") { z.object({}).strict().parse(raw); return Response.json(await instanceInventory(agent.id), { headers: { "Cache-Control": "no-store" } }); }
    if (route === "youtube-quota/admit") return Response.json(await admitYouTube(agent.id, youtubeAdmitSchema.parse(raw)), { headers: { "Cache-Control": "no-store" } });
    if (route === "youtube-quota/result") return Response.json(await reportYouTubeResult(agent.id, youtubeResultSchema.parse(raw)), { headers: { "Cache-Control": "no-store" } });
    if (route === "youtube-usage") return Response.json(await ingestYouTubeUsage(agent.id, youtubeUsageBatchSchema.parse(raw).events), { headers: { "Cache-Control": "no-store" } });
    // 部署环境的 AI Key 仅交给已配对且持有有效会话的 Agent，不接受浏览器或缓存。
    if (route === "account-ai-environment") {
      z.object({}).strict().parse(raw);
      if (!agent.owner) throw new AppError("OWNER", "设备尚未分配账号。", 403);
      return Response.json(await accountAiEnvironment(agent.owner), { headers: { "Cache-Control": "no-store" } });
    }
    if (route === "live-chat-environment") {
      z.object({}).strict().parse(raw);
      const apiKey = aiKeySchema.safeParse(process.env.DEEPSEEK_API_KEY?.trim());
      return Response.json(apiKey.success ? { apiKey: apiKey.data } : {}, { headers: { "Cache-Control": "no-store" } });
    }
    if (route === "publishing/sync") { const v = z.object({ reports: z.array(publishingReportSchema).max(32), busy: z.boolean(), accounts: z.array(publishingAccountReportSchema).max(1000).optional() }).strict().parse(raw); const acknowledged = await reportPublishing(agent.id, v.reports); const accounts = v.accounts ? await syncPublishingAccounts(agent.id, v.accounts) : await agentPublishingAccounts(agent.id); await agentStore(agent.id).write("publishing-runtime.json", { busy: v.busy, at: Date.now() }); return Response.json({ acknowledged, accounts, cleanups: await publishingCleanups(agent.id) }); }
    if (route === "publishing/accounts-binding") { const v = z.object({ accountId: uuidSchema, instanceId: idSchema, channelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), channel: z.string().min(1).max(200), channelCheckedAt: z.number().nonnegative().optional(), authorizationEpoch: uuidSchema.optional(), authorizationGeneration: uuidSchema.optional(), confirm: z.boolean() }).strict().parse(raw); return Response.json(await claimPublishingAccount(agent.id, v.accountId, v.instanceId, v.channelId, v.channel, v.confirm, v.channelCheckedAt, { epoch: v.authorizationEpoch, generation: v.authorizationGeneration })); }
    if (route === "publishing/quota") { const v = z.object({ id: uuidSchema, receipt: uuidSchema, units: z.number().int().min(0).max(400), upload: z.boolean() }).strict().parse(raw); return Response.json(await chargePublishing(agent.id, v.id, v.receipt, v.units, v.upload)); }
    if (route === "publishing/cleanup") { const v = z.object({ id: uuidSchema }).strict().parse(raw); return Response.json(await completePublishingCleanup(agent.id, v.id)); }
    // 维护同样要求既有的有效会话，桌面通过 Agent IPC 调用。
    if (route === "maintenance-begin") { const value = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), verifiedIdle: z.object({ instanceId: idSchema, observedAt: z.number(), basis: z.enum(["obs-status", "process-stopped"]) }).strict().optional() }).strict().parse(raw); return Response.json(await beginMaintenance(agent.id, value.token, value.verifiedIdle)); }
    if (route === "instance-rename") { const value = z.object({ id: idSchema, name: z.string().trim().min(1).max(80) }).strict().parse(raw); return Response.json(await renameInstance(agent.id, value.id, value.name)); }
    if (route === "instance-retire") { const value = z.object({ id: idSchema, token: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw); return Response.json(await retireInstance(agent.id, value.id, value.token)); }
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
      return Response.json({ clientId: c.clientId, clientSecret: c.clientSecret, youtubeProject: "current-project" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (route === "session") {
      const value = z.object({ protocol: z.literal(PROTOCOL), bootId: uuidSchema, instances: z.array(z.object({ id: idSchema, name: z.string().min(1).max(80) }).strict()).min(1).max(64), maintenance: z.string().regex(/^[a-f0-9]{64}$/).optional(), capabilities: z.array(z.enum(["publishing-v1", "publishing-v2", "publishing-accounts-v1", "media-preview-v1", "publishing-consent-v2", "publishing-recovery-v1", "youtube-quota-v1", "youtube-usage-v1", "publishing-auth-generation-v1"])).max(9).optional() }).strict().parse(raw);
      if (new Set(value.instances.map(i => i.id)).size !== value.instances.length) throw new AppError("INSTANCE", "实例清单包含重复 ID。");
      // 仅在设备身份通过认证且持有已登记维护凭据时恢复中断的清单事务。
      if (value.maintenance) await changeMaintenance(agent.id, value.maintenance, value.instances, true);
      const session = await openSession(agent.id, value.bootId, value.instances); await agentStore(agent.id).write("capabilities.json", value.capabilities || []);
      return Response.json({ ...session, capabilities: ["problem-v1", "publishing-v1", "publishing-v2", "publishing-accounts-v1", "live-chat-v1", "media-preview-v1", "account-ai-v1", "youtube-quota-v1", "youtube-usage-v1", "publishing-auth-generation-v1"] });
    }
    if (route === "heartbeat") {
      const value = z.object({ protocol: z.literal(PROTOCOL), snapshots: z.array(snapshotSchema).max(64), problems: z.array(problemSchema).max(128).optional(), reports: z.array(reportSchema).max(32) }).strict().parse(raw);
      const acknowledged = await reportTasks(agent.id, value.reports);
      await heartbeatAgent(agent.id, agent.session!, value.snapshots, value.problems);
      return Response.json({ acknowledged });
    }
    if (route === "bindings") {
      const value = z.object({ instanceId: idSchema, channelId: z.string().min(1).max(128), confirm: z.boolean(), claimId: uuidSchema.optional() }).strict().parse(raw);
      return Response.json(await claimChannel({ agentId: agent.id, instanceId: value.instanceId }, value.channelId, value.confirm, value.claimId));
    }
    throw new AppError("ROUTE", "设备接口不存在。", 404);
  } catch (e) { if (e instanceof z.ZodError) return failed(new AppError("PROTOCOL", "设备协议不匹配或请求无效。")); return failed(e); }
}
