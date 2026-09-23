/** 管理员汇总使用同一批设备快照；过期状态永远不计为停止或直播。 */
import { listAgents } from "./agents";
import { members } from "@/server/access";
import type { Dashboard } from "@/shared/types";
import { initialState } from "@/core/control";
import { problemFor } from "@/core/errors";
import { remoteDashboard } from "@/server/remote";
/** 每个实例独立返回公开状态，不传输素材列表或凭据。 */
export async function overview() {
 const agents = (await listAgents()).filter(a => !a.pairedTo);
 const rows = await Promise.all(agents.filter(a => !a.revoked).flatMap(a => a.instances.map(async i => {
   const d:Dashboard = await remoteDashboard({ agentId: a.id, instanceId: i.id }).catch(e=>({state:initialState(),busy:false,obs:{ready:false,running:false,streaming:null,processKnown:false,message:"此实例状态暂不可读取"},youtube:{connected:false},media:{videos:[],music:[]},configuration:{missing:[],privacy:"unlisted",madeForKids:false},problems:[problemFor(e,{target:{agentId:a.id,instanceId:i.id},stage:"读取实例状态"})]}));
   return { agentId: a.id, instanceId: i.id, customer: a.owner, device: a.name, name: i.name, online: !!d.device?.online, streaming: d.obs.streaming, durationMs: d.obs.durationMs, channel: d.youtube.channel, lifecycle: d.youtube.lifecycle, lastSeen: a.lastSeen, error: [...(d.problems||[]).map(p=>p.message),d.operation && ["failed","interrupted","uncertain","expired"].includes(d.operation.status) ? d.operation.message : undefined,d.state.error,d.obs.problem || d.obs.processKnown===false || (d.obs.running&&!d.obs.ready) ? d.obs.message : undefined,d.youtube.error,d.media.error].filter(Boolean).join("；") || undefined, actor: d.operation?.actor };
 })));
 const customers = (await members()).filter(m => m.role === "customer");
 return { at: Date.now(), agents, customers, rows, totals: { live: rows.filter(r => r.online && r.streaming === true).length, unknown: rows.filter(r => r.streaming === null).length, errors: rows.filter(r => r.online && r.error).length, online: agents.filter(a => !a.revoked && a.online).length, offline: agents.filter(a => !a.revoked && !a.online).length, customers: customers.length } };
}
