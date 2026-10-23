/** 设置中心的视频发布配置包；按登录账号管理通用模板并保护未保存草稿。 */
"use client";
import { useEffect, useRef, useState } from "react";
import type { PublishingTemplate } from "@/shared/publishing-template";
import { api } from "../client-request";
import ProfileEditor from "../publishing/profile-editor";
import { visibilityLabel } from "../publishing/display";
import { ConfigurationStepTitle } from "./configuration-step";
import "../publishing/publishing.css";

type Catalog = { profiles: PublishingTemplate[] };
const pageSize = 20;

/** 目录不需要发布账号或设备；保存不创建发布计划，不改写既有批次快照。 */
export default function PublishingProfileSettings({ onSaving }: { onSaving(value: boolean): void }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [editing, setEditing] = useState<PublishingTemplate | "new">();
  const [dirty, setDirty] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(0);
  const root = useRef<HTMLElement>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const returnProfile = useRef<string | undefined>(undefined);
  const restoreListFocus = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    api<Catalog>("/api/publishing-templates", { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setCatalog(result); }).catch(() => { if (!abort.signal.aborted) setError("无法读取视频发布配置包，请重试。"); });
    return () => abort.abort();
  }, [revision]);
  const profiles = catalog?.profiles || [];
  const pages = Math.max(1, Math.ceil(profiles.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  /** 切换列表/编辑器时聚焦新视图；保存请求结束后才恢复到可操作的目录入口。 */
  useEffect(() => {
    if (editing) { editorHeading.current?.focus(); return; }
    if (!restoreListFocus.current || busy) return;
    const target = returnProfile.current && root.current?.querySelector<HTMLButtonElement>(`button[data-profile-id="${CSS.escape(returnProfile.current)}"]`);
    (target || createButton.current)?.focus();
    restoreListFocus.current = false;
  }, [editing, busy, catalog, currentPage]);
  /** 放弃确认在当前滚动正文中出现时，先聚焦保留草稿的安全操作。 */
  useEffect(() => { if (confirmBack) continueButton.current?.focus(); }, [confirmBack]);

  /** 记住目录入口所在行，编辑期间不重建其他分类的草稿。 */
  function open(profile?: PublishingTemplate) {
    returnProfile.current = profile?.id;
    setEditing(profile || "new"); setDirty(false); setConfirmBack(false); setNotice(""); setError("");
  }
  /** 关闭编辑器后在其原页面恢复焦点；失败响应不经过这里，继续保留输入。 */
  function leave() {
    restoreListFocus.current = true;
    setEditing(undefined); setDirty(false); setConfirmBack(false); setError("");
  }
  /** 翻页后从新页第一条配置继续键盘阅读，避免焦点停在列表末尾跳过全部新结果。 */
  function changePage(next: number) {
    const destination = Math.max(0, Math.min(pages - 1, next));
    returnProfile.current = profiles[destination * pageSize]?.id;
    restoreListFocus.current = true; setPage(destination);
  }

  /** 成功后通知工作台刷新可选配置，失败保留原表单与修订号供重试。 */
  async function save(profile: PublishingTemplate) {
    if (busy) return;
    setBusy(true); onSaving(true); setError("");
    try {
      const saved = await api<PublishingTemplate>("/api/publishing-templates", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify(profile) });
      const savedIndex = profiles.findIndex(item => item.id === saved.id);
      setCatalog(current => current && { ...current, profiles: savedIndex < 0 ? [...current.profiles, saved] : current.profiles.map(item => item.id === saved.id ? saved : item) });
      returnProfile.current = saved.id; setPage(Math.floor((savedIndex < 0 ? profiles.length : savedIndex) / pageSize));
      leave(); setNotice(`已保存「${saved.name}」`);
      window.dispatchEvent(new Event("livenest-publishing-profiles-saved"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请重试。"); }
    finally { setBusy(false); onSaving(false); }
  }
  /** 返回列表前确认丢弃；分类和类型切换不经过这里，始终保留编辑器。 */
  function back() { if (dirty) setConfirmBack(true); else leave(); }

  return <section ref={root} className="publishing-profile-settings publishing-shell profile-library" aria-label="管理视频发布配置包">
    {!catalog && !error && <p role="status">读取视频发布配置包…</p>}
    {catalog && <>{editing && <><h4 ref={editorHeading} tabIndex={-1} className="profile-editor-heading">{editing === "new" ? "新建视频发布配置包" : "编辑视频发布配置包"}</h4><h4 className="configuration-step-title"><ConfigurationStepTitle number={1}>配置名称</ConfigurationStepTitle></h4></>}
      {editing ? <ProfileEditor key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? undefined : editing} save={save} cancel={back} busy={busy} onDirtyChange={setDirty} numbered /> : <>
        <div className="profile-library-toolbar"><h4>已保存的配置包</h4><button ref={createButton} type="button" className="btn-primary" disabled={busy} onClick={() => open()}>新建视频发布配置包</button></div>
        {profiles.length === 0 && <p className="field-hint">还没有视频发布配置包</p>}
        {profiles.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(profile => <article className="profile-library-row" key={profile.id}><div><h4>{profile.name}</h4><p>{visibilityLabel(profile)}</p></div><div className="profile-row-actions"><button type="button" data-profile-id={profile.id} disabled={busy} onClick={() => open(profile)}>编辑<span className="visually-hidden"> {profile.name}</span></button></div></article>)}
        {pages > 1 && <nav className="profile-library-pagination" aria-label="视频发布配置包分页"><button type="button" disabled={busy || currentPage === 0} onClick={() => changePage(currentPage - 1)}>上一页</button><span role="status">第 {currentPage + 1} / {pages} 页 · 共 {profiles.length} 个</span><button type="button" disabled={busy || currentPage === pages - 1} onClick={() => changePage(currentPage + 1)}>下一页</button></nav>}
      </>}
    </>}
    {confirmBack && <div role="alert"><p>放弃未保存的修改并返回配置包列表？</p><div className="api-settings-actions"><button ref={continueButton} type="button" onClick={() => { setConfirmBack(false); editorHeading.current?.focus(); }}>继续编辑配置包</button><button type="button" onClick={leave}>放弃修改并返回</button></div></div>}
    {error && <div role="alert"><p>{error}</p>{!editing && <button type="button" disabled={busy} onClick={() => { setError(""); setRevision(value => value + 1); }}>重新读取配置包</button>}</div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
