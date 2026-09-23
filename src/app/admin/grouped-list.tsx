/** 客户、电脑、OBS 三级列表；技术错误折叠，电脑更新时间只出现一次。 */
import Link from "next/link";
import { updateTime, type Group } from "./view-model";
const lifecycle: Record<string, string> = { live: "直播中", complete: "已结束", ready: "已就绪", created: "已创建", testing: "测试中", testStarting: "准备测试", liveStarting: "准备直播", revoked: "已撤销", missing: "未找到" };
/** 客户与设备用标题和缩进区分，OBS 使用紧凑表格对照。 */
export default function GroupedList({ groups, timeZone, stale }: { groups: Group[]; timeZone: string; stale: boolean }) {
  if (!groups.length) return <p className="admin-empty" role="status">没有符合条件的客户或设备。</p>;
  return <div className="admin-groups">{groups.map(group => <section className="admin-customer-group" key={"customer:" + group.customer} aria-label={group.customer || "待分配设备"}>
    <h3>{group.customer || "待分配设备"}</h3>{!group.devices.length && <p className="admin-empty">尚未接入电脑</p>}
    {group.devices.map(({ agent, rows }) => <section className="admin-device-group" key={agent.id} aria-label={agent.name}>
      <header className="admin-device-heading"><div><h4>{agent.name}</h4><span className={"admin-connection " + (!stale && agent.online ? "is-online" : "")}>{stale ? "状态待确认" : agent.online ? "在线" : "离线"}</span></div><span className="admin-updated">最近更新 <time dateTime={agent.lastSeen ? new Date(agent.lastSeen).toISOString() : undefined}>{updateTime(agent.lastSeen, timeZone)}</time></span></header>
      {!rows.length ? <p className="admin-empty">尚未接入 OBS</p> : <div className="admin-table-wrap"><table className="admin-table"><caption className="visually-hidden">{group.customer || "待分配"} · {agent.name} 的 OBS</caption><thead><tr>{["OBS", "频道", "推流状态", "持续时间", "YouTube", "最近操作人", "操作"].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.instanceId}>
        <th scope="row">{r.name}</th><td>{r.channel || "未连接"}</td><td><span className={"admin-stream-state " + (!stale && r.streaming ? "is-live" : "")}>{stale || r.streaming === null ? "未知" : r.streaming ? "正在推流" : "未推流"}</span>{r.error && <details className="admin-error-detail"><summary>{r.error}</summary><p>{r.error}</p></details>}</td>
        <td>{!stale && r.streaming && r.durationMs !== undefined ? Math.floor(r.durationMs / 60000) + " 分钟" : "—"}</td><td>{stale || !r.online ? "未知" : r.lifecycle ? lifecycle[r.lifecycle] || r.lifecycle : "—"}</td><td>{r.actor || "—"}</td><td><Link aria-label={"协助操作 " + agent.name + " · " + r.name} href={"/workspace?customer=" + encodeURIComponent(r.customer || "") + "#instance-" + r.agentId + "-" + r.instanceId}>协助操作</Link></td>
      </tr>)}</tbody></table></div>}
    </section>)}
  </section>)}</div>;
}
