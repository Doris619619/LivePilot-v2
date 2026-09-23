/** 设备注册、撤销、会话隔离和心跳；设备凭据只保存摘要。 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Store } from "@/core/storage";
import { AppError } from "@/core/errors";
import { cloudStore, transaction } from "./store";
import { releaseAgentChannels } from "./bindings";
import { idSchema, OFFLINE_MS, PROTOCOL, type AgentDescriptor, type AgentSnapshot } from "@/shared/remote";
import type { InstanceDescriptor } from "@/shared/types";
type Agent = { owner?: string; id: string; name: string; tokenHash?: string; pairingHash?: string; pairingExpires?: number; pairedTo?: string; pairingReceiptHash?: string; revoked: boolean; session?: string; bootId?: string; sessionSeen?: number; instances: InstanceDescriptor[] };
type Registry = { agents: Agent[] };
type Heartbeat = { at: number; session: string; snapshots: AgentSnapshot[] };
/** 摘要用于比较随机凭据；永不记录原始 Authorization。 */
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
/** 对等长随机摘要使用固定时间比较。 */
function matches(value: string, hash?: string) { return !!hash && timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(hash, "hex")); }
/** 路径只来自通过验证的稳定设备 ID。 */
export function agentStore(id: string) { if (!idSchema.safeParse(id).success) throw new AppError("AGENT", "设备不存在。", 404); return new Store(path.join(cloudStore().dir, "agents", id)); }
/** 管理员创建十分钟一次性配对码；已有设备不能被悄悄替换。 */
export async function createPairing(id: string, name: string, owner?: string) {
  agentStore(id);
  if (!name || name.length > 80) throw new AppError("INPUT", "设备名称必须为 1–80 字。");
  const store = cloudStore(); const code = randomBytes(32).toString("hex");
  await transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json") || { agents: [] };
    if (registry.agents.some(a => a.id === id)) throw new AppError("AGENT_EXISTS", "设备 ID 已存在；请使用新 ID，避免替换已有直播电脑。", 409);
    registry.agents.push({ id, name, owner, instances: [], revoked: false, pairingHash: digest(code), pairingExpires: Date.now() + 600_000 });
    await store.write("agents.json", registry);
  });
  return { agentId: id, code, expiresInSeconds: 600 };
}
/** Agent 先保存凭据；响应丢失可重试，已撤销身份必须同时验证新邀请与旧凭据。 */
export async function pairAgent(id: string, code: string, token: string, currentAgentId?: string, customer?: string) {
  const store = cloudStore();
  agentStore(id); if (currentAgentId) agentStore(currentAgentId);
  if (!/^[a-f0-9]{64}$/.test(code) || !/^[a-f0-9]{64}$/.test(token)) throw new AppError("AGENT_AUTH", "设备配对失败。", 401);
  return transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
    if (!agent) throw new AppError("AGENT_AUTH", "设备配对失败。", 401);
    let current = currentAgentId ? registry!.agents.find(a => a.id === currentAgentId) : undefined;
    if (currentAgentId) {
      if (current?.pairedTo) current = registry!.agents.find(a => a.id === current!.pairedTo);
      if (current?.tokenHash && !matches(token, current.tokenHash)) throw new AppError("AGENT_AUTH", "无法确认本机身份，原设备与授权已保留。", 401);
      if (!current?.tokenHash) {
        // 初次响应丢失时，本机临时 ID 可能尚未更新；凭据定位已成功登记的同一电脑。
        const known = registry!.agents.filter(a => !a.pairedTo && matches(token, a.tokenHash));
        if (known.length > 1) throw new AppError("AGENT_AUTH", "本机身份记录不唯一，原配置已保留。", 401);
        current = known[0] || current;
      }
    }
    // 配对 HTTP 入口必传客户；旧内部工具不授予客户归属。恢复也不得跨客户迁移。
    if (customer && (agent.owner !== customer || (current?.tokenHash && current.owner !== customer))) throw new AppError("FORBIDDEN", "配对码和原电脑必须属于当前客户；旧电脑请先由管理员分配。", 403);
    // 新邀请只授权这次连接；持有旧凭据的客户端继续使用原设备，单次写入完成消费与恢复。
    if (agent.pairedTo) {
      const target = registry!.agents.find(a => a.id === agent.pairedTo);
      if (target && !target.revoked && current?.id === target.id && matches(token, target.tokenHash) && matches(code, agent.pairingReceiptHash)) return { protocol: PROTOCOL, agentId: target.id };
      throw new AppError("AGENT_AUTH", "配对码已被使用，请生成新码。", 401);
    }
    if (currentAgentId && current?.id !== id) {
      if (agent.tokenHash || agent.revoked || agent.instances.length || !matches(code, agent.pairingHash) || (agent.pairingExpires || 0) < Date.now()) throw new AppError("AGENT_AUTH", "请使用新生成且未使用的配对码。", 401);
      if (current?.tokenHash) {
        if (current.revoked) await releaseAgentChannels(store, current.id);
        current.revoked = false; delete current.pairingHash; delete current.pairingExpires;
        agent.pairedTo = current.id; agent.pairingReceiptHash = digest(code); agent.revoked = true;
        delete agent.pairingHash; delete agent.pairingExpires;
        await store.write("agents.json", registry); return { protocol: PROTOCOL, agentId: current.id };
      }
      // 从未认领成功的临时身份可以使用新邀请；不能将已有实例当作未配置设备。
      if (current?.instances.length) throw new AppError("AGENT_AUTH", "无法确认原设备凭据，配置已保留。", 401);
    }
    if (agent.revoked) {
      if (!matches(code, agent.pairingHash) || (agent.pairingExpires || 0) < Date.now() || (agent.tokenHash && !matches(token, agent.tokenHash))) throw new AppError("AGENT_AUTH", "恢复配对需要新的邀请和原电脑身份，请在原 Windows 账户的 LiveNest 中重试。", 401);
      await releaseAgentChannels(store, agent.id);
      agent.revoked = false; agent.tokenHash = digest(token); delete agent.pairingHash; delete agent.pairingExpires;
      await store.write("agents.json", registry); return { protocol: PROTOCOL, agentId: id };
    }
    if (matches(token, agent.tokenHash)) return { protocol: PROTOCOL, agentId: id };
    if (agent.tokenHash || !matches(code, agent.pairingHash) || (agent.pairingExpires || 0) < Date.now()) throw new AppError("AGENT_AUTH", "配对码无效或已过期。", 401);
    agent.tokenHash = digest(token); delete agent.pairingHash; delete agent.pairingExpires;
    await store.write("agents.json", registry); return { protocol: PROTOCOL, agentId: id };
  });
}
/** 未认领邀请可续期；已移除设备只发恢复邀请，必须由原凭据认领。 */
export async function renewPairing(id: string) {
  agentStore(id); const store = cloudStore(); const code = randomBytes(32).toString("hex");
  await transaction(store, async () => {
    const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
    if (!agent || agent.pairedTo || (!agent.revoked && agent.tokenHash)) throw new AppError("AGENT_BOUND", "此配对码已使用，请生成新码。", 409);
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
    return { id: a.id, name: a.name, owner: a.owner, revoked: a.revoked, online: !a.revoked && lastSeen > Date.now() - OFFLINE_MS, lastSeen, instances: a.instances, paired: !!a.tokenHash, maintenance, ...(a.pairedTo ? { pairedTo: a.pairedTo } : {}) };
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
/** 在派发锁内重新检查撤销，避免请求认证后移除设备的竞争。 */
export async function assertAgentActive(id: string) {
  const registry = await cloudStore().read<Registry>("agents.json");
  if (!registry?.agents.some(a => a.id === id && !a.revoked)) throw new AppError("AGENT_AUTH", "设备已移除，请从网页恢复配对。", 401);
}
/** 撤销与派发互斥并释放频道归属；已送达任务、本机授权与文件保留待核对。 */
export async function revokeAgent(id: string) {
  const local = agentStore(id); const store = cloudStore(); await transaction(local, async () => {
    await transaction(store, async () => {
      const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id);
      if (!agent) throw new AppError("AGENT", "设备不存在。", 404);
      delete agent.pairingHash; delete agent.pairingExpires; delete agent.pairingReceiptHash;
      agent.revoked = true; await store.write("agents.json", registry);
      await releaseAgentChannels(store, id);
    });
    const queue = await local.read<{ records: import("./tasks").TaskRecord[] }>("tasks.json");
    if (queue) { for (const task of queue.records) if (task.status === "queued") { task.status = "expired"; task.updatedAt = Date.now(); task.message = "设备已移除，此任务尚未派发。"; } await local.write("tasks.json", queue); }
  }, "tasks.lock");
}

/** 在已取得设备维护锁时分配归属；只改元数据，保留身份、频道和文件。 */
export async function setAgentOwner(id: string, owner: string) {
  const store = cloudStore();
  await transaction(store, async () => { const registry = await store.read<Registry>("agents.json"); const agent = registry?.agents.find(a => a.id === id && !a.pairedTo); if (!agent) throw new AppError("AGENT", "设备不存在。", 404); agent.owner = owner; await store.write("agents.json", registry); });
}
