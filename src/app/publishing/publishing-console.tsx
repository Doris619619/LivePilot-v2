/** 发布工作台只保留发布视频和我的发布；配置、授权与管理员策略分层呈现。 */
"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../client-request";
import { RefreshIcon, VideoIcon } from "../components/icons";
import { PRIVACY_VERSION, type PackageBatch, type PublishingPlan, type PublishingPlanItem, type PublishingPlanRule, type PublishingProfile, type PublishingPolicy, type VideoJob } from "@/shared/publishing";
import type { InstanceDescriptor } from "@/shared/types";
import ProfileEditor, { type PublishingTarget } from "./profile-editor";
import PolicyEditor, { type PublishingQuota } from "./policy-editor";
import DataSettings, { type PublishingCleanup } from "./data-settings";
import PublishingWizard from "./publishing-wizard";
import MyPublishing from "./my-publishing";
import { visibilityLabel } from "./display";
import "./publishing.css";
type View = { profiles: PublishingProfile[]; jobs: VideoJob[]; plans?: PublishingPlan[]; policy: PublishingPolicy; quota?: PublishingQuota; consent?: { version: string }; cleanups: PublishingCleanup[]; administrator: boolean };
type PackageIndex = { root: string; batches: PackageBatch[]; thumbnails?: string[]; channelId?: string; channel?: string };
/** 所有发布编辑共用同源请求，检测等待不等于执行成功。 */
async function post<T>(value: unknown) { return api<T>("/api/publishing", { method: "POST", timeoutMs: 60000, headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify(value) }); }
/** Cloud状态轮询独立于表单和持久计划，不覆盖用户正在编辑的输入。 */
export default function PublishingConsole() {
  const [view, setView] = useState<View>(); const [username, setUsername] = useState(""); const [targets, setTargets] = useState<PublishingTarget[]>([]); const [chosen, setChosen] = useState("");
  const [tab, setTab] = useState("发布视频"); const [setting, setSetting] = useState("发布配置"); const [index, setIndex] = useState<PackageIndex>(); const [profileId, setProfileId] = useState("");
  const [editing, setEditing] = useState<PublishingProfile | "new">(); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false); const [readAt, setReadAt] = useState(0);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const target = targets.find(value => value.agentId + ":" + value.instanceId === chosen);
  const profiles = view?.profiles.filter(profile => profile.agentId + ":" + profile.instanceId === chosen) || [];
  const jobs = view?.jobs.filter(job => !chosen || job.spec.profile.agentId + ":" + job.spec.profile.instanceId === chosen) || [];
  const plans = view?.plans?.filter(plan => plan.profile.agentId + ":" + plan.profile.instanceId === chosen) || [];
  const cleanups = view?.cleanups.filter(cleanup => cleanup.agentId + ":" + cleanup.instanceId === chosen) || [];
  const accepted = view?.consent?.version === PRIVACY_VERSION;
  /** 页面只读取Cloud缓存，不逐条调用YouTube。 */
  const refresh = useCallback(async () => { try { const next = await api<View>("/api/publishing"); setView(next); setReadAt(Date.now()); return next; } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => {
    let cancelled = false;
    /** 账号与设备清单用于隔离本地草稿，不读取Token或本机任意路径。 */
    async function load() {
      try {
        const [next, inventory, session] = await Promise.all([api<View>("/api/publishing"), api<{ instances: InstanceDescriptor[] }>("/api/instances"), api<{ user: { username: string } }>("/api/session")]);
        if (cancelled) return;
        const values = inventory.instances.filter(instance => instance.agentId).map(instance => ({ agentId: instance.agentId!, instanceId: instance.id, name: (instance.agentName || instance.agentId) + " · " + instance.name }));
        const latest = [...(next.plans || [])].filter(plan => !plan.confirmedAt && !plan.archivedAt).sort((a, b) => b.createdAt - a.createdAt).find(plan => values.some(value => value.agentId === plan.profile.agentId && value.instanceId === plan.profile.instanceId));
        setView(next); setReadAt(Date.now()); setUsername(session.user.username); setTargets(values);
        setChosen(latest ? latest.profile.agentId + ":" + latest.profile.instanceId : values[0] ? values[0].agentId + ":" + values[0].instanceId : "");
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    }
    void load(); const timer = setInterval(() => void refresh(), 10_000); return () => { cancelled = true; clearInterval(timer); };
  }, [refresh]);
  /** 失败保留当前工作对象；成功提示只描述Cloud或Agent已确认的结果。 */
  async function perform<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { return await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  /** 切换设备清除内存扫描结果，新向导按账号和目标恢复对应草稿。 */
  function choose(value: string) { setChosen(value); setIndex(undefined); setProfileId(""); setEditing(undefined); setNotice(""); }
  /** 本机目录扫描由选定Agent执行，网页只收到批次索引。 */
  async function scan() {
    await perform(async () => {
      if (!target) return; const next = await post<PackageIndex>({ action: "packages", agentId: target.agentId, instanceId: target.instanceId }); setIndex(next);
      setTargets(old => old.map(value => value.agentId === target.agentId && value.instanceId === target.instanceId ? { ...value, channelId: next.channelId, channel: next.channel } : value));
    });
  }
  /** 设置页首次创建配置也先读取真实频道身份，不生成空channelId配置。 */
  async function newProfile() {
    await perform(async () => {
      if (!target) return;
      if (!target.channelId) {
        const next = await post<PackageIndex>({ action: "packages", agentId: target.agentId, instanceId: target.instanceId }); setIndex(next);
        setTargets(old => old.map(value => value.agentId === target.agentId && value.instanceId === target.instanceId ? { ...value, channelId: next.channelId, channel: next.channel } : value));
        if (!next.channelId) throw new Error("请先在这台设备连接 YouTube 频道。");
      }
      setEditing("new");
    });
  }
  /** 配置变更保留既有计划快照，向导选择新保存的配置。 */
  async function save(profile: PublishingProfile) { await perform(async () => { const result = await post<PublishingProfile>({ action: "profile", profile }); setProfileId(result.id); setEditing(undefined); await refresh(); setNotice("配置已保存"); }); }
  /** 控制只更新期望状态，真实结果继续等待Agent报告。 */
  async function operate(id: string, operation: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string) { await perform(async () => { await post({ action: "job", id, operation, publishAt }); await refresh(); setNotice("已提交，等待设备确认"); }); }
  /** 归档只有Agent确认完成才显示成功，离线时保留待处理状态。 */
  async function archive(planId: string) { await perform(async () => { const result = await post<{ state: string; destination?: string }>({ action: "plan-archive", planId }); await refresh(); setNotice(result.state === "complete" ? "批次已归档" : "归档已受理，等待设备确认"); }); }
  /** 单条覆盖保存新修订，仍以服务端分配和冲突检查为准。 */
  async function update(plan: PublishingPlan, rule: PublishingPlanRule, items: PublishingPlanItem[]) { return perform(async () => { const result = await post<PublishingPlan>({ action: "plan-update", planId: plan.id, revision: plan.revision, rule, items }); await refresh(); return result; }); }
  /** 两个主入口保留清晰的返回路径，设置入口不会重置正在准备的向导。 */
  function navigate(name: string) { setTab(name); setEditing(undefined); setNotice(""); }
  const heading = editing ? editing === "new" ? "新建配置" : "编辑配置" : tab;
  return <div className="workspace-shell publishing-workspace"><aside className="workspace-sidebar publishing-sidebar" aria-label="视频发布导航">
    <Link className="sidebar-link" href="/workspace"><VideoIcon /><span>直播工作台</span></Link><div className="sidebar-heading">视频发布</div>
    <nav aria-label="发布功能">{["发布视频", "我的发布"].map(name => <button className={"sidebar-link " + (tab === name ? "is-active" : "")} key={name} aria-current={tab === name ? "page" : undefined} onClick={() => navigate(name)}>{name}</button>)}</nav>
    <div className="publishing-settings-navigation"><button className={"sidebar-link " + (tab === "设置" ? "is-active" : "")} aria-current={tab === "设置" ? "page" : undefined} onClick={() => navigate("设置")}>设置</button></div>
    {view?.administrator && <div className="publishing-admin-navigation"><div className="sidebar-heading">管理员</div><button className={"sidebar-link " + (tab === "发布策略" ? "is-active" : "")} onClick={() => navigate("发布策略")}>发布策略</button></div>}
  </aside><main id="workspace" tabIndex={-1} className="main-wrapper publishing-shell"><header className="workspace-heading"><h1>{heading}</h1><button className="btn-ghost" disabled={busy} onClick={() => void refresh()} aria-label="刷新发布状态"><RefreshIcon />刷新</button></header>
    {error && <div className="publishing-error" role="alert"><span>{error}</span><button onClick={() => void refresh()}>重试</button></div>}{notice && <div className="publishing-message" role="status"><span>{notice}</span><button className="btn-ghost" onClick={() => setNotice("")}>关闭</button></div>}
    {!view || !username ? <p className="publishing-empty" role="status">正在读取…</p> : <>
      {!accepted && <section className="publishing-warning publishing-onboarding"><p>使用前请同意 <Link href="/privacy">隐私政策</Link> 和 <Link href="/terms">服务条款</Link>。</p><button disabled={busy} onClick={() => void perform(async () => { await post({ action: "consent", version: PRIVACY_VERSION }); await refresh(); })}>同意并继续</button></section>}
      {!editing && <div className="publishing-target"><label>设备<select aria-label="设备" disabled={busy} value={chosen} onChange={e => choose(e.target.value)}><option value="">请选择设备</option>{targets.map(value => <option key={value.agentId + ":" + value.instanceId} value={value.agentId + ":" + value.instanceId}>{value.name}</option>)}</select></label></div>}
      {editing && target && <ProfileEditor key={editing === "new" ? chosen : editing.id} initial={editing === "new" ? undefined : editing} target={target} thumbnails={index?.thumbnails || []} save={save} cancel={() => setEditing(undefined)} busy={busy} />}
      {target && <div hidden={tab !== "发布视频" || !!editing}><PublishingWizard key={username + ":" + chosen + ":" + draftEpoch} username={username} target={target} root={index?.root || ""} batches={index?.batches || []} profiles={profiles} profileId={profileId} selectProfile={setProfileId} plans={plans} jobs={jobs} allJobs={view.jobs} busy={busy} accepted={accepted} enabled={view.policy.enabled} publicVerified={view.policy.publicVerified} scan={scan} newProfile={() => void newProfile()} operate={operate} archive={archive} update={update}
        preview={(id, batchId, rule, items) => perform(async () => { const result = await post<PublishingPlan>({ action: "plan-preview", profileId: id, batchId, rule, items }); await refresh(); return result; })}
        confirm={async (plan, ai, replaceJobIds) => !!await perform(async () => { await post({ action: "plan-confirm", planId: plan.id, revision: plan.revision, ai, temporaryPrivateTitle: true, ...(replaceJobIds.length ? { replaceJobIds } : {}) }); await refresh(); setNotice("计划已受理，等待设备执行"); return true; })} />
      </div>}
      {!target && <div className="publishing-empty"><h2>暂无设备</h2></div>}
      {!editing && tab === "我的发布" && <MyPublishing plans={plans} jobs={jobs} allJobs={view.jobs} busy={busy} operate={operate} archive={archive} />}
      {!editing && tab === "设置" && <><nav className="publishing-subnav" aria-label="发布设置">{["发布配置", "授权与数据"].map(name => <button key={name} aria-pressed={setting === name} className={setting === name ? "is-active" : "btn-ghost"} onClick={() => setSetting(name)}>{name}</button>)}</nav>
        {setting === "发布配置" ? <section aria-label="发布配置"><div className="publishing-section-heading"><span>{profiles.length} 个配置</span><button disabled={busy || !target || !accepted} onClick={() => void newProfile()}>新建配置</button></div>{profiles.map(profile => <article className="publishing-profile-row" key={profile.id}><div><h2>{profile.name}</h2><p>{visibilityLabel(profile)}</p></div><button onClick={() => setEditing(profile)}>编辑</button></article>)}</section>
          : <DataSettings key={chosen} disabled={!target} busy={busy} cleanups={cleanups} readAt={readAt} remove={async () => { await perform(async () => { await post({ action: "cleanup", agentId: target!.agentId, instanceId: target!.instanceId, confirmed: true }); await refresh(); setIndex(undefined); try { localStorage.removeItem("livenest-publishing-draft:" + username + ":" + chosen); } catch { /* 浏览器存储不可用不阻止清理Cloud数据。 */ } setDraftEpoch(value => value + 1); setNotice("删除请求已保存，等待设备确认"); }); }} />}
      </>}
      {!editing && tab === "发布策略" && view.administrator && <PolicyEditor initial={view.policy} quota={view.quota} busy={busy} save={async policy => { await perform(async () => { await post({ action: "policy", policy }); await refresh(); setNotice("策略已保存"); }); }} />}
    </>}
  </main></div>;
}
