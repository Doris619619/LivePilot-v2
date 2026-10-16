/** 直播前填写可同步到 YouTube 的详情，并预览观众看到的标题、封面和公开范围。 */
"use client";
import { useState, type ReactNode } from "react";
import BroadcastAi from "./broadcast-ai";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/primitives";
import FileDropzone from "./ui/file-dropzone";
import { api } from "../client-request";
import { defaultBroadcast, type BroadcastDetails, type Playlist } from "@/shared/broadcast";
import type { InstanceDescriptor, Selection } from "@/shared/types";
import BroadcastProfiles from "./broadcast-profiles";
import { ExternalLinkIcon } from "./icons";
import MediaPreview from "./media-preview/media-preview";
import LiveChatFields from "./live-chat-fields";
import { defaultLiveChatConfig } from "@/shared/live-chat";
import BroadcastCopyFields from "./broadcast-copy-fields";
import BroadcastRuleFields from "./broadcast-rule-fields";
import { ApiSettingsButton } from "./api-settings";
import "./broadcast-workflow.css";

/** 配置只作用于当前实例；上传中锁定表单，防止异步完成覆盖新草稿。 */
export default function BroadcastSettings({ id, instance, value, disabled, channel, channelId, broadcastId, videoName, musicName, videoAudio, live, onChange, onSelectionChange, onBusyChange, media, controls }: {
  videoName?: string; musicName?: string; videoAudio?: boolean; live?: boolean;
  media: (suffix: string) => ReactNode; controls: ReactNode;
  id: string; instance: InstanceDescriptor; value?: BroadcastDetails; disabled: boolean; channel: string; channelId?: string; broadcastId?: string;
  onChange: (value: BroadcastDetails) => void; onSelectionChange: (value: Selection) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [tab, setTab] = useState("media");
  const tabs = [{ id: "media", label: "素材选择" }, { id: "content", label: "直播编排" }, { id: "start", label: "开播" }];
  const details = value || defaultBroadcast();
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [playlists, setPlaylists] = useState<Playlist[]>();
  const [preview, setPreview] = useState<{ id: string; url: string }>();
  const [profilesBusy, setProfilesBusy] = useState(false);
  const locked = disabled || !!working || profilesBusy;
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
  /** 封面两个编辑入口读取同一实例内标识，异步上传期间锁定整份配置。 */
  function cover(suffix: string) {
    return <fieldset disabled={locked} className="broadcast-fields"><legend className="visually-hidden">直播封面</legend><div className="field-group"><div className="field-label-row"><label htmlFor={`broadcast-thumbnail-${id}-${suffix}`}>封面</label>{details.thumbnail && <button type="button" className="btn-ghost" onClick={() => { onChange({ ...details, thumbnail: undefined }); setPreview(undefined); }}>移除封面</button>}</div><FileDropzone id={`broadcast-thumbnail-${id}-${suffix}`} label={details.thumbnail ? "更换封面" : "选择封面"} name={details.thumbnail?.name} hint={working === "thumbnail" ? "正在上传到直播电脑…" : "JPG / PNG · 最大 2 MB · 建议 16:9"} accept={{ "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] }} maxSize={2 * 1024 ** 2} disabled={locked} onFile={file => void upload(file)} /></div></fieldset>;
  }
  /** 步骤只改变视图；完整配置始终来自父级 Selection，不在切换时保存或重建。 */
  function navigate(next: string) { setTab(next); requestAnimationFrame(() => document.getElementById(`studio-tab-${id}-${next}`)?.focus()); }
  return <Tabs value={tab} onValueChange={setTab} asChild><section className="broadcast-settings broadcast-workflow" aria-label="开播准备">
    <TabsList aria-label="开播步骤">{tabs.map((item, index) => <TabsTrigger key={item.id} value={item.id} id={`studio-tab-${id}-${item.id}`}><span className="step-number" aria-hidden="true">{index + 1}</span><span>{item.label}</span></TabsTrigger>)}</TabsList>
    <TabsContent className="studio-panel" value="media" aria-labelledby={`studio-tab-${id}-media`}>
      <h3 className="workflow-heading">选择本场音视频</h3>
      <fieldset disabled={locked} className="broadcast-fields"><legend className="visually-hidden">本场素材</legend>{media("primary")}</fieldset>
    </TabsContent>
    <TabsContent className="studio-panel" value="content" aria-labelledby={`studio-tab-${id}-content`}>
      <section className="workflow-section" aria-labelledby={`preset-heading-${id}`}><h3 id={`preset-heading-${id}`}>配置包</h3>
        {<BroadcastProfiles key={`${id}:${channelId}`} target={channelId ? { ...(instance.agentId ? { agentId: instance.agentId } : {}), instanceId: instance.id, channelId } : undefined} instance={instance} value={{ video: videoName || "", music: musicName || "", videoAudio: !!videoAudio, broadcast: details }} disabled={disabled || !!working} onApply={onSelectionChange} onBusyChange={busy => { setProfilesBusy(busy); onBusyChange(busy); }} />}
      </section>
      <section className="workflow-section" aria-labelledby={`copy-heading-${id}`}><h3 id={`copy-heading-${id}`}>直播内容</h3>
        <BroadcastAi id={id} instance={instance} disabled={locked} current={{ title: details.title, description: details.description }} onApply={copy => onChange({ ...details, ...copy })} onBusyChange={busy => { setWorking(busy ? "ai" : ""); onBusyChange(busy); }} />
        <BroadcastCopyFields id={id} value={details} disabled={locked} onChange={onChange} />
        {cover("primary")}
      </section>
      <section className="workflow-section" aria-labelledby={`chat-heading-${id}`}><div className="field-label-row"><h3 id={`chat-heading-${id}`}>AI 观众互动</h3><ApiSettingsButton disabled={locked}>AI 服务设置</ApiSettingsButton></div><LiveChatFields id={id} value={details.liveChat || defaultLiveChatConfig} disabled={locked} onChange={liveChat => onChange({ ...details, liveChat })} /></section>
      <details className="workflow-complete"><summary><span>完整配置</span><span className="workflow-summary">{privacy} · {details.madeForKids ? "面向儿童" : "不面向儿童"} · 原声{videoAudio ? "开启" : "关闭"}</span></summary>
        <div className="workflow-complete-body">
          <p className="field-hint">本场开播使用以下配置，修改会同步到前面的输入。</p>
          <section className="workflow-section"><h4>素材</h4><fieldset disabled={locked} className="broadcast-fields"><legend className="visually-hidden">完整素材配置</legend>{media("complete")}</fieldset></section>
          <section className="workflow-section"><h4>标题、说明与封面</h4><BroadcastCopyFields id={`${id}-complete`} value={details} disabled={locked} onChange={onChange} />{cover("complete")}</section>
          <section className="workflow-section"><div className="field-label-row"><h4>直播规则</h4><ApiSettingsButton section="defaults" disabled={locked}>默认设置</ApiSettingsButton></div>
            <BroadcastRuleFields id={`${id}-complete`} value={{ privacy: details.privacy, madeForKids: details.madeForKids, videoAudio: !!videoAudio }} disabled={locked} onChange={rules => onSelectionChange({ video: videoName || "", music: musicName || "", videoAudio: rules.videoAudio, broadcast: { ...details, privacy: rules.privacy, madeForKids: rules.madeForKids } })} />
            <fieldset disabled={locked} className="broadcast-fields"><legend className="visually-hidden">播放列表</legend><div className="field-group"><div className="field-label-row"><span>播放列表 · {details.playlistIds.length ? `已选 ${details.playlistIds.length} 个` : "未选择"}</span><button type="button" className="btn-ghost" onClick={() => void loadPlaylists()}>{working === "playlists" ? "读取中…" : playlists ? "刷新列表" : "选择播放列表"}</button></div>
              {playlists && <div className="playlist-options" role="group" aria-label="播放列表">{playlists.length ? playlists.map(item => <label key={item.id}><input type="checkbox" checked={details.playlistIds.includes(item.id)} onChange={e => onChange({ ...details, playlistIds: e.target.checked ? [...details.playlistIds, item.id] : details.playlistIds.filter(key => key !== item.id) })} />{item.title}</label>) : <p className="field-hint">当前频道没有播放列表。</p>}</div>}
            </div></fieldset>
          </section>
          <section className="workflow-section"><h4>AI 观众互动</h4><LiveChatFields id={`${id}-complete`} value={details.liveChat || defaultLiveChatConfig} disabled={locked} onChange={liveChat => onChange({ ...details, liveChat })} /></section>
          <a href={studio} target="_blank" rel="noopener noreferrer">在 YouTube Studio 管理其他平台设置<ExternalLinkIcon /></a>
        </div>
      </details>
    </TabsContent>
    <TabsContent className="studio-panel" value="start" aria-labelledby={`studio-tab-${id}-start`}>
      <h3 className="workflow-heading">确认本场直播</h3>
      <div className="workflow-review">
        <div className="workflow-review-copy"><h4>{details.title || "尚未填写标题"}</h4><p className="workflow-description">{details.description || "未填写说明"}</p><dl className="workflow-review-values"><div><dt>视频</dt><dd>{videoName || "未选择"}</dd></div><div><dt>音乐</dt><dd>{musicName || "未选择"}</dd></div><div><dt>封面</dt><dd>{details.thumbnail?.name || "未设置"}</dd></div><div><dt>直播规则</dt><dd>{privacy} · {details.madeForKids ? "面向儿童" : "不面向儿童"} · 原声{videoAudio ? "开启" : "关闭"}</dd></div><div><dt>AI 自动回复</dt><dd>{(details.liveChat || defaultLiveChatConfig).enabled ? "开启" : "关闭"}</dd></div><div><dt>播放列表</dt><dd>{details.playlistIds.length ? `${details.playlistIds.length} 个` : "未选择"}</dd></div></dl><button type="button" className="btn-secondary" onClick={() => navigate("content")}>返回修改</button></div>
        {tab === "start" && <MediaPreview key={[instance.agentId, instance.id, channel, videoName, musicName].join(":")} selection={instance.agentId && videoName ? { agentId: instance.agentId, instanceId: instance.id, ...(channelId ? { channelId } : {}), source: { kind: "live", video: videoName, ...(musicName ? { music: musicName } : {}), ...(details.thumbnail?.id ? { coverId: details.thumbnail.id } : {}) } } : undefined} mode="live" receiver={{ id: broadcastId, privacy: details.privacy }} title={details.title} channel={channel} videoName={videoName} musicName={musicName} videoAudio={videoAudio} live={live} coverName={details.thumbnail?.name} cover={preview && details.thumbnail?.id === preview.id ? preview.url : undefined} />}
      </div>
      <div className="workflow-launch">{controls}</div>
    </TabsContent>
    {error && <p role="alert" className="broadcast-error">{error}</p>}
    <div className="studio-step-footer"><span>第 {tabs.findIndex(item => item.id === tab) + 1} 步 / 共 3 步</span><div className="workflow-navigation">{tab !== "media" && <button type="button" className="btn-secondary" onClick={() => navigate(tabs[tabs.findIndex(item => item.id === tab) - 1].id)}>上一步</button>}{tab !== "start" && <button type="button" className="btn-primary" onClick={() => navigate(tabs[tabs.findIndex(item => item.id === tab) + 1].id)}>下一步：{tabs[tabs.findIndex(item => item.id === tab) + 1].label}</button>}</div></div>
  </section></Tabs>;
}
