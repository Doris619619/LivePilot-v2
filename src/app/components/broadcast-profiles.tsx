/** 直播配置工具条：命名保存、选择复用、显式覆盖与撤销，所有操作只改变草稿或配置元数据。 */
"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "../client-request";
import { defaultBroadcast } from "@/shared/broadcast";
import { broadcastProfileSelectionSchema, broadcastProfileSignature, type BroadcastProfile, type BroadcastProfileSelection, type BroadcastProfileTarget } from "@/shared/broadcast-profiles";
import type { Selection } from "@/shared/types";
import styles from "./broadcast-profiles.module.css";

type Mode = { kind: "new"; id: string } | { kind: "rename" | "delete" } | { kind: "apply"; profile: BroadcastProfile };
type Props = { target: BroadcastProfileTarget; value: Selection; disabled: boolean; onApply(value: Selection): void; onBusyChange(busy: boolean): void };

/** 外层按用户和频道提供稳定 key；加载与失败不触碰表单，切换配置保留一次撤销。 */
export default function BroadcastProfiles({ target, value, disabled, onApply, onBusyChange }: Props) {
  const [profiles, setProfiles] = useState<BroadcastProfile[]>();
  const [activeId, setActiveId] = useState("");
  const [mode, setMode] = useState<Mode>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<{ value: BroadcastProfileSelection; activeId: string }>();
  const current = { ...value, broadcast: value.broadcast || defaultBroadcast() };
  const latest = useRef(current);
  const targetRef = useRef(target);
  const inFlight = useRef(false);
  const editorWasOpen = useRef(false);
  const selected = profiles?.find(profile => profile.id === activeId);
  const dirty = !!selected && broadcastProfileSignature(selected.selection) !== broadcastProfileSignature(current);
  const locked = disabled || busy;
  const prefix = `live-profile-${target.agentId || "local"}-${target.instanceId}`;

  /** 初次异步读取只用最新草稿识别配置，不覆盖用户在等待期间的输入。 */
  useEffect(() => { latest.current = { ...value, broadcast: value.broadcast || defaultBroadcast() }; }, [value]);

  /** 内联编辑结束后把键盘焦点还给配置选择，不让已移除的输入框吞掉焦点。 */
  useEffect(() => {
    if (editorWasOpen.current && !mode) document.getElementById(prefix)?.focus();
    editorWasOpen.current = !!mode;
  }, [mode, prefix]);

  /** 自动读取可取消；不把读取失败伪装成空列表，也不自动应用配置覆盖草稿。 */
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(Object.entries(targetRef.current).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    void api<{ profiles: BroadcastProfile[] }>("/api/broadcast-profiles?" + query, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setProfiles(result.profiles);
      setActiveId(result.profiles.find(profile => broadcastProfileSignature(profile.selection) === broadcastProfileSignature(latest.current))?.id || "");
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "直播配置读取失败，请重试。"); });
    return () => controller.abort();
  }, []);

  /** 显式刷新只更新配置列表，保留当前编辑值供用户决定是否重新保存。 */
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const query = new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const result = await api<{ profiles: BroadcastProfile[] }>("/api/broadcast-profiles?" + query);
      setProfiles(result.profiles); setNotice("配置列表已更新，当前草稿已保留。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取失败，请重试。"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  /** 保存或删除采用服务端修订号；失败保持输入与重试 ID，不触发直播命令。 */
  async function persist(action: "save" | "delete", renameOnly = false) {
    if (locked || inFlight.current || !profiles) return;
    const creating = mode?.kind === "new";
    if (!creating && !selected) return;
    const selection = renameOnly ? selected!.selection : current;
    if (action === "save") {
      const checked = broadcastProfileSelectionSchema.safeParse(selection);
      if (!checked.success) { setError(checked.error.issues[0]?.message || "请检查直播配置。"); return; }
    }
    const id = creating ? mode.id : selected!.id;
    const profileName = (creating || renameOnly ? name : selected!.name).trim();
    if (action === "save" && !profileName) { setError("请填写配置名称。"); return; }
    inFlight.current = true; setBusy(true); onBusyChange(true); setError(""); setNotice("");
    try {
      const result = await api<{ profiles: BroadcastProfile[] }>("/api/broadcast-profiles", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ action, target, id, revision: creating ? 0 : selected!.revision, ...(action === "save" ? { name: profileName, selection } : {}) }) });
      setProfiles(result.profiles); setActiveId(action === "delete" ? "" : id); setMode(undefined); setUndo(undefined);
      setNotice(action === "delete" ? "配置已删除，当前草稿已保留。" : `已保存「${profileName}」`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请重试。当前草稿已保留。"); }
    finally { inFlight.current = false; setBusy(false); onBusyChange(false); }
  }

  /** 应用完整快照并保留撤销；实际文件存在性继续由原素材选择与开播校验处理。 */
  function apply(profile: BroadcastProfile) {
    if (locked) return;
    setUndo({ value: current, activeId }); onApply(structuredClone(profile.selection)); setActiveId(profile.id); setMode(undefined); setError(""); setNotice(`已使用「${profile.name}」`);
  }

  /** 有内容的草稿需要显式确认替换；选择下拉项本身不会悄悄丢弃编辑。 */
  function choose(id: string) {
    const profile = profiles?.find(item => item.id === id);
    if (!profile || locked) return;
    setError(""); setNotice("");
    if (broadcastProfileSignature(profile.selection) === broadcastProfileSignature(current)) { setActiveId(id); return; }
    setMode({ kind: "apply", profile });
  }

  return <section className={styles.root} aria-label="直播配置">
    <div className={styles.toolbar}>
      <label className={styles.picker} htmlFor={prefix}>直播配置
        <select id={prefix} aria-label="直播配置" value={activeId && selected ? activeId : ""} disabled={locked || !profiles?.length} onChange={event => choose(event.target.value)}>
          <option value="">{profiles ? profiles.length ? "选择已保存的配置" : "尚未保存配置" : error ? "配置读取失败" : "正在读取配置…"}</option>
          {profiles?.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      <div className={styles.actions}>
        {selected && <button type="button" className="btn-secondary" disabled={locked || !dirty || !!mode} onClick={() => void persist("save")}>保存修改</button>}
        <button type="button" className="btn-secondary" disabled={locked || !profiles || !!mode} onClick={() => { setName(""); setMode({ kind: "new", id: crypto.randomUUID() }); setError(""); setNotice(""); }}>另存为</button>
        {selected && <details className={styles.manage}><summary aria-label="管理直播配置">管理</summary><div className={styles.actions}><button type="button" className="btn-ghost" disabled={locked || !!mode} onClick={() => { setName(selected.name); setMode({ kind: "rename" }); setError(""); }}>重命名</button><button type="button" className="btn-ghost" disabled={locked || !!mode} onClick={() => { setMode({ kind: "delete" }); setError(""); }}>删除配置</button></div></details>}
      </div>
    </div>
    {dirty && <span className={styles.hint}>本场有未保存的修改</span>}
    {mode && <div className={styles.editor}>
      {(mode.kind === "new" || mode.kind === "rename") && <form onSubmit={event => { event.preventDefault(); void persist("save", mode.kind === "rename"); }}>
        <label htmlFor={`${prefix}-name`}>配置名称</label>
        <div className={styles.nameRow}><input id={`${prefix}-name`} autoFocus maxLength={60} required value={name} disabled={locked} onChange={event => setName(event.target.value)} placeholder="例如：晚间 Lofi" /><button disabled={locked || !name.trim()}>{busy ? "保存中…" : "保存配置"}</button><button type="button" className="btn-ghost" disabled={locked} onClick={() => { setMode(undefined); setError(""); }}>取消</button></div>
      </form>}
      {mode.kind === "apply" && <><p>使用「{mode.profile.name}」替换当前文案、音视频、封面和直播选项？</p><div className={styles.actions}><button type="button" disabled={locked} onClick={() => apply(mode.profile)}>使用配置</button><button type="button" className="btn-secondary" disabled={locked} onClick={() => setMode(undefined)}>保留当前草稿</button></div></>}
      {mode.kind === "delete" && <><p>删除「{selected?.name}」？当前草稿不受影响。</p><div className={styles.actions}><button type="button" disabled={locked} onClick={() => void persist("delete")}>确认删除</button><button type="button" className="btn-secondary" disabled={locked} onClick={() => setMode(undefined)}>取消</button></div></>}
    </div>}
    {notice && <div className={styles.feedback}><span role="status">{notice}</span>{undo && <button type="button" className="btn-ghost" disabled={locked} onClick={() => { onApply(undo.value); setActiveId(undo.activeId); setUndo(undefined); setNotice("已恢复切换前的草稿。"); }}>撤销切换</button>}</div>}
    {error && <div className={styles.feedback}><p role="alert">{error}</p><button type="button" className="btn-ghost" disabled={busy} onClick={() => void refresh()}>重新读取配置</button></div>}
  </section>;
}
