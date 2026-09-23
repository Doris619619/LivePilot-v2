/** 管理员总览：可点击指标、客户分组与浏览器保存的显示时区。 */
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../client-request";
import GroupedList from "./grouped-list";
import Assignment from "./assignment";
import { groupOverview, scopes, validTimeZone, type Overview, type Scope } from "./view-model";
import "./admin.css";
const zoneKey = "livenest-admin-timezone";
const zoneLabels: Record<string, string> = { "Asia/Shanghai": "北京 / 上海", "Asia/Hong_Kong": "香港", "Asia/Tokyo": "东京", "Asia/Singapore": "新加坡", "America/New_York": "纽约", "America/Los_Angeles": "洛杉矶", "Europe/London": "伦敦", "Europe/Paris": "巴黎", "Australia/Sydney": "悉尼", UTC: "协调世界时" };
/** 无法访问浏览器存储时，使用电脑当前时区。 */
function savedZone() {
  try { const saved = localStorage.getItem(zoneKey); if (saved && validTimeZone(saved)) return saved; } catch { /* 隐私模式仍允许本次选择。 */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
/** 五秒刷新不覆盖筛选与时区；获取失败保留数据并标明过期。 */
export default function Admin() {
  const [data, setData] = useState<Overview>();
  const [error, setError] = useState("");
  const [customer, setCustomer] = useState("");
  const [device, setDevice] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const [zones, setZones] = useState(Object.keys(zoneLabels));
  useEffect(() => {
    let active = true; let loading = false; let initialized = false;
    /** 合并并发轮询，卸载后不再写入状态。 */
    async function load() {
      if (loading) return;
      loading = true;
      try { const next = await api<Overview>("/api/admin/overview"); if (active) { if (!initialized) { const zone = savedZone(); setTimeZone(zone); setZones([...new Set([...Object.keys(zoneLabels), zone, ...Intl.supportedValuesOf("timeZone")])]); initialized = true; } setData(next); setError(""); } }
      catch (e) { if (active) setError((e as Error).message); }
      finally { loading = false; }
    }
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  /** 指标是全局统计，点击时清除其他筛选，使明细与数字一致。 */
  function chooseScope(next: Scope) { setScope(next); setCustomer(""); setDevice(""); }
  /** 只调整时间显示，不改直播计划或电脑系统时区。 */
  function chooseZone(next: string) { setTimeZone(next); try { localStorage.setItem(zoneKey, next); } catch { /* 存储不可用时保留当前页面选择。 */ } }
  /** 分配后重新读取归属；空闲状态与权限仍由服务端检查。 */
  async function assign(agentId: string, owner: string) {
    setBusy(true); setNotice("");
    try { await api("/api/admin/assign", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ agentId, owner }) }); setData(await api<Overview>("/api/admin/overview")); setNotice("设备已分配，原配置和频道已保留。"); }
    catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }
  const metrics: { scope: Scope; label: string; value?: number }[] = [
    { scope: "live", label: "正在推流", value: data?.totals.live }, { scope: "online", label: "在线电脑", value: data?.totals.online },
    { scope: "offline", label: "离线电脑", value: data?.totals.offline }, { scope: "customers", label: "客户", value: data?.totals.customers },
    { scope: "error", label: "异常实例", value: data?.totals.errors }, { scope: "unknown", label: "状态未知", value: data?.totals.unknown },
  ];
  return <main className="main-wrapper admin-page" id="workspace">
    <div className="workspace-heading admin-heading"><h1>管理员总览</h1><div className="admin-heading-actions"><label className="admin-timezone">显示时区<select value={timeZone} onChange={e => chooseZone(e.target.value)}>{zones.map(zone => <option key={zone} value={zone}>{zoneLabels[zone] ? zoneLabels[zone] + " · " : ""}{zone}</option>)}</select></label><Link href="/workspace">进入直播工作台 ↗</Link></div></div>
    {error && <div className="banner error" role="alert">{error} · 以下为上次获取的数据，不能视为实时状态。</div>}
    {!data ? <p role="status">正在读取设备状态…</p> : <>
      <div className="admin-metrics">{metrics.map(metric => <button key={metric.scope} className="admin-metric" aria-pressed={scope === metric.scope} aria-controls="admin-results" disabled={!!error} onClick={() => chooseScope(metric.scope)}><span>{metric.label}</span><strong>{error ? "—" : metric.value}</strong></button>)}</div>
      <div className="admin-filters"><label>客户<select value={customer} onChange={e => { setCustomer(e.target.value); setDevice(""); }}><option value="">全部客户</option><option value="unassigned">待分配</option>{data.customers.map(c => <option key={c.username}>{c.username}</option>)}</select></label><label>电脑<select value={device} onChange={e => setDevice(e.target.value)}><option value="">全部电脑</option>{data.agents.filter(a => !a.revoked && !a.pairedTo && (!customer || (customer === "unassigned" ? !a.owner : a.owner === customer))).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>状态<select value={scope} onChange={e => setScope(e.target.value as Scope)}>{Object.entries(scopes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{(scope !== "all" || customer || device) && <button className="admin-reset" onClick={() => chooseScope("all")}>显示全部</button>}</div>
      <section id="admin-results" aria-label="客户与 OBS 明细"><div className="admin-section-heading"><h2>{scope === "all" ? "客户与 OBS" : scopes[scope]}</h2></div><GroupedList groups={groupOverview(data, scope, customer, device)} timeZone={timeZone} stale={!!error} /></section>
      <Assignment data={data} busy={busy} notice={notice} assign={assign} />
    </>}
  </main>;
}
