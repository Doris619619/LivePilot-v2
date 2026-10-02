/** 发布方式配置表单；发布时间归属计划，封面和高级设置按需展开。 */
"use client";
import { useState, type FormEvent } from "react";
import type { PublishingProfile } from "@/shared/publishing";
import { api } from "../client-request";
import type { Playlist } from "@/shared/broadcast";
export type PublishingTarget = { agentId: string; instanceId: string; name: string; accountId?: string; channelId?: string; channel?: string };
type Props = { initial?: PublishingProfile; target: PublishingTarget; thumbnails: string[]; save(profile: PublishingProfile): Promise<void>; cancel(): void; busy: boolean };
/** 默认值可编辑；儿童内容仍须在表单中明确选择。 */
export function newProfile(target: PublishingTarget): PublishingProfile {
  return {
    id: crypto.randomUUID(), revision: 1, name: "常规发布", agentId: target.agentId, instanceId: target.instanceId, ...(target.accountId ? { accountId: target.accountId } : {}), channelId: target.channelId || "",
    titleTemplate: "{{packageName}}", descriptionTemplate: "", tags: [], categoryId: "10", playlistIds: [], privacy: "public", scheduled: true, madeForKids: false,
    license: "youtube", embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: "matching",
    ai: { enabled: false, language: "English", prompt: "根据素材主题生成准确、自然的视频标题和说明。", fallbackTitle: "{{packageName}}", fallbackDescription: "" },
    schedule: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", weekdays: [1, 3, 5, 7], localTime: "20:00", startDate: new Date().toLocaleDateString("en-CA"), preuploadDays: 28 },
  };
}
/** 编辑只保存新版本，不修改已确认的批次快照。 */
export default function ProfileEditor({ initial, target, thumbnails, save, cancel, busy }: Props) {
  const [value, setValue] = useState(() => initial || newProfile(target));
  const [childrenChoice, setChildrenChoice] = useState(initial ? String(initial.madeForKids) : "");
  const [playlists, setPlaylists] = useState<Playlist[]>(); const [reading, setReading] = useState(false); const [playlistError, setPlaylistError] = useState("");
  /** 读取频道列表名称；Agent 执行时仍核对归属与成员关系。 */
  async function loadPlaylists() {
    setReading(true); setPlaylistError("");
    try {
      const data = await api<{ playlists: Playlist[] }>(target.accountId ? "/api/publishing" : "/api/broadcast-assets", { method: "POST", timeoutMs: 60000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify(target.accountId ? { action: "account-playlists", accountId: target.accountId } : { action: "playlists", agentId: target.agentId, instanceId: target.instanceId }) });
      setPlaylists(data.playlists);
    } catch (e) { setPlaylistError((e as Error).message); } finally { setReading(false); }
  }
  /** 原生表单校验后提交完整 Profile，儿童内容不由 AI 推断。 */
  async function submit(event: FormEvent) {
    event.preventDefault(); await save({ ...value, revision: initial ? initial.revision + 1 : 1, madeForKids: childrenChoice === "true" });
  }
  return <form className="publishing-form" onSubmit={e => void submit(e)}>
    <p className="publishing-editor-target">{target.channel || target.name}</p>
    <label>配置名称<input required value={value.name} maxLength={80} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
    <fieldset><legend>视频文案</legend>
      <label>标题模板<input required value={value.titleTemplate} onChange={e => setValue({ ...value, titleTemplate: e.target.value })} /></label>
      <label>说明模板<textarea rows={3} value={value.descriptionTemplate} onChange={e => setValue({ ...value, descriptionTemplate: e.target.value })} /></label>
      <details className="publishing-details publishing-template-help"><summary>模板变量</summary><p>{"{{packageName}} 发布包 · {{batchName}} 批次 · {{filenameStem}} 文件名 · {{index}} 顺序 · {{publishDate}} 发布日期"}</p></details>
      <label className="publishing-check"><input type="checkbox" checked={value.ai.enabled} onChange={e => setValue({ ...value, ai: { ...value.ai, enabled: e.target.checked } })} />AI 自动生成标题和说明</label>
      {value.ai.enabled && <div className="publishing-ai-fields">
        <p className="publishing-hint">使用设备上的 DeepSeek。批次确认时单独授权。</p>
        <div className="publishing-fields"><label>生成语言<input required value={value.ai.language} onChange={e => setValue({ ...value, ai: { ...value.ai, language: e.target.value } })} /></label><label>失败兜底标题<input required value={value.ai.fallbackTitle} onChange={e => setValue({ ...value, ai: { ...value.ai, fallbackTitle: e.target.value } })} /></label></div>
        <label>生成要求<textarea required rows={3} value={value.ai.prompt} onChange={e => setValue({ ...value, ai: { ...value.ai, prompt: e.target.value } })} /></label>
        <label>失败兜底说明<textarea rows={3} value={value.ai.fallbackDescription} onChange={e => setValue({ ...value, ai: { ...value.ai, fallbackDescription: e.target.value } })} /></label>
      </div>}
    </fieldset>
    <fieldset><legend>发布方式</legend>
      <div className="publishing-fields"><label>可见性<select value={value.privacy} onChange={e => setValue({ ...value, privacy: e.target.value as PublishingProfile["privacy"], scheduled: e.target.value === "public" })}><option value="public">公开</option><option value="private">私密</option><option value="unlisted">不公开</option></select></label><label>是否专为儿童制作<select required value={childrenChoice} onChange={e => setChildrenChoice(e.target.value)}><option value="">请选择</option><option value="false">否</option><option value="true">是</option></select></label></div>
      <div className="publishing-fields"><label>封面<select value={value.thumbnailMode} onChange={e => setValue({ ...value, thumbnailMode: e.target.value as PublishingProfile["thumbnailMode"] })}><option value="matching">使用发布包封面</option><option value="fixed">固定图片</option><option value="none">YouTube 自动选择</option></select></label>{value.thumbnailMode === "fixed" && <label>固定图片<input required list="publishing-thumbnails" value={value.thumbnailFilename || ""} onChange={e => setValue({ ...value, thumbnailFilename: e.target.value })} /><datalist id="publishing-thumbnails">{thumbnails.map(name => <option key={name}>{name}</option>)}</datalist></label>}</div>
    </fieldset>
    <details className="publishing-details"><summary>标签与播放列表{value.playlistIds.length > 0 ? " · " + value.playlistIds.length + " 个已选" : ""}</summary>
      <label>标签 · 逗号分隔<input value={value.tags.join(",")} onChange={e => setValue({ ...value, tags: e.target.value.split(",").filter(Boolean) })} /></label>
      <div className="publishing-section-heading"><span>播放列表</span><button type="button" disabled={busy || reading} onClick={() => void loadPlaylists()}>{reading ? "读取中…" : "读取播放列表"}</button></div>
      {playlistError && <p className="publishing-validation" role="alert">{playlistError}</p>}
      {playlists?.map(item => <label className="publishing-check" key={item.id}><input type="checkbox" checked={value.playlistIds.includes(item.id)} onChange={e => setValue({ ...value, playlistIds: e.target.checked ? [...value.playlistIds, item.id] : value.playlistIds.filter(id => id !== item.id) })} />{item.title}</label>)}
    </details>
    <details className="publishing-details"><summary>高级设置</summary>
      <div className="publishing-fields"><label>分类<select value={value.categoryId} onChange={e => setValue({ ...value, categoryId: e.target.value })}><option value="10">音乐</option><option value="22">人物与博客</option><option value="24">娱乐</option><option value="27">教育</option><option value="28">科学与技术</option><option value="20">游戏</option><option value="1">电影与动画</option></select></label><label>授权许可<select value={value.license} onChange={e => setValue({ ...value, license: e.target.value as PublishingProfile["license"] })}><option value="youtube">标准 YouTube 许可</option><option value="creativeCommon">Creative Commons</option></select></label></div>
      {([ ["embeddable", "允许嵌入"], ["notifySubscribers", "通知频道订阅者"], ["containsSyntheticMedia", "含需披露的修改或合成内容"] ] as const).map(([key, label]) => <label key={key} className="publishing-check"><input type="checkbox" checked={value[key]} onChange={e => setValue({ ...value, [key]: e.target.checked })} />{label}</label>)}
    </details>
    <div className="publishing-actions"><button className="btn-primary" type="submit" disabled={busy || reading}>{busy ? "保存中…" : "保存配置"}</button><button type="button" onClick={cancel}>返回</button></div>
  </form>;
}
