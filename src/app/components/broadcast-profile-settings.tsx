/** 设置中的直播配置包目录：明确新建与编辑入口，保留未保存草稿和失败重试。 */
"use client";
import { useEffect, useRef, useState } from "react";
import type { BroadcastProfile, BroadcastProfileSelection } from "@/shared/broadcast-profiles";
import { defaultBroadcast } from "@/shared/broadcast";
import { defaultLiveChatConfig } from "@/shared/live-chat";
import { api } from "../client-request";
import BroadcastProfileEditor from "./broadcast-profile-editor";

/** 打开编辑器才显示规则；分类切换保持挂载，保存不更改工作台的本场配置。 */
export default function BroadcastProfileSettings({ onSaving }: { onSaving(value: boolean): void }) {
  const [profiles, setProfiles] = useState<BroadcastProfile[]>();
  const [editing, setEditing] = useState<BroadcastProfile>();
  const [dirty, setDirty] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);
  const [deleting, setDeleting] = useState<BroadcastProfile>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    api<{ profiles: BroadcastProfile[] }>("/api/broadcast-profiles", { signal: abort.signal }).then(result => { if (!abort.signal.aborted) setProfiles(result.profiles); }).catch(() => { if (!abort.signal.aborted) setError("无法读取直播配置包，请重试。"); });
    return () => abort.abort();
  }, [reload]);

  /** 新建使用独立默认草稿；复制使用新 ID，失败重试始终复用该 ID。 */
  function open(profile?: BroadcastProfile, copy = false) {
    const draft = profile && !copy ? profile : { id: crypto.randomUUID(), revision: 0, name: copy ? `${profile!.name.slice(0, 55)} 副本` : "", updatedAt: 0, selection: profile ? structuredClone(profile.selection) : { video: "", music: "", videoAudio: false, broadcast: { ...defaultBroadcast(), liveChat: { ...defaultLiveChatConfig } } } };
    setEditing(draft); setDirty(false); setConfirmBack(false); setDeleting(undefined); setError(""); setNotice("");
    requestAnimationFrame(() => heading.current?.focus());
  }
  /** 返回前保护未保存参数，回到列表后恢复可见的键盘焦点。 */
  function leave() { setEditing(undefined); setDirty(false); setConfirmBack(false); setError(""); requestAnimationFrame(() => createButton.current?.focus()); }
  /** 只有保存/确认删除才写入目录，保留修订冲突和可重试错误。 */
  async function persist(action: "save" | "delete", name?: string, selection?: BroadcastProfileSelection) {
    const profile = action === "save" ? editing : deleting;
    if (!profile || inFlight.current) return;
    inFlight.current = true; setBusy(true); onSaving(true); setError("");
    try {
      const result = await api<{ profiles: BroadcastProfile[] }>("/api/broadcast-profiles", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ action, id: profile.id, revision: profile.revision, ...(action === "save" ? { name, selection } : {}) }) });
      setProfiles(result.profiles); leave(); setDeleting(undefined);
      setNotice(action === "save" ? `已保存「${name?.trim()}」` : `已删除「${profile.name}」`);
      window.dispatchEvent(new Event("livenest-broadcast-profiles-saved"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请重试。"); }
    finally { inFlight.current = false; setBusy(false); onSaving(false); }
  }
  return <section className="profile-library" aria-label="管理直播配置包">
    {editing ? <>
      <h4 ref={heading} tabIndex={-1} className="profile-editor-heading">{editing.revision ? "编辑直播配置包" : "新建直播配置包"}</h4>
      <BroadcastProfileEditor key={editing.id} initial={editing} busy={busy} save={(name, selection) => persist("save", name, selection)} back={() => dirty ? setConfirmBack(true) : leave()} onDirtyChange={setDirty} />
    </> : <>
      <div className="profile-library-toolbar"><h4>已保存的配置包</h4><button ref={createButton} type="button" className="btn-primary" disabled={busy || !profiles} onClick={() => open()}>新建直播配置包</button></div>
      {!profiles && !error && <p role="status">读取直播配置包…</p>}
      {profiles?.length === 0 && <p className="field-hint">还没有直播配置包</p>}
      {profiles?.map(profile => <article className="profile-library-row" key={profile.id}>
        <div><h4>{profile.name}</h4><p>{({ public: "公开", private: "私密", unlisted: "不公开列出" })[profile.selection.broadcast.privacy]} · {profile.selection.broadcast.madeForKids ? "面向儿童" : "不面向儿童"}</p></div>
        <div className="profile-row-actions"><button type="button" disabled={busy || !!deleting} onClick={() => open(profile)}>编辑<span className="visually-hidden"> {profile.name}</span></button><button type="button" className="btn-ghost" disabled={busy || !!deleting} onClick={() => open(profile, true)}>复制<span className="visually-hidden"> {profile.name}</span></button><button type="button" className="btn-ghost" disabled={busy || !!deleting} onClick={() => { setDeleting(profile); setError(""); setNotice(""); }}>删除<span className="visually-hidden"> {profile.name}</span></button></div>
      </article>)}
    </>}
    {confirmBack && <div role="alert"><p>放弃未保存的修改并返回配置包列表？</p><div className="api-settings-actions"><button type="button" onClick={() => setConfirmBack(false)}>继续编辑配置包</button><button type="button" onClick={leave}>放弃修改并返回</button></div></div>}
    {deleting && <div role="alert"><p>删除「{deleting.name}」？</p><div className="api-settings-actions"><button type="button" disabled={busy} onClick={() => void persist("delete")}>确认删除</button><button type="button" disabled={busy} onClick={() => { setDeleting(undefined); setError(""); }}>取消</button></div></div>}
    {error && <div role="alert"><p>{error}</p>{!editing && <button type="button" disabled={busy} onClick={() => { setError(""); setReload(value => value + 1); }}>重新读取配置包</button>}</div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
