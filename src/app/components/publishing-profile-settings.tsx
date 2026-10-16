/** 设置中心的视频发布配置包；按登录账号管理通用模板并保护未保存草稿。 */
"use client";
import { useEffect, useState } from "react";
import type { PublishingTemplate } from "@/shared/publishing-template";
import { api } from "../client-request";
import ProfileEditor from "../publishing/profile-editor";
import { visibilityLabel } from "../publishing/display";
import { ConfigurationStepTitle } from "./configuration-step";
import "../publishing/publishing.css";

type Catalog = { profiles: PublishingTemplate[] };

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
  useEffect(() => {
    const abort = new AbortController();
    api<Catalog>("/api/publishing-templates", { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setCatalog(result); }).catch(() => { if (!abort.signal.aborted) setError("无法读取视频发布配置包，请重试。"); });
    return () => abort.abort();
  }, [revision]);
  const profiles = catalog?.profiles || [];

  /** 成功后通知工作台刷新可选配置，失败保留原表单与修订号供重试。 */
  async function save(profile: PublishingTemplate) {
    if (busy) return;
    setBusy(true); onSaving(true); setError("");
    try {
      const saved = await api<PublishingTemplate>("/api/publishing-templates", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify(profile) });
      setCatalog(current => current && { ...current, profiles: [...current.profiles.filter(item => item.id !== saved.id), saved] });
      setEditing(undefined); setDirty(false); setConfirmBack(false); setNotice(`已保存「${saved.name}」`);
      window.dispatchEvent(new Event("livenest-publishing-profiles-saved"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请重试。"); }
    finally { setBusy(false); onSaving(false); }
  }
  /** 返回列表前确认丢弃；分类和类型切换不经过这里，始终保留编辑器。 */
  function back() { if (dirty) setConfirmBack(true); else setEditing(undefined); }

  return <section className="publishing-profile-settings publishing-shell" aria-label="管理视频发布配置包">
    {!catalog && !error && <p role="status">读取视频发布配置包…</p>}
    {catalog && <><h4 className="configuration-step-title"><ConfigurationStepTitle number={1}>{editing ? "命名配置包" : "选择或创建配置包"}</ConfigurationStepTitle></h4>
      {editing ? <ProfileEditor key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? undefined : editing} save={save} cancel={back} busy={busy} onDirtyChange={setDirty} numbered /> : <>
        <div className="api-settings-actions"><button type="button" disabled={busy} onClick={() => { setEditing("new"); setNotice(""); }}>新建视频发布配置包</button></div>
        {profiles.length === 0 && <p className="field-hint">还没有配置包。保存后可在发布视频时重复使用。</p>}
        {profiles.map(profile => <article className="publishing-profile-row" key={profile.id}><div><h4>{profile.name}</h4><p>{visibilityLabel(profile)}</p></div><button type="button" disabled={busy} onClick={() => { setEditing(profile); setNotice(""); }}>编辑<span className="visually-hidden"> {profile.name}</span></button></article>)}
      </>}
    </>}
    {confirmBack && <div role="alert"><p>放弃未保存的修改并返回配置包列表？</p><div className="api-settings-actions"><button type="button" onClick={() => setConfirmBack(false)}>继续编辑配置包</button><button type="button" onClick={() => { setEditing(undefined); setDirty(false); setConfirmBack(false); setError(""); }}>放弃修改并返回</button></div></div>}
    {error && <div role="alert"><p>{error}</p>{!editing && <button type="button" disabled={busy} onClick={() => { setError(""); setRevision(value => value + 1); }}>重新读取配置包</button>}</div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
