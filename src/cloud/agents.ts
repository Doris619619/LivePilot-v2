/** 设备注册、撤销、会话隔离和心跳；设备凭据只保存摘要。 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Store } from "@/core/storage";
import { AppError } from "@/core/errors";
import { cloudStore, transaction } from "./store";
import { idSchema, OFFLINE_MS, PROTOCOL, type AgentDescriptor, type AgentSnapshot } from "@/shared/remote";
import type { InstanceDescriptor } from "@/shared/types";
type Agent = { id: string; name: string; tokenHash?: string; pairingHash?: string; pairingExpires?: number; revoked: boolean; session?: string; bootId?: string; sessionSeen?: number; instances: InstanceDescriptor[] };
type Registry = { agents: Agent[] };
type Heartbeat = { at: number; session: string; snapshots: AgentSnapshot[] };
/** 摘要用于比较随机凭据；永不记录原始 Authorization。 */
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
/** 对等长随机摘要使用固定时间比较。 */
function matches(value: string, hash?: string) { return !!hash && timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(hash, "hex")); }
/** 路径只来自通过验证的稳定设备 ID。 */
export function agentStore(id: string) { if (!idSchema.safeParse(id).success) throw new AppError("AGENT", "设备不存在。", 404); return new Store(path.join(cloudStore().dir, "agents", id)); }
/** 管理员创建十分钟一次性配对码；已有设备不能被悄悄替换。 */
export async function createPairing(id: string, name: string) {
  agentStore(id);
  if (!name || name.length > 80) throw new AppError("INPUT", "设备名称必须为 1–80 字。");
  const store = cloudStore(); const code = randomBytes(32).toString("hex");
  await transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json") || { agents: [] };
    if (registry.agents.some(a => a.id === id)) throw new AppError("AGENT_EXISTS", "设备 ID 已存在；请使用新 ID，避免替换已有直播电脑。", 409);
    registry.agents.push({ id, name, instances: [], revoked: false, pairingHash: digest(code), pairingExpires: Date.now() + 600_000 });
    await store.write("agents.json", registry);
  });
  return { agentId: id, code, expiresInSeconds: 600 };
}
/** Agent 在本地生成并先保存凭据，配对响应丢失后可凭同一凭据重试。 */
export async function pairAgent(id: string, code: string, token: string) {
  const store = cloudStore();
  if (!/^[a-f0-9]{64}$/.test(code) || !/^[a-f0-9]{64}$/.test(token)) throw new AppError("AGENT_AUTH", "设备配对失败。", 401);
  return transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
    if (!agent || agent.revoked) throw new AppError("AGENT_AUTH", "设备配对失败。", 401);
    if (matches(token, agent.tokenHash)) return { protocol: PROTOCOL };
    if (agent.tokenHash || !matches(code, agent.pairingHash) || (agent.pairingExpires || 0) < Date.now()) throw new AppError("AGENT_AUTH", "配对码无效或已过期。", 401);
    agent.tokenHash = digest(token); delete agent.pairingHash; delete agent.pairingExpires;
    await store.write("agents.json", registry); return { protocol: PROTOCOL };
  });
}
/** 仅续期尚未认领的邀请，不替换已配对设备的凭据。 */
export async function renewPairing(id: string) {
  agentStore(id); const store = cloudStore(); const code = randomBytes(32).toString("hex");
  await transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
    if (!agent || agent.revoked || agent.tokenHash) throw new AppError("AGENT_BOUND", "只能重新生成尚未使用的配对信息。", 409);
    agent.pairingHash = digest(code); agent.pairingExpires = Date.now() + 600_000;
    await store.write("agents.json", registry);
  });
  return { agentId: id, code, expiresInSeconds: 600 };
}
/** 仅供持有维护锁的设备扩大清单；不删除已有实例或迁移频道绑定。 */
export async function extendInstances(id: string, instances: InstanceDescriptor[]) {
  const store = cloudStore();
  return transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
    if (!agent || agent.revoked) throw new AppError("AGENT_AUTH", "设备不存在。", 401);
    if (!instances.some(i => i.id === "main") || agent.instances.some(old => !instances.some(i => i.id === old.id))) throw new AppError("INSTANCE", "新清单必须保留 main 和所有已有实例。", 409);
    agent.instances = instances; await store.write("agents.json", registry); return { ok: true };
  });
}
/** 设备认证不接受浏览器 Cookie，且逐次检查撤销。 */
export async function authenticateAgent(request: Request, sessionRequired = true) {
  const id = request.headers.get("x-livepilot-agent") || ""; agentStore(id);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") || "")?.[1] || "";
  const registry = await cloudStore().read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
  if (!agent || agent.revoked || !token || !matches(token, agent.tokenHash)) throw new AppError("AGENT_AUTH", "设备凭据无效或已撤销。", 401);
  if (sessionRequired && (!agent.session || agent.session !== request.headers.get("x-livepilot-session"))) throw new AppError("AGENT_SESSION", "设备会话已失效，请重新连接。", 409);
  return agent;
}
/** 每次启动使用 bootId；阻止两台复制配置的电脑同时冒用同一个设备。 */
export async function openSession(id: string, bootId: string, instances: InstanceDescriptor[]) {
  const store = cloudStore();
  return transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
    if (!agent || agent.revoked) throw new AppError("AGENT_AUTH", "设备已撤销。", 401);
    const heartbeat = await agentStore(id).read<Heartbeat>("heartbeat.json");
    const seen = Math.max(heartbeat?.at || 0, agent.sessionSeen || 0);
    if (agent.bootId !== bootId && seen > Date.now() - OFFLINE_MS) throw new AppError("AGENT_BUSY", "此设备已有在线进程，不能同时接管。", 409);
    if (agent.instances.length && JSON.stringify(agent.instances.map(i => i.id).sort()) !== JSON.stringify(instances.map(i => i.id).sort())) throw new AppError("AGENT_CONFIG", "设备实例清单已改变，请恢复原清单或以新设备 ID 接入。", 409);
    agent.instances = instances; agent.session = agent.bootId === bootId && agent.session ? agent.session : randomUUID(); agent.bootId = bootId; agent.sessionSeen = Date.now();
    await store.write("agents.json", registry); return { session: agent.session, protocol: PROTOCOL };
  });
}
/** 单独存储设备心跳，过期状态不会当作实时 OBS 状态。 */
export async function heartbeatAgent(id: string, session: string, snapshots: AgentSnapshot[]) {
  const registry = await cloudStore().read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
  if (!agent || agent.revoked || agent.session !== session) throw new AppError("AGENT_SESSION", "设备会话已失效。", 409);
  if (snapshots.some(s => !agent.instances.some(i => i.id === s.instance.id))) throw new AppError("INSTANCE", "设备不能汇报其他实例。", 403);
  await agentStore(id).write("heartbeat.json", { at: Date.now(), session, snapshots } satisfies Heartbeat);
}
/** 仅输出设备名称和公开状态，离线时保留最近实例清单。 */
export async function listAgents(): Promise<AgentDescriptor[]> {
  const registry = await cloudStore().read<Registry>("agents.json") || { agents: [] };
  return Promise.all(registry.agents.map(async a => {
    const beat = await agentStore(a.id).read<Heartbeat>("heartbeat.json"); const lastSeen = beat && beat.session === a.session ? beat.at : 0;
    const maintenance = !!(await agentStore(a.id).read<{ token?: string }>("maintenance.json"))?.token;
    return { id: a.id, name: a.name, revoked: a.revoked, online: !a.revoked && lastSeen > Date.now() - OFFLINE_MS, lastSeen, instances: a.instances, paired: !!a.tokenHash, maintenance };
  }));
}
/** 目标实例必须属于设备，在线检查只影响新任务，不中断已接收任务。 */
export async function requireTarget(agentId: string, instanceId: string, online = false) {
  const agent = (await listAgents()).find(a => a.id === agentId && !a.revoked);
  if (!agent || !agent.instances.some(i => i.id === instanceId)) throw new AppError("INSTANCE", "目标设备或实例不存在。", 404);
  if (online && !agent.online) throw new AppError("AGENT_OFFLINE", "直播电脑离线，尚未下发新任务。", 503);
  return agent;
}
/** 读取由设备上报的状态；调用者须额外标记过期和命令交付状态。 */
export async function snapshotFor(agentId: string, instanceId: string) { return (await agentStore(agentId).read<Heartbeat>("heartbeat.json"))?.snapshots.find(s => s.instance.id === instanceId); }
/** 撤销仅阻止新通信；不假装能停止已经离线执行的 OBS。 */
export async function revokeAgent(id: string) {
  const store = cloudStore(); await transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
    if (!agent) throw new AppError("AGENT", "设备不存在。", 404);
    agent.revoked = true; await store.write("agents.json", registry);
  });
}
