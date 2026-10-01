/** 视频发布工作台：沿用设备侧栏布局，素材、队列和配置共用缓存状态与当前目标。 */
"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../client-request";
import { UploadIcon, RefreshIcon, VideoIcon } from "../components/icons";
import { PRIVACY_VERSION, publishingTerminal, type MediaAsset, type PublishingProfile, type PublishingPolicy, type VideoJob } from "@/shared/publishing";
import type { InstanceDescriptor } from "@/shared/types";
import ProfileEditor, { type PublishingTarget } from "./profile-editor";
import BatchConfirm, { type PublishingPreview } from "./batch-confirm";
import PolicyEditor, { type PublishingQuota } from "./policy-editor";
import DataSettings, { type PublishingCleanup } from "./data-settings";
import JobList from "./job-list";
import PublishingCalendar from "./publishing-calendar";
import { visibilityLabel } from "./display";
import "./publishing.css";

type View = {
  profiles: PublishingProfile[]; jobs: VideoJob[]; policy: PublishingPolicy; quota?: PublishingQuota;
  consent?: { version: string }; cleanups: PublishingCleanup[]; administrator: boolean;
};
const tabs = ["素材库", "发布队列", "日历", "发布配置", "历史", "授权与数据"];

/** 所有发布编辑共用既有同源 HTTP 客户端。 */
async function post<T>(value: unknown) {
  return api<T>("/api/publishing", { method: "POST", headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify(value) });
}
/** 草稿不受队列轮询影响；目标变化时清除不再属于该设备的素材与预览。 */
export default function PublishingConsole() {
  const [view, setView] = useState<View>(); const [targets, setTargets] = useState<PublishingTarget[]>([]); const [chosen, setChosen] = useState("");
  const [tab, setTab] = useState("素材库"); const [assets, setAssets] = useState<MediaAsset[]>([]); const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [selection, setSelection] = useState<string[]>([]); const [profileId, setProfileId] = useState("");
  const [editing, setEditing] = useState<PublishingProfile | "new">(); const [preview, setPreview] = useState<PublishingPreview>();
  const [readAt, setReadAt] = useState(0); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const target = targets.find(t => t.agentId + ":" + t.instanceId === chosen);
  const profiles = view?.profiles.filter(p => p.agentId + ":" + p.instanceId === chosen) || [];
  const profile = profiles.find(p => p.id === profileId); const accepted = view?.consent?.version === PRIVACY_VERSION;
  const selectedJobs = view?.jobs.filter(j => !chosen || j.spec.profile.agentId + ":" + j.spec.profile.instanceId === chosen) || [];
  const activeJobs = selectedJobs.filter(j => !publishingTerminal(j.observed?.state));
  const jobs = tab === "历史" ? selectedJobs.filter(j => publishingTerminal(j.observed?.state)) : activeJobs;
  const cleanups = view?.cleanups.filter(c => c.agentId + ":" + c.instanceId === chosen) || [];

  /** 网络失败保留上次缓存，并明确提示连接错误。 */
  const refresh = useCallback(async () => { try { setView(await api<View>("/api/publishing")); setReadAt(Date.now()); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => {
    let cancelled = false;
    /** 清单来自现有账号过滤接口，不接触其他客户频道。 */
    async function load() {
      await refresh();
      try {
        const data = await api<{ instances: InstanceDescriptor[] }>("/api/instances");
        if (cancelled) return;
        const values = data.instances.filter(i => i.agentId).map(i => ({ agentId: i.agentId!, instanceId: i.id, name: (i.agentName || i.agentId) + " · " + i.name }));
        setTargets(values); setChosen(values[0] ? values[0].agentId + ":" + values[0].instanceId : "");
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    }
    void load(); const timer = setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [refresh]);
  /** 成功提示只描述 Cloud 受理结果；Agent 的确认仍从持久报告读取。 */
  async function perform(fn: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  /** 切换侧栏保留素材选择，退出未提交的编辑和预览。 */
  function navigate(name: string) { setTab(name); setEditing(undefined); setPreview(undefined); setNotice(""); }
  /** 设备切换不可沿用另一台机器的文件身份。 */
  function choose(value: string) {
    setChosen(value); setAssets([]); setThumbnails([]); setSelection([]); setProfileId(""); setPreview(undefined); setEditing(undefined); setNotice("");
  }
  /** 轻量扫描只取文件属性和频道，完整 Hash 由上传中的 Agent 处理。 */
  async function scan() {
    if (!target) return;
    const result = await post<{ assets: MediaAsset[]; thumbnails: string[]; channelId?: string; channel?: string }>({ action: "assets", agentId: target.agentId, instanceId: target.instanceId });
    setAssets(result.assets); setThumbnails(result.thumbnails); setSelection([]);
    setTargets(old => old.map(t => t === target ? { ...t, channelId: result.channelId, channel: result.channel } : t));
  }
  /** 新配置返回素材页；现有批次继续使用原快照。 */
  async function save(value: PublishingProfile) {
    await perform(async () => { const result = await post<PublishingProfile>({ action: "profile", profile: value }); setProfileId(result.id); setEditing(undefined); await refresh(); setTab("素材库"); setNotice("配置已保存"); });
  }
  /** 控制只修改期望状态，等待 Agent 回读后更新结果。 */
  async function operate(id: string, operation: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string) {
    await perform(async () => { await post({ action: "job", id, operation, publishAt }); await refresh(); setNotice("已提交，等待设备确认"); });
  }
  const heading = editing ? editing === "new" ? "新建配置" : "编辑配置" : preview ? "确认发布" : tab;
  return <div className="workspace-shell publishing-workspace">
    <aside className="workspace-sidebar publishing-sidebar" aria-label="视频发布导航">
      <Link className="sidebar-link" href="/workspace"><VideoIcon /><span>直播工作台</span></Link>
      <div className="sidebar-heading">视频发布</div>
      <nav aria-label="发布功能">{[...tabs, ...(view?.administrator ? ["发布策略"] : [])].map(name => <button className={"sidebar-link " + (tab === name ? "is-active" : "")} key={name} aria-current={tab === name ? "page" : undefined} onClick={() => navigate(name)}>
        <span>{name}</span>{name === "发布队列" && activeJobs.length > 0 && <span className="nav-count">{activeJobs.length}</span>}{name === "授权与数据" && cleanups.some(c => c.state !== "complete") && <span className="device-dot" aria-label="等待设备清理" />}
      </button>)}</nav>
    </aside>
    <main id="workspace" tabIndex={-1} className="main-wrapper publishing-shell">
      <header className="workspace-heading"><h1>{heading}</h1>{!preview && !editing && <button className="btn-ghost" disabled={busy} onClick={() => void refresh()} aria-label="刷新发布状态"><RefreshIcon />刷新</button>}</header>
      {error && <div className="publishing-error" role="alert"><span>{error}</span><button onClick={() => void refresh()}>重试</button></div>}
      {notice && <div className="publishing-message" role="status"><span>{notice}</span><button className="btn-ghost" onClick={() => setNotice("")}>关闭</button></div>}
      {!view ? <p className="publishing-empty" role="status">正在读取…</p> : <>
        {!accepted && <section className="publishing-warning publishing-onboarding"><p>使用前请阅读并同意 <Link href="/privacy">隐私政策</Link> 和 <Link href="/terms">服务条款</Link>。</p><button disabled={busy} onClick={() => void perform(async () => { await post({ action: "consent", version: PRIVACY_VERSION }); await refresh(); })}>同意并继续</button></section>}
        {!editing && !preview && <div className="publishing-target"><label>设备 / 频道<select disabled={busy} value={chosen} onChange={e => choose(e.target.value)}><option value="">请选择设备</option>{targets.map(t => <option key={t.agentId + ":" + t.instanceId} value={t.agentId + ":" + t.instanceId}>{t.name}{t.channel ? " · " + t.channel : ""}</option>)}</select></label>{["素材库", "发布配置"].includes(tab) && <button disabled={busy || !target || !accepted} onClick={() => void perform(scan)}><RefreshIcon />{busy ? "读取中…" : "读取素材"}</button>}</div>}
        {editing && target ? <ProfileEditor key={editing === "new" ? chosen : editing.id} initial={editing === "new" ? undefined : editing} target={target} thumbnails={thumbnails} save={save} cancel={() => setEditing(undefined)} busy={busy} />
          : preview ? <BatchConfirm preview={preview} channel={target?.channel} busy={busy} cancel={() => setPreview(undefined)} confirm={(ai, overrides) => perform(async () => { await post({ action: "confirm", batchId: preview.id, ai, temporaryPrivateTitle: true, overrides }); setPreview(undefined); setSelection([]); setTab("发布队列"); await refresh(); setNotice("批次已提交，等待设备上传"); })} />
          : tab === "素材库" ? <section aria-label="素材选择">
            <div className="publishing-profile-picker"><label>发布配置<select value={profileId} onChange={e => setProfileId(e.target.value)}><option value="">请选择配置</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name} · {visibilityLabel(p)}</option>)}</select></label><button disabled={!target?.channelId || !accepted} onClick={() => setEditing("new")}>新建配置</button>{profile && <button className="btn-ghost" onClick={() => setEditing(profile)}>编辑</button>}</div>
            {assets.length ? <>
              <div className="publishing-section-heading"><div className="publishing-actions"><button className="btn-ghost" onClick={() => setSelection(selection.length === assets.length ? [] : assets.map(a => a.id))}>{selection.length === assets.length ? "取消全选" : "全选"}</button><span>已选 {selection.length} / {assets.length}</span></div><span className="publishing-hint">按选择顺序发布</span></div>
              <div className="publishing-asset-list">{assets.map(asset => <div key={asset.id} className="publishing-asset">
                <label><input type="checkbox" checked={selection.includes(asset.id)} onChange={e => setSelection(e.target.checked ? [...selection, asset.id] : selection.filter(id => id !== asset.id))} /><span className="publishing-file"><strong>{asset.filename}</strong><span>{Math.round(asset.size / 1024 ** 2)} MiB{asset.thumbnail && " · 已有封面"}</span></span></label>
                {selection.includes(asset.id) && <div className="publishing-sort"><span className="publishing-order">{selection.indexOf(asset.id) + 1}</span><button aria-label={asset.filename + " 上移"} disabled={selection.indexOf(asset.id) === 0} onClick={() => setSelection(reorder(selection, asset.id, -1))}>↑</button><button aria-label={asset.filename + " 下移"} disabled={selection.indexOf(asset.id) === selection.length - 1} onClick={() => setSelection(reorder(selection, asset.id, 1))}>↓</button></div>}
              </div>)}</div>
              {profile?.privacy === "public" && !view.policy.publicVerified && <p className="publishing-warning">自动公开待验收，请先使用私密配置。</p>}
              {!view.policy.enabled && <p className="publishing-warning">发布尚未开启，请联系管理员。</p>}
              <div className="publishing-actions"><button className="btn-primary" disabled={busy || !profile || !selection.length || !accepted || !view.policy.enabled || profile.privacy === "public" && !view.policy.publicVerified} onClick={() => void perform(async () => setPreview(await post<PublishingPreview>({ action: "preview", profileId, assetIds: selection })))}>预览排期</button></div>
            </> : <div className="publishing-empty"><UploadIcon width={28} height={28} /><h2>还没有素材</h2><p>读取设备上已准备的视频。</p><details className="publishing-details"><summary>素材放在哪里？</summary><p>视频放入 Agent 的 videos 目录，封面放入 thumbnails 目录。</p></details></div>}
          </section>
          : tab === "发布配置" ? <section aria-label="发布配置"><div className="publishing-section-heading"><span>{profiles.length} 个配置</span><button disabled={!target?.channelId || !accepted} onClick={() => setEditing("new")}>新建配置</button></div>{profiles.map(p => <article className="publishing-profile-row" key={p.id}><div><h2>{p.name}</h2><p>{visibilityLabel(p)}{p.scheduled && " · " + p.schedule.localTime + " · " + p.schedule.timezone}</p></div><button onClick={() => { setEditing(p); setProfileId(p.id); }}>编辑</button></article>)}</section>
          : tab === "发布策略" ? <PolicyEditor initial={view.policy} quota={view.quota} busy={busy} save={value => perform(async () => { await post({ action: "policy", policy: value }); await refresh(); setNotice("策略已保存"); })} />
          : tab === "授权与数据" ? <DataSettings key={chosen} disabled={!target} busy={busy} cleanups={cleanups} readAt={readAt} remove={() => perform(async () => { await post({ action: "cleanup", agentId: target!.agentId, instanceId: target!.instanceId, confirmed: true }); await refresh(); setAssets([]); setSelection([]); setNotice("删除请求已保存，等待设备确认"); })} />
          : tab === "日历" ? <PublishingCalendar jobs={selectedJobs} />
          : <JobList jobs={jobs} busy={busy} operate={operate} />}
      </>}
    </main>
  </div>;
}
/** 仅改变选中素材顺序，不改变文件清单或文件版本。 */
function reorder(values: string[], id: string, delta: number) {
  const next = [...values]; const at = next.indexOf(id); const other = at + delta;
  if (other < 0 || other >= next.length) return next;
  [next[at], next[other]] = [next[other], next[at]]; return next;
}
