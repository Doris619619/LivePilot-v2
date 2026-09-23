/** 固定列对齐的设备归属表单；表头与无障碍名称共同标识下拉框。 */
import type { Overview } from "./view-model";
/** 服务端继续校验空闲与角色，选择客户后仍须显式点击分配。 */
export default function Assignment({ data, busy, notice, assign }: { data: Overview; busy: boolean; notice: string; assign: (id: string, owner: string) => Promise<void> }) {
  return <section className="admin-assignment"><div className="admin-section-heading"><h2>设备归属</h2><details className="admin-assignment-help"><summary>分配规则</summary><p>电脑需要在线，且直播、上传、授权均已结束，才能更改归属。原配置和频道会保留。</p></details></div>
    {notice && <p className="admin-notice" role="status">{notice}</p>}
    <div className="admin-assignment-head" aria-hidden="true"><span>电脑</span><span>所属客户</span><span>操作</span></div>
    {data.agents.filter(a => !a.pairedTo).map(a => <form className="admin-assignment-row" key={a.id + ":" + a.owner} onSubmit={e => { e.preventDefault(); void assign(a.id, String(new FormData(e.currentTarget).get("owner"))); }}>
      <span className="admin-assignment-device">{a.name}{a.revoked && <span>已移除</span>}</span>
      <label><span className="visually-hidden">{a.name} 所属客户</span><select name="owner" defaultValue={a.owner || ""} required disabled={busy || a.revoked}><option value="" disabled>选择客户</option>{data.customers.map(c => <option key={c.username}>{c.username}</option>)}</select></label>
      <button disabled={busy || a.revoked}>分配</button>
    </form>)}
  </section>;
}
