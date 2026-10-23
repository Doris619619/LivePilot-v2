/** 本次发布的频道/设备专属字段，保存在工作台草稿和计划中，不写回通用配置包。 */
"use client";
import { useState } from "react";
import { api } from "../client-request";
import type { Playlist } from "@/shared/broadcast";
import type { PublishingProfile } from "@/shared/publishing";

export type PublishingChannelOptions = { playlistIds: string[]; thumbnailFilename?: string };
/** 播放列表仅通过当前发布账号读取；失败保留选择并允许重试。 */
export default function PublishingChannelOptionsFields({ profile, busy, change }: { profile: PublishingProfile; busy: boolean; change(value: PublishingChannelOptions): void }) {
  const [playlists, setPlaylists] = useState<Playlist[]>(); const [reading, setReading] = useState(false); const [error, setError] = useState("");
  /** 读取当前账号的列表；不自动勾选，也不因失败清空已有选择。 */
  async function load() {
    setReading(true); setError("");
    try { const value = await api<{ playlists: Playlist[] }>("/api/publishing", { method: "POST", timeoutMs: 60000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ action: "account-playlists", accountId: profile.accountId }) }); setPlaylists(value.playlists); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "播放列表读取失败，请重试。"); }
    finally { setReading(false); }
  }
  const options = { playlistIds: profile.playlistIds, thumbnailFilename: profile.thumbnailFilename };
  return <>
    {profile.thumbnailMode === "fixed" && <label>本次固定封面<input name="publishing-thumbnail-filename" autoComplete="off" spellCheck={false} required disabled={busy} value={profile.thumbnailFilename || ""} onChange={event => change({ ...options, thumbnailFilename: event.target.value })} placeholder="例如 cover.jpg…" /></label>}
    <details className="publishing-details"><summary>本次播放列表{profile.playlistIds.length ? ` · 已选 ${profile.playlistIds.length} 个` : "（可选）"}</summary>
      <button type="button" disabled={busy || reading || !profile.accountId} onClick={() => void load()}>{reading ? "读取中…" : "读取频道播放列表"}</button>
      {error && <p role="alert">{error}</p>}
      {playlists?.length === 0 && <p>这个频道还没有播放列表。</p>}
      {playlists?.map(item => <label className="publishing-check" key={item.id}><input name="publishing-playlists" autoComplete="off" type="checkbox" disabled={busy} checked={profile.playlistIds.includes(item.id)} onChange={event => change({ ...options, playlistIds: event.target.checked ? [...profile.playlistIds, item.id] : profile.playlistIds.filter(id => id !== item.id) })} />{item.title}</label>)}
      {!!profile.playlistIds.length && <button type="button" disabled={busy} onClick={() => change({ ...options, playlistIds: [] })}>清空选择</button>}
    </details>
  </>;
}
