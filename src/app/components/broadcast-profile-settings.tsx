/** 设置中的配置包管理；只编辑可复用规则，不编辑本场素材与文案。 */
"use client";
import { useEffect, useState } from "react";
import type { Dashboard, InstanceDescriptor, Selection } from "@/shared/types";
import { defaultBroadcast, type Playlist } from "@/shared/broadcast";
import { api } from "../client-request";
import BroadcastProfiles from "./broadcast-profiles";
import LiveChatFields from "./live-chat-fields";
import { defaultLiveChatConfig } from "@/shared/live-chat";
import BroadcastRuleFields from "./broadcast-rule-fields";

/** 配置对象切换时父级通过 key 隔离全部状态，读取不修改工作台的草稿。 */
export default function BroadcastProfileSettings({ instance, onSaving }: { instance: InstanceDescriptor; onSaving(value: boolean): void }) {
  const [channel, setChannel] = useState<string>();
  const [value, setValue] = useState<Selection>({ video: "", music: "", videoAudio: false, broadcast: { ...defaultBroadcast(), liveChat: { ...defaultLiveChatConfig } } });
  const [playlists, setPlaylists] = useState<Playlist[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const details = value.broadcast || defaultBroadcast();
  useEffect(() => {
    const abort = new AbortController();
    const query = new URLSearchParams({ instanceId: instance.id, ...(instance.agentId ? { agentId: instance.agentId } : {}) });
    void api<Dashboard>("/api/status?" + query, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) { if (!result.youtube.channelId) setError("请先连接频道，再管理直播配置包。"); else setChannel(result.youtube.channelId); } }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "频道读取失败"); });
    return () => abort.abort();
  }, [instance.id, instance.agentId, refresh]);
  /** 读取所选频道的播放列表，沿用已有 Agent 资产接口和权限边界。 */
  async function loadPlaylists() {
    setBusy(true); onSaving(true); setError("");
    try { const result = await api<{ playlists: Playlist[] }>("/api/broadcast-assets", { method: "POST", timeoutMs: 60_000, headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ action: "playlists", instanceId: instance.id, ...(instance.agentId ? { agentId: instance.agentId } : {}) }) }); setPlaylists(result.playlists); }
    catch (e) { setError(e instanceof Error ? e.message : "播放列表读取失败"); }
    finally { setBusy(false); onSaving(false); }
  }
  return <section className="api-service-section" aria-label="管理直播配置包">
    {channel && <><BroadcastProfiles management instance={instance} target={{ instanceId: instance.id, channelId: channel, ...(instance.agentId ? { agentId: instance.agentId } : {}) }} value={value} disabled={busy} onApply={setValue} onBusyChange={saving => { setBusy(saving); onSaving(saving); }} />
      <BroadcastRuleFields id="profile-editor" value={{ privacy: details.privacy, madeForKids: details.madeForKids, videoAudio: value.videoAudio }} disabled={busy} onChange={rules => setValue({ ...value, videoAudio: rules.videoAudio, broadcast: { ...details, privacy: rules.privacy, madeForKids: rules.madeForKids } })} />
      <h3>AI 观众互动</h3><LiveChatFields id="profile-editor" value={details.liveChat || defaultLiveChatConfig} disabled={busy} onChange={liveChat => setValue({ ...value, broadcast: { ...details, liveChat } })} />
      <div className="api-settings-actions"><span>播放列表 · {details.playlistIds.length} 个已选</span><button type="button" disabled={busy} onClick={() => void loadPlaylists()}>读取播放列表</button></div>
      {playlists && <div className="playlist-options">{playlists.length ? playlists.map(item => <label key={item.id}><input type="checkbox" disabled={busy} checked={details.playlistIds.includes(item.id)} onChange={event => setValue({ ...value, broadcast: { ...details, playlistIds: event.target.checked ? [...details.playlistIds, item.id] : details.playlistIds.filter(id => id !== item.id) } })} />{item.title}</label>) : <p>当前频道没有播放列表。</p>}</div>}
    </>}
    {!channel && !error && <p role="status">读取频道…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => { setError(""); setRefresh(value => value + 1); }}>重新读取频道</button></div>}
  </section>;
}
