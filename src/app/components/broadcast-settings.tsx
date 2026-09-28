/** 直播前填写可同步到 YouTube 的详情，并预览观众看到的标题、封面和公开范围。 */
"use client";
import { useState } from "react";
import BroadcastAi from "./broadcast-ai";
import { api } from "../client-request";
import { defaultBroadcast, type BroadcastDetails, type Playlist } from "@/shared/broadcast";
import type { InstanceDescriptor } from "@/shared/types";
import { ExternalLinkIcon, YouTubeIcon } from "./icons";

/** 配置只作用于当前实例；上传中锁定表单，防止异步完成覆盖新草稿。 */
export default function BroadcastSettings({ id, instance, value, disabled, channel, broadcastId, onChange, onBusyChange }: {
  id: string; instance: InstanceDescriptor; value?: BroadcastDetails; disabled: boolean; channel: string; broadcastId?: string;
  onChange: (value: BroadcastDetails) => void; onBusyChange: (busy: boolean) => void;
}) {
  const details = value || defaultBroadcast();
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [playlists, setPlaylists] = useState<Playlist[]>();
  const [preview, setPreview] = useState<{ id: string; url: string }>();
  const locked = disabled || !!working;
  const studio = broadcastId ? `https://studio.youtube.com/video/${encodeURIComponent(broadcastId)}/edit` : "https://studio.youtube.com";
  const privacy = { public: "公开", unlisted: "不公开列出", private: "私密" }[details.privacy];
  /** 每个请求携带设备及实例，失败保留原来已完成的设置。 */
  async function requestAssets(action: "playlists" | "thumbnail", input?: unknown) {
    return api<{ playlists?: Playlist[]; id?: string; name?: string }>("/api/broadcast-assets", {
      method: "POST", timeoutMs: 60_000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" },
      body: JSON.stringify({ action, instanceId: instance.id, ...(instance.agentId ? { agentId: instance.agentId } : {}), ...(input ? { input } : {}) }),
    });
  }
  /** 用户显式刷新时才读取频道列表，不在每次状态轮询中消耗配额。 */
  async function loadPlaylists() {
    setWorking("playlists"); setError(""); onBusyChange(true);
    try { const result = await requestAssets("playlists"); setPlaylists(result.playlists || []); }
    catch (e) { setError(e instanceof Error ? e.message : "播放列表读取失败，请重试。"); }
    finally { setWorking(""); onBusyChange(false); }
  }
  /** 图片先抵达目标 Agent；只将返回的实例内标识放入开播命令。 */
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (!["image/jpeg", "image/png"].includes(file.type) || !file.size || file.size > 2 * 1024 ** 2) { setError("请选择不超过 2 MB 的 JPG 或 PNG 图片。"); return; }
    setWorking("thumbnail"); onBusyChange(true);
    try {
      const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("图片无法读取，请重新选择。")); reader.readAsDataURL(file); });
      const result = await requestAssets("thumbnail", { name: file.name, mime: file.type, data: url.split(",")[1] });
      if (!result.id || !result.name) throw new Error("设备未确认封面，请重新上传。");
      onChange({ ...details, thumbnail: { id: result.id, name: result.name } }); setPreview({ id: result.id, url });
    } catch (e) { setError(e instanceof Error ? e.message : "封面上传失败，请重试。"); }
    finally { setWorking(""); onBusyChange(false); }
  }
  return <section className="broadcast-settings" aria-labelledby={`broadcast-heading-${id}`}>
    <div className="broadcast-section-heading"><div><h3 id={`broadcast-heading-${id}`}><span className="step-number">3</span>直播详情</h3><p>开播前准备好观众会看到的内容。</p></div><span className="draft-label">{disabled ? "本场设置" : "本页草稿 · 开播时应用"}</span></div>
    <div className="broadcast-editor-grid">
      <div className="broadcast-edit-column">
      <BroadcastAi id={id} instance={instance} disabled={locked} current={{ title: details.title, description: details.description }} onApply={copy => onChange({ ...details, ...copy })} onBusyChange={busy => { setWorking(busy ? "ai" : ""); onBusyChange(busy); }} />
      <fieldset disabled={locked} className="broadcast-fields">
        <legend className="visually-hidden">直播详情配置</legend>
        <div className="field-group"><label htmlFor={`broadcast-title-${id}`}>标题 <span className="field-required">必填</span></label><input id={`broadcast-title-${id}`} maxLength={100} value={details.title} placeholder="例如：东京雨夜 · Lofi 陪你学习与放松" onChange={e => onChange({ ...details, title: e.target.value })} aria-describedby={`title-hint-${id}`} /><span className="field-hint" id={`title-hint-${id}`}>{details.title.length}/100 · 显示在 YouTube 直播页面</span></div>
        <div className="field-group"><label htmlFor={`broadcast-description-${id}`}>说明</label><textarea id={`broadcast-description-${id}`} rows={5} maxLength={5000} value={details.description} placeholder="介绍这场直播，也可以添加频道介绍和相关链接。" onChange={e => onChange({ ...details, description: e.target.value })} /><span className="field-hint">{details.description.length}/5000</span></div>
        <div className="broadcast-pair">
          <div className="field-group"><label htmlFor={`broadcast-privacy-${id}`}>公开范围</label><select id={`broadcast-privacy-${id}`} value={details.privacy} onChange={e => onChange({ ...details, privacy: e.target.value as BroadcastDetails["privacy"] })}><option value="public">公开（默认）</option><option value="unlisted">不公开列出</option><option value="private">私密</option></select><span className="field-hint">{details.privacy === "public" ? "任何人都可以观看和搜索到这场直播。" : details.privacy === "unlisted" ? "有链接的人可以观看，不公开列出。" : "仅你和获准的用户可以观看。"}</span></div>
          <div className="field-group"><label htmlFor={`broadcast-audience-${id}`}>观众</label><select id={`broadcast-audience-${id}`} value={String(details.madeForKids)} onChange={e => onChange({ ...details, madeForKids: e.target.value === "true" })}><option value="false">不，内容不是面向儿童的</option><option value="true">是，内容是面向儿童的</option></select><span className="field-hint">{details.madeForKids ? "面向儿童的内容会限制实时聊天等功能。" : "请根据本场直播的实际内容选择。"}</span></div>
        </div>
        <div className="field-group"><div className="field-label-row"><label htmlFor={`broadcast-thumbnail-${id}`}>封面 / 缩略图</label>{details.thumbnail && <button type="button" className="btn-ghost" onClick={() => { onChange({ ...details, thumbnail: undefined }); setPreview(undefined); }}>移除封面</button>}</div><div className="thumbnail-upload"><input type="file" id={`broadcast-thumbnail-${id}`} accept="image/jpeg,image/png" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} /><span className="field-hint">{working === "thumbnail" ? "正在上传到直播电脑…" : details.thumbnail ? `已上传：${details.thumbnail.name}` : "JPG 或 PNG，最大 2 MB；建议使用 16:9 横图。"}</span></div></div>
        <div className="field-group"><div className="field-label-row"><span id={`playlist-label-${id}`}>播放列表 <span className="field-required">可多选</span></span><button type="button" className="btn-ghost" onClick={() => void loadPlaylists()}>{working === "playlists" ? "读取中…" : playlists ? "刷新列表" : "读取频道列表"}</button></div>
          {!playlists && <p className="field-hint">{details.playlistIds.length ? `已选择 ${details.playlistIds.length} 个列表，读取频道列表后可修改。` : "可将直播加入已绑定频道的播放列表。"}</p>}
          {playlists && <div className="playlist-options" role="group" aria-labelledby={`playlist-label-${id}`}>{playlists.length ? playlists.map(item => <label key={item.id}><input type="checkbox" checked={details.playlistIds.includes(item.id)} onChange={e => onChange({ ...details, playlistIds: e.target.checked ? [...details.playlistIds, item.id] : details.playlistIds.filter(key => key !== item.id) })} />{item.title}</label>) : <p className="field-hint">这个频道还没有播放列表，可先在 Studio 中创建。</p>}</div>}
        </div>
        {error && <p role="alert" className="broadcast-error">{error}</p>}
      </fieldset>
      </div>
      <aside className="broadcast-preview" aria-label="直播信息预览"><span className="preview-eyebrow">观众视角预览</span><div className="thumbnail-preview">{preview && details.thumbnail?.id === preview.id ? <img /* eslint-disable-line @next/next/no-img-element -- 本地上传图片的 data URL 预览。 */ src={preview.url} alt="本场直播封面预览" /> : <div className="thumbnail-placeholder"><YouTubeIcon /><span>{details.thumbnail ? details.thumbnail.name : "上传一张直播封面"}</span><small>{details.thumbnail ? "封面已保存在直播电脑" : "未上传时由 YouTube 生成缩略图"}</small></div>}<span className="preview-live-label">直播</span></div><h4>{details.title.trim() || "你的直播标题"}</h4><p>{channel || "当前绑定的 YouTube 频道"}</p><div className="preview-privacy">{privacy} · {details.madeForKids ? "面向儿童" : "非儿童内容"}</div><p className="preview-description">{details.description || "填写说明，让观众了解你的直播。"}</p><span className="field-hint">仅预览信息，不会启动直播。</span></aside>
    </div>
    <details className="studio-options"><summary>更多 YouTube 设置</summary><p>年龄限制、字幕、片尾画面、卡片、付费宣传与联合创作需在 YouTube Studio 中设置；本页不会代为保存这些项目。部分功能仅在直播结束后可用。</p><a href={studio} target="_blank" rel="noopener noreferrer">打开 YouTube Studio<ExternalLinkIcon /></a></details>
  </section>;
}
