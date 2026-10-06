/** 发布工作台只保留发布视频和我的发布；配置、授权与管理员策略分层呈现。 */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "../client-request";
import { RefreshIcon, VideoIcon } from "../components/icons";
import { PRIVACY_VERSION, type PackageBatch, type PublishingAccount, type PublishingBatchRemoval, type PublishingPlan, type PublishingPlanItem, type PublishingPlanRule, type PublishingProfile, type PublishingPolicy, type VideoJob } from "@/shared/publishing";
import type { InstanceDescriptor } from "@/shared/types";
import type { OAuthResult } from "@/server/oauth-result";
import ProfileEditor, { type PublishingTarget } from "./profile-editor";
import PolicyEditor, { type PublishingQuota } from "./policy-editor";
import DataSettings, { type PublishingCleanup } from "./data-settings";
import PublishingWizard from "./publishing-wizard";
import MyPublishing from "./my-publishing";
import { visibilityLabel } from "./display";
import ChannelBinding from "./channel-binding";
import { publishingTargetStorageKey, restorePublishingTarget } from "./publishing-target-selection";
import { usePublishingDirectory } from "./use-publishing-directory";
import "./publishing.css";
type View = { profiles: PublishingProfile[]; jobs: VideoJob[]; plans?: PublishingPlan[]; removals?: PublishingBatchRemoval[]; accounts?: PublishingAccount[]; policy: PublishingPolicy; quota?: PublishingQuota; consent?: { version: string }; cleanups: PublishingCleanup[]; administrator: boolean };
type PackageIndex = { root: string; batches: PackageBatch[]; thumbnails?: string[]; channelId?: string; channel?: string };
/** 所有发布编辑共用同源请求，检测等待不等于执行成功。 */
async function post<T>(value: unknown) { return api<T>("/api/publishing", { method: "POST", timeoutMs: 60000, headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify(value) }); }
/** Cloud状态轮询独立于表单和持久计划，不覆盖用户正在编辑的输入。 */
export default function PublishingConsole() {
  const [view, setView] = useState<View>(); const [username, setUsername] = useState(""); const [targets, setTargets] = useState<PublishingTarget[]>([]); const [chosen, setChosen] = useState("");
  const [tab, setTab] = useState("发布视频"); const [setting, setSetting] = useState("发布配置"); const [index, setIndex] = useState<PackageIndex>(); const [profileId, setProfileId] = useState("");
  const [editing, setEditing] = useState<PublishingProfile | "new">(); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false); const [readAt, setReadAt] = useState(0);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0); const initialized = useRef(false);
  const readRequest = useRef(0);
  const host = targets.find(value => value.agentId + ":" + value.instanceId === chosen);
  const accounts = view?.accounts?.filter(account => account.agentId === host?.agentId && account.status !== "deleted") || [];
  const account = accounts.find(value => value.id === accountId);
  const target = host && { ...host, accountId: account?.id, channelId: account?.status === "connected" ? account.channelId : undefined, channel: account?.status === "connected" ? account.channel : undefined };
  const profiles = view?.profiles.filter(profile => profile.agentId + ":" + profile.instanceId === chosen && !!account && profile.accountId === account.id) || [];
  const jobs = view?.jobs.filter(job => job.spec.profile.agentId + ":" + job.spec.profile.instanceId === chosen && !!account && job.spec.profile.accountId === account.id) || [];
  const plans = view?.plans?.filter(plan => plan.profile.agentId + ":" + plan.profile.instanceId === chosen && !!account && plan.profile.accountId === account.id) || [];
  const cleanups = view?.cleanups.filter(cleanup => !cleanup.accountId && cleanup.agentId + ":" + cleanup.instanceId === chosen) || [];
  const accepted = view?.consent?.version === PRIVACY_VERSION;
  const directory = usePublishingDirectory(host, accepted);
  /** 只应用最新读取；旧请求不能覆盖已保存的修订或删除后的清单，轮询不清除操作错误。 */
  const refresh = useCallback(async (clearError = false) => {
    const request = ++readRequest.current;
    try { const next = await api<View>("/api/publishing"); if (request !== readRequest.current) return; setView(next); setReadAt(Date.now()); if (clearError) setError(""); return next; }
    catch (e) { if (request === readRequest.current) setError((e as Error).message); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    /** 账号与设备清单用于隔离本地草稿，不读取Token或本机任意路径。 */
    async function load() {
      try {
        const [next, inventory, session] = await Promise.all([api<View>("/api/publishing"), api<{ instances: InstanceDescriptor[] }>("/api/instances"), api<{ user: { username: string } }>("/api/session")]);
        if (cancelled) return;
        const values = inventory.instances.filter(instance => instance.agentId).map(instance => ({ agentId: instance.agentId!, instanceId: instance.id, name: (instance.agentName || instance.agentId) + " · " + instance.name }));
        const reference = new URLSearchParams(window.location.search).get("oauthResult");
        let authorization: OAuthResult | undefined;
        if (reference) {
          try { authorization = await api<OAuthResult>("/api/youtube/result?id=" + encodeURIComponent(reference)); } catch (e) { if (!cancelled) setError((e as Error).message); }
          if (cancelled) return;
          // 成功读取后只消费本次授权结果；保留其他 URL 状态，后续刷新尊重客户的新账号选择。
          if (authorization) { const destination = new URL(window.location.href); destination.searchParams.delete("oauthResult"); window.history.replaceState(window.history.state, "", destination.pathname + destination.search + destination.hash); }
          if (authorization?.problem) setError(authorization.problem.message);
          else if (authorization) setNotice(authorization.status === "connected" ? "发布账号已连接" : "本次授权已取消");
        }
        let saved: unknown;
        try { saved = JSON.parse(localStorage.getItem(publishingTargetStorageKey(session.user.username)) || "null"); } catch { /* 缓存损坏或不可用时，以最新授权清单和Cloud草稿恢复。 */ }
        const selection = restorePublishingTarget(values, next.accounts || [], next.plans || [], saved, authorization?.accountId);
        setView(next); setReadAt(Date.now()); setUsername(session.user.username); setTargets(values);
        setChosen(selection ? selection.agentId + ":" + selection.instanceId : ""); setAccountId(selection?.accountId || "");
        if (selection && next.consent?.version === PRIVACY_VERSION) {
          try { localStorage.setItem(publishingTargetStorageKey(session.user.username), JSON.stringify(selection)); } catch { /* 禁止本地存储时仍可手动选择账号。 */ }
        }
        initialized.current = true;
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    }
    void load(); const timer = setInterval(() => { if (initialized.current) void refresh(); }, 10_000); return () => { cancelled = true; clearInterval(timer); };
  }, [refresh, loadAttempt]);
  /** 首次读取失败重试完整账号和设备上下文；已进入工作台时只刷新状态，保留当前编辑。 */
  function reload() { if (username) void refresh(true); else { initialized.current = false; setError(""); setLoadAttempt(value => value + 1); } }
  /** 失败保留当前工作对象；成功提示只描述Cloud或Agent已确认的结果。 */
  async function perform<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { return await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  /** 选择即时保存，OAuth 跳转或页面刷新前也能保留目标；真实权限仍由下一次清单验证。 */
  function rememberSelection(value: string, selectedAccount: string) {
    const selectedTarget = targets.find(target => target.agentId + ":" + target.instanceId === value);
    if (!username || !selectedTarget) return;
    try { localStorage.setItem(publishingTargetStorageKey(username), JSON.stringify({ agentId: selectedTarget.agentId, instanceId: selectedTarget.instanceId, accountId: selectedAccount })); } catch { /* 本地存储不可用不阻止本次发布。 */ }
  }
  /** 切换设备清除内存扫描结果，新向导按账号和目标恢复对应草稿。 */
  function choose(value: string) { const nextAccount = view?.accounts?.find(account => account.agentId + ":" + account.instanceId === value && account.status === "connected")?.id || ""; rememberSelection(value, nextAccount); setChosen(value); setAccountId(nextAccount); setIndex(undefined); setProfileId(""); setEditing(undefined); setNotice(""); }
  /** 发布账号固定其处理设备；切换账号只恢复它自己的草稿，不继承直播频道。 */
  function chooseAccount(id: string) { const next = view?.accounts?.find(value => value.id === id); const destination = next ? next.agentId + ":" + next.instanceId : chosen; rememberSelection(destination, id); setAccountId(id); if (destination !== chosen) { setChosen(destination); setIndex(undefined); } setProfileId(""); setEditing(undefined); setNotice(""); }
  /** 本机目录扫描由选定Agent执行，网页只收到批次索引。 */
  async function scan() {
    await perform(async () => {
      if (!target) return; const next = await post<PackageIndex>({ action: "packages", agentId: target.agentId, instanceId: target.instanceId, ...(account ? { accountId: account.id } : {}) }); setIndex(next);
    });
  }
  /** 设置页首次创建配置也先读取真实频道身份，不生成空channelId配置。 */
  async function newProfile() {
    await perform(async () => {
      if (!target || !account || account.status !== "connected" || !account.channelId) throw new Error("请先添加并连接发布账号。");
      const next = await post<PackageIndex>({ action: "packages", agentId: target.agentId, instanceId: target.instanceId, accountId: account.id }); setIndex(next);
      if (next.channelId !== account.channelId) throw new Error("发布账号授权待核对，请重新连接原频道。");
      setEditing("new");
    });
  }
  /** 重新授权只操作指定发布账号，绝不发送旧直播 connect 请求。 */
  async function connectAccount(id: string) {
    await perform(async () => { const result = await post<{ url: string }>({ action: "account-connect", accountId: id }); window.location.assign(result.url); });
  }
  /** 一个新账号有独立授权目录；连接失败保留未绑定账号，重试不重新创建。 */
  async function addAccount() {
    await perform(async () => { if (!host) return; const created = await post<PublishingAccount>({ action: "account-create", agentId: host.agentId, instanceId: host.instanceId, name: "发布账号 " + (accounts.length + 1) }); setView(old => old && { ...old, accounts: [...(old.accounts || []), created] }); setAccountId(created.id); rememberSelection(chosen, created.id); setProfileId(""); const result = await post<{ url: string }>({ action: "account-connect", accountId: created.id }); window.location.assign(result.url); });
  }
  /** 删除范围只包含这个发布账号；离线时保留账号清理状态而不提前声称完成。 */
  async function removeAccount(id: string) {
    await perform(async () => { await post({ action: "account-cleanup", accountId: id, confirmed: true }); await refresh(); if (accountId === id) { setProfileId(""); setIndex(undefined); setDraftEpoch(value => value + 1); } setNotice("已请求清理发布账号，等待设备确认"); });
  }
  /** 配置变更保留既有计划快照，向导选择新保存的配置。 */
  async function save(profile: PublishingProfile) { await perform(async () => { const result = await post<PublishingProfile>({ action: "profile", profile }); readRequest.current++; setView(old => old && { ...old, profiles: [...old.profiles.filter(value => value.id !== result.id), result] }); setProfileId(result.id); setEditing(undefined); await refresh(); setNotice("配置已保存"); }); }
  /** 返回明确受理结果并先显示已保存的修订；列表刷新失败不撤销成功受理，远端结果仍等待 Agent。 */
  async function operate(id: string, operation: "pause" | "resume" | "cancel" | "reschedule" | "reconcile", publishAt?: string): Promise<boolean> {
    return !!await perform(async () => {
      const updated = await post<VideoJob>({ action: "job", id, operation, publishAt });
      readRequest.current++;
      setView(old => old && { ...old, jobs: old.jobs.map(job => job.spec.id === updated.spec.id ? updated : job) });
      setNotice("已提交，等待设备确认"); await refresh(); return true;
    });
  }
  /** 归档只有Agent确认完成才显示成功，离线时保留待处理状态。 */
  async function archive(planId: string) { await perform(async () => { const result = await post<{ state: string; destination?: string }>({ action: "plan-archive", planId }); await refresh(); setNotice(result.state === "complete" ? "批次已归档" : "归档已受理，等待设备确认"); }); }
  /** 删除意图先进入列表；远端取消未确认时批次仍可见，读取失败不冒充删除完成。 */
  async function removeBatch(batchId: string): Promise<boolean | string> {
    let failure = "删除未提交，请重试。";
    const accepted = await perform(async () => {
      let result: { state: "pending" | "complete"; removal: PublishingBatchRemoval };
      try { result = await post({ action: "batch-remove", batchId }); }
      catch (error) { failure = (error as Error).message; throw error; }
      readRequest.current++;
      setView(old => old && { ...old, removals: [...(old.removals || []).filter(value => value.batchId !== batchId), result.removal] });
      setNotice(result.state === "complete" ? "批次已移出总览，视频和素材保留" : "删除已提交，等待设备确认停止发布");
      await refresh(); return true;
    });
    return accepted ? true : failure;
  }
  /** 单条覆盖保存新修订，仍以服务端分配和冲突检查为准。 */
  async function update(plan: PublishingPlan, rule: PublishingPlanRule, items: PublishingPlanItem[]) { return perform(async () => { const result = await post<PublishingPlan>({ action: "plan-update", planId: plan.id, revision: plan.revision, rule, items }); await refresh(); return result; }); }
  /** 已配置批次改期先生成独立预览，预览不会投递指令或创建上传任务。 */
  async function reschedulePreview(plan: PublishingPlan, rule: PublishingPlanRule, items: PublishingPlanItem[]) { return perform(async () => post<PublishingPlan>({ action: "plan-reschedule-preview", planId: plan.id, revision: plan.revision, rule, items })); }
  /** 明确确认新排期后更新原任务修订，远端实际时间继续等待设备核对。 */
  async function rescheduleConfirm(plan: PublishingPlan) { return perform(async () => { const result = await post<PublishingPlan>({ action: "plan-reschedule-confirm", planId: plan.id, revision: plan.revision, previewId: plan.schedulePreviewId }); await refresh(); setNotice("已提交排期，等待设备确认"); return result; }); }
  /** 两个主入口保留清晰的返回路径，设置入口不会重置正在准备的向导。 */
  function navigate(name: string) { setTab(name); setEditing(undefined); setNotice(""); }
  const heading = editing ? editing === "new" ? "新建配置" : "编辑配置" : tab;
  return <div className="workspace-shell publishing-workspace"><aside className="workspace-sidebar publishing-sidebar" aria-label="视频发布导航">
    <Link className="sidebar-link" href="/workspace"><VideoIcon /><span>直播工作台</span></Link><div className="sidebar-heading">视频发布</div>
    <nav aria-label="发布功能">{["发布视频", "我的发布"].map(name => <button className={"sidebar-link " + (tab === name ? "is-active" : "")} key={name} aria-current={tab === name ? "page" : undefined} onClick={() => navigate(name)}>{name}</button>)}</nav>
    <div className="publishing-settings-navigation"><button className={"sidebar-link " + (tab === "设置" ? "is-active" : "")} aria-current={tab === "设置" ? "page" : undefined} onClick={() => navigate("设置")}>设置</button></div>
    {view?.administrator && <div className="publishing-admin-navigation"><div className="sidebar-heading">管理员</div><button className={"sidebar-link " + (tab === "发布策略" ? "is-active" : "")} onClick={() => navigate("发布策略")}>发布策略</button></div>}
  </aside><main id="workspace" tabIndex={-1} className="main-wrapper publishing-shell"><header className="workspace-heading"><h1>{heading}</h1><button className="btn-ghost" disabled={busy} onClick={reload} aria-label="刷新发布状态"><RefreshIcon />刷新</button></header>
    {error && <div className="publishing-error" role="alert"><span>{error}</span><button onClick={reload}>刷新状态</button></div>}{notice && <div className="publishing-message" role="status"><span>{notice}</span><button className="btn-ghost" onClick={() => setNotice("")}>关闭</button></div>}
    {!view || !username ? <p className="publishing-empty" role="status">正在读取…</p> : <>
      {!accepted && <section className="publishing-warning publishing-onboarding"><p>使用前请同意 <Link href="/privacy">隐私政策</Link> 和 <Link href="/terms">服务条款</Link>。</p><button disabled={busy} onClick={() => void perform(async () => { await post({ action: "consent", version: PRIVACY_VERSION }); await refresh(); })}>同意并继续</button></section>}
      {!editing && tab !== "我的发布" && <div className="publishing-target"><label>设备<select aria-label="设备" disabled={busy} value={chosen} onChange={e => choose(e.target.value)}><option value="">请选择设备</option>{targets.map(value => <option key={value.agentId + ":" + value.instanceId} value={value.agentId + ":" + value.instanceId}>{value.name}</option>)}</select></label>{target && <><label>发布账号<select aria-label="发布账号" disabled={busy} value={account?.id || ""} onChange={e => chooseAccount(e.target.value)}><option value="">请选择发布账号</option>{accounts.map(value => <option key={value.id} value={value.id}>{value.channel || value.name}{value.status === "cleanup_pending" ? " · 清理中" : value.status !== "connected" ? " · 未连接" : ""}</option>)}</select></label><button disabled={busy || !accepted} onClick={() => void addAccount()}>添加账号</button>{tab === "发布视频" && account && <button className="btn-ghost" disabled={busy} onClick={() => { setSetting("发布账号"); navigate("设置"); }}>管理账号</button>}</>}</div>}
      {editing && target && <ProfileEditor key={editing === "new" ? chosen : editing.id} initial={editing === "new" ? undefined : editing} target={target} thumbnails={index?.thumbnails || []} save={save} cancel={() => setEditing(undefined)} busy={busy} />}
      {target && <div hidden={tab !== "发布视频" || !!editing}><PublishingWizard key={username + ":" + chosen + ":" + accountId + ":" + draftEpoch} username={username} target={target} root={index?.root || directory.root} directoryMessage={directory.message} directoryReading={directory.reading} retryDirectory={directory.retry} scanned={!!index} batches={index?.batches || []} profiles={profiles} profileId={profileId} selectProfile={setProfileId} plans={plans} jobs={jobs} allJobs={view.jobs} removals={view.removals} busy={busy} accepted={accepted} scan={scan} newProfile={() => void newProfile()} operate={operate} archive={archive} removeBatch={removeBatch} update={update} reschedulePreview={reschedulePreview} rescheduleConfirm={rescheduleConfirm} viewOverview={() => navigate("我的发布")}
        preview={(id, batchId, rule, items) => perform(async () => { const result = await post<PublishingPlan>({ action: "plan-preview", profileId: id, batchId, rule, items }); await refresh(); return result; })}
        confirm={async (plan, ai, replaceJobIds) => !!await perform(async () => { await post({ action: "plan-confirm", planId: plan.id, revision: plan.revision, ai, temporaryPrivateTitle: true, ...(replaceJobIds.length ? { replaceJobIds } : {}) }); await refresh(); setNotice("发布计划已配置"); return true; })} />
      </div>}
      {!target && tab !== "我的发布" && <div className="publishing-empty"><h2>暂无设备</h2></div>}
      {!editing && tab === "我的发布" && <MyPublishing plans={view.plans || []} jobs={view.jobs} targets={(view.accounts || []).map(account => ({ agentId: account.agentId, instanceId: account.instanceId, channelId: account.channelId, channel: account.channel, name: targets.find(target => target.agentId === account.agentId && target.instanceId === account.instanceId)?.name || account.name }))} allJobs={view.jobs} removals={view.removals} busy={busy} operate={operate} archive={archive} removeBatch={removeBatch} />}
      {!editing && tab === "设置" && <><nav className="publishing-subnav" aria-label="发布设置">{["发布配置", "发布账号"].map(name => <button key={name} aria-pressed={setting === name} className={setting === name ? "is-active" : "btn-ghost"} onClick={() => setSetting(name)}>{name}</button>)}</nav>
        {setting === "发布配置" ? <section aria-label="发布配置"><div className="publishing-section-heading"><span>{profiles.length} 个配置</span><button disabled={busy || !target || !accepted} onClick={() => void newProfile()}>新建配置</button></div>{profiles.map(profile => <article className="publishing-profile-row" key={profile.id}><div><h2>{profile.name}</h2><p>{visibilityLabel(profile)}</p></div><button onClick={() => setEditing(profile)}>编辑</button></article>)}</section>
          : <><div className="publishing-section-heading"><h2>发布账号</h2></div>{accounts.map(value => <div key={value.id}><ChannelBinding account={value} busy={busy} disabled={!accepted} connect={() => void connectAccount(value.id)} /><details className="publishing-details"><summary>授权与数据 · {value.channel || value.name}</summary><DataSettings accountName={value.channel || value.name} disabled={value.status === "cleanup_pending"} busy={busy} cleanups={view.cleanups.filter(cleanup => cleanup.accountId === value.id)} readAt={readAt} remove={() => removeAccount(value.id)} /></details></div>)}{!accounts.length && <div className="publishing-empty"><h2>还没有发布账号</h2></div>}{view.profiles.some(profile => !profile.accountId && profile.agentId + ":" + profile.instanceId === chosen) && <details className="publishing-details"><summary>旧版任务授权</summary><DataSettings key={chosen} disabled={!target} busy={busy} cleanups={cleanups} readAt={readAt} remove={async () => { await perform(async () => { await post({ action: "cleanup", agentId: target!.agentId, instanceId: target!.instanceId, confirmed: true }); await refresh(); setIndex(undefined); try { localStorage.removeItem("livenest-publishing-draft:" + username + ":" + chosen); } catch { /* 浏览器存储不可用不阻止清理Cloud数据。 */ } setDraftEpoch(value => value + 1); setNotice("删除请求已保存，等待设备确认"); }); }} /></details>}</>}
      </>}
      {!editing && tab === "发布策略" && view.administrator && <PolicyEditor initial={view.policy} quota={view.quota} busy={busy} save={async policy => { await perform(async () => { await post({ action: "policy", policy }); await refresh(); setNotice("策略已保存"); }); }} />}
    </>}
  </main></div>;
}
