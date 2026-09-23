/** 管理员汇总使用同一批设备快照；过期状态永远不计为停止或直播。 */
import { listAgents } from "./agents";
import { members } from "@/server/access";
import { remoteDashboard } from "@/server/remote";
/** 每个实例独立返回公开状态，不传输素材列表或凭据。 */
export async function overview() {
 const agents = (await listAgents()).filter(a => !a.pairedTo);
 const rows = await Promise.all(agents.filter(a => !a.revoked).flatMap(a => a.instances.map(async i => {
   const d = await remoteDashboard({ agentId: a.id, instanceId: i.id });
   return { agentId: a.id, instanceId: i.id, customer: a.owner, device: a.name, name: i.name, online: !!d.device?.online, streaming: d.obs.streaming, durationMs: d.obs.durationMs, channel: d.youtube.channel, lifecycle: d.youtube.lifecycle, lastSeen: a.lastSeen, error: d.state.error || (d.obs.running ? d.obs.message : undefined) || d.youtube.error, actor: d.operation?.actor };
 })));
 const customers = (await members()).filter(m => m.role === "customer");
 return { at: Date.now(), agents, customers, rows, totals: { live: rows.filter(r => r.online && r.streaming === true).length, unknown: rows.filter(r => r.streaming === null).length, errors: rows.filter(r => r.online && r.error).length, online: agents.filter(a => !a.revoked && a.online).length, offline: agents.filter(a => !a.revoked && !a.online).length, customers: customers.length } };
}
