/** 浏览器预览会话与逐次鉴权；Cloud 只保存短期公开元信息，流式中转最多一个分片。 */
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticate, cookieValue, SESSION_COOKIE, digest } from "./access";
import { authorizeAgent } from "./ownership";
import { cloudMode } from "./remote";
import { agentStore, requireTarget } from "@/cloud/agents";
import { authorizePublishingAccount, requirePublishingAccount } from "@/cloud/publishing-accounts";
import { requestPreview } from "@/cloud/preview-relay";
import { AppError } from "@/core/errors";
import { audit } from "@/core/audit";
import { PREVIEW_CHUNK, PREVIEW_TTL, previewRange, type PreviewCommand, type PreviewEnvelope, type PreviewSelection, type PreviewState, type PreviewPart } from "@/shared/media-preview";
const checkSchema = z.object({ state: z.enum(["pending", "running", "complete", "failed", "cancelled", "unavailable"]), coverage: z.enum(["sample", "full"]), progress: z.number().min(0).max(100).optional(), sound: z.enum(["absent", "present", "suspected-silent", "unknown"]).optional(), ranges: z.array(z.object({ start: z.number().nonnegative(), duration: z.number().nonnegative() })).max(3).optional(), message: z.string().max(500).optional() });
const fileSchema = z.object({ name: z.string().max(255), size: z.number().int().positive().max(256 * 1024 ** 3), mime: z.string().regex(/^(video|audio|image|application)\/[a-z0-9.+-]+$/), version: z.string().regex(/^[a-f0-9]{64}$/), duration: z.number().positive().optional(), width: z.number().int().nonnegative().optional(), height: z.number().int().nonnegative().optional(), video: z.boolean().optional(), audio: z.boolean().optional(), codec: z.string().max(64).optional(), check: checkSchema.optional() });
const stateSchema = z.object({ files: z.object({ video: fileSchema.optional(), music: fileSchema.optional(), cover: fileSchema.optional(), final: fileSchema.optional() }), busy: z.boolean(), operation: z.enum(["quick", "check", "prepare"]).optional(), expires: z.number(), message: z.string().max(500).optional(), error: z.string().max(500).optional() });
type Session = { id: string; login: string; selection: PreviewSelection; expires: number; state?: PreviewState };
const globalSessions = globalThis as typeof globalThis & { browserPreviews?: Map<string, Session> };
const sessions: Map<string, Session> = globalSessions.browserPreviews ||= new Map<string, Session>();
/** 撤销只能减少能力；即使登录/设备权限已撤销，仍尽力停止原会话的 Agent 检查。 */
function revoke(session: Session) {
  sessions.delete(session.id); const { agentId, instanceId, accountId, channelId } = session.selection; const target = { agentId, instanceId, accountId, channelId };
  void requestPreview({ session: session.id, expires: session.expires, target, action: "close" }).catch(() => {});
}
/** 每次读取都重验账户、设备、独立频道和 Agent 能力，包括长响应的每个分片。 */
async function authorize(request: Request, selection: PreviewSelection) {
  const user = await authenticate(request);
  if (!cloudMode()) throw new AppError("PREVIEW_MODE", "请从 Cloud 工作台预览已连接设备的素材。", 409);
  await authorizeAgent(user, selection.agentId); await requireTarget(selection.agentId, selection.instanceId, true);
  if (!(await agentStore(selection.agentId).read<string[]>("capabilities.json"))?.includes("media-preview-v1")) throw new AppError("AGENT_VERSION", "请升级这台设备的 Agent 后使用素材预览。", 409);
  if (selection.accountId) { await authorizePublishingAccount(user, selection.accountId, true); await requirePublishingAccount(selection.agentId, selection.instanceId, selection.accountId, selection.channelId); }
  return user;
}
/** 只接受结构化元信息；即使 Agent 多传字段也不会泄露路径、令牌或内部对象。 */
function decode(bytes: Uint8Array): PreviewState {
  let envelope: PreviewEnvelope;
  try { envelope = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppError("PREVIEW_RESPONSE", "设备预览响应无效。", 502); }
  if (envelope.error) throw new AppError(typeof envelope.code === "string" ? envelope.code.slice(0, 64) : "PREVIEW_FAILED", String(envelope.error).slice(0, 500), typeof envelope.status === "number" && envelope.status >= 400 && envelope.status <= 599 ? envelope.status : 502);
  const parsed = stateSchema.safeParse(envelope.data); if (!parsed.success) throw new AppError("PREVIEW_RESPONSE", "设备预览元信息无效。", 502);
  return parsed.data;
}
/** 命令永远由绑定的会话构建，不接受浏览器在后续请求中更换设备或素材。 */
async function command(request: Request, session: Session, action: PreviewCommand["action"], extra: Partial<Pick<PreviewCommand, "part" | "offset" | "count">> = {}) {
  try { await authorize(request, session.selection); } catch (error) { revoke(session); throw error; }
  if (session.expires <= Date.now()) throw new AppError("PREVIEW_EXPIRED", "预览已过期，请重新打开。", 410);
  const { source, ...target } = session.selection;
  return requestPreview({ session: session.id, expires: session.expires, target, action, ...(action === "open" ? { source } : {}), ...extra }, request.signal);
}
/** 过期记录直接丢弃；浏览器会话摘要绑定可阻止退出再登录后复用旧 URL。 */
async function sessionFor(request: Request, id: string) {
  for (const [key, item] of sessions) if (item.expires <= Date.now()) sessions.delete(key);
  await authenticate(request);
  const session = sessions.get(id); if (!session || session.login !== digest(cookieValue(request, SESSION_COOKIE))) throw new AppError("PREVIEW_EXPIRED", "预览已失效，请重新打开。", 410);
  return session;
}
/** 打开只准备读取会话，不创建发布任务，也不调用 YouTube。 */
export async function openPreview(request: Request, selection: PreviewSelection) {
  const user = await authorize(request, selection);
  for (const [id, entry] of sessions) if (entry.expires <= Date.now()) sessions.delete(id);
  const login = digest(cookieValue(request, SESSION_COOKIE));
  if (sessions.size >= 128 || [...sessions.values()].filter(s => s.login === login).length >= 6) throw new AppError("PREVIEW_BUSY", "请先关闭其他预览后重试。", 429);
  const session: Session = { id: randomUUID(), login, selection, expires: Date.now() + PREVIEW_TTL }; sessions.set(session.id, session);
  try { const reply = await command(request, session, "open"); if (!reply.json) throw new AppError("PREVIEW_RESPONSE", "设备响应无效。", 502); session.state = decode(reply.bytes); await audit(user.username, "media-preview-open", selection.instanceId, "succeeded", session.id); return { id: session.id, ...session.state }; }
  catch (error) { sessions.delete(session.id); throw error; }
}
/** 检查是显式动作；关闭立即撤销 URL，设备端在 TTL 到期后也会取消残留检查。 */
export async function updatePreview(request: Request, id: string, action: "status" | "check" | "prepare" | "cancel" | "close") {
  if (action === "close") {
    const session = sessions.get(id);
    if (session && session.login === digest(cookieValue(request, SESSION_COOKIE))) revoke(session);
    return { id, busy: false, expires: 0, files: {} };
  }
  const session = await sessionFor(request, id);
  const result = await command(request, session, action); if (!result.json) throw new AppError("PREVIEW_RESPONSE", "设备响应无效。", 502);
  session.state = decode(result.bytes); return { id, ...session.state };
}
/** Range 对外保留精确总长度，对内分割为 1 MiB；背压或取消会停止索取后续分片。 */
export async function readPreview(request: Request, id: string, part: PreviewPart) {
  const session = await sessionFor(request, id); const status = await command(request, session, "status");
  if (!status.json) throw new AppError("PREVIEW_RESPONSE", "设备响应无效。", 502); session.state = decode(status.bytes);
  const file = session.state.files[part]; if (!file) throw new AppError("PREVIEW_FILE", "该素材尚未准备好。", 404);
  let range: ReturnType<typeof previewRange>;
  try { range = previewRange(request.headers.get("range"), file.size); } catch { return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}`, "Cache-Control": "no-store" } }); }
  const headers = { "Content-Type": file.mime, "Content-Length": String(range.end - range.start + 1), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${file.size}` } : {}) };
  if (request.method === "HEAD") return new Response(null, { status: range.partial ? 206 : 200, headers });
  let offset = range.start; const abort = new AbortController(); const signal = AbortSignal.any([request.signal, abort.signal]);
  const scoped = new Request(request, { signal });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) { controller.close(); return; }
        if (session.login !== digest(cookieValue(request, SESSION_COOKIE)) || !sessions.has(id)) throw new AppError("PREVIEW_EXPIRED", "预览已关闭。", 410);
        const count = Math.min(PREVIEW_CHUNK, range.end - offset + 1); const result = await command(scoped, session, "bytes", { part, offset, count });
        await authorize(request, session.selection);
        if (result.json) { decode(result.bytes); throw new AppError("PREVIEW_RESPONSE", "设备没有返回媒体分片。", 502); }
        if (result.bytes.length !== count) throw new AppError("PREVIEW_RESPONSE", "媒体分片不完整。", 502);
        offset += count; controller.enqueue(result.bytes); if (offset > range.end) controller.close();
      } catch (error) { controller.error(error); abort.abort(); }
    },
    cancel() { abort.abort(); },
  }, { highWaterMark: 0 });
  return new Response(stream, { status: range.partial ? 206 : 200, headers });
}
