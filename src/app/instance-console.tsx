/** 单个直播实例的内容选择、独立操作和真实状态展示。 */
"use client";
import { useInstance } from "./use-instance";
import type { InstanceDescriptor } from "@/shared/types";

/** 将 OBS 实际推流时长格式化，不模拟直播进度或时长。 */
function time(ms: number) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, "0")).join(":");
}

/** 一个面板只控制所属实例；观看链接使用其当前或最近场次 ID，结束后保留且不触发控制操作。 */
export default function InstanceConsole({ instance }: { instance: InstanceDescriptor }) {
  const { id, name } = instance;
  const model = useInstance(id);
  const { data, selection, working, error, stale, confirmed, setConfirmed, refresh, act, busy, live, pending, locked, blocker, select } = model;
  const stateLabel = stale ? "状态过期" : live ? "LIVE" : busy ? "处理中" : data?.state.phase === "error" ? "需要处理" : data?.state.phase === "live" ? "状态异常" : data?.state.phase === "stopped" ? "已结束" : "待机";
  const privacy = { unlisted: "不公开列出", private: "私密", public: "公开" }[data?.configuration.privacy || "unlisted"];
  return <article className="instance-panel" id={"instance-" + id} aria-labelledby={"title-" + id}>
    <header className="panel-header">
      <div><p className="instance-id">本机实例 / {id}</p><h2 id={"title-" + id}>{name}</h2><p className="channel-name">{data?.youtube.channel || "等待连接 YouTube 频道"}</p></div>
      <span className={"state-pill " + (live ? "live" : "")}><span className="dot" />{stateLabel}</span>
    </header>
    <div className="connections">
      <div className="connection"><div><span className="connection-name">OBS</span><strong><span className={"dot " + (data?.obs.ready && !stale ? "on" : "")} />{stale ? "Unknown" : data?.obs.ready ? "Ready" : "Offline"}</strong></div>
        <button className="text-button" disabled={busy || !data || stale || data.obs.ready} onClick={() => void act("launch")}>{working === "launch" ? "正在启动…" : "启动 OBS"}</button>
      </div>
      <div className="connection"><div><span className="connection-name">YouTube</span><strong><span className={"dot " + (data?.youtube.connected && !stale ? "on" : "")} />{stale ? "Unknown" : data?.youtube.connected ? "Connected" : "Disconnected"}</strong></div>
        <button className="text-button" disabled={busy || !data || stale} onClick={() => void act("connect")}>{data?.youtube.connected ? "重新授权" : "连接频道"}</button>
      </div>
    </div>
    {(error || data?.state.error || stale) && <p className="notice error" role="alert">{stale ? "此实例状态已过期：" + error : error || data?.state.error}</p>}
    {!!data?.configuration.missing.length && <details className="setup" open><summary>还有配置未完成</summary><p>在 .env.local 填写以下变量并重启服务。查看仓库 README 的新电脑配置指南。</p><ul>{data.configuration.missing.map(key => <li key={key}><code>{key}</code></li>)}</ul></details>}
    <section className="media-section" aria-label={name + " 直播内容"}>
      <div className="section-heading"><h3>直播内容</h3><span>视频与音乐循环播放</span></div>
      <div className="media-fields">
        <div className="field"><label htmlFor={"video-" + id}>视频 <small>Video</small></label>
          <select id={"video-" + id} value={selection.video} disabled={locked || !data?.media.videos.length} onChange={e => select({ video: e.target.value })}>
            <option value="">选择一个视频</option>
            {selection.video && !data?.media.videos.includes(selection.video) && <option value={selection.video}>{selection.video}（不可用）</option>}
            {data?.media.videos.map(name => <option key={name}>{name}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor={"music-" + id}>音乐 <small>Music</small></label>
          <select id={"music-" + id} value={selection.music} disabled={locked || !data?.media.music.length} onChange={e => select({ music: e.target.value })}>
            <option value="">选择一段音乐</option>
            {selection.music && !data?.media.music.includes(selection.music) && <option value={selection.music}>{selection.music}（不可用）</option>}
            {data?.media.music.map(name => <option key={name}>{name}</option>)}
          </select>
        </div>
      </div>
      <div className="audio-row"><div><label htmlFor={"audio-" + id}>视频原声</label><p>关闭时，只播放所选音乐。</p></div>
        <button id={"audio-" + id} role="switch" aria-checked={selection.videoAudio} aria-label={name + " 视频原声"} className={"switch " + (selection.videoAudio ? "enabled" : "")} disabled={locked} onClick={() => select({ videoAudio: !selection.videoAudio })}><span className="switch-knob" />{selection.videoAudio ? "ON" : "OFF"}</button>
      </div>
      {data?.media.error && <p className="help">{data.media.error}</p>}
      {data && (!data.media.videos.length || !data.media.music.length) && <p className="help">请在媒体目录的 videos / music 中放入真实文件，然后刷新。</p>}
      {pending && !live && <p className="help">当前场次尚未结束。保留原媒体重试开始，或结束直播恢复。</p>}
      <div className="actions">
        <button className="primary" disabled={!!blocker} aria-describedby={"readiness-" + id} onClick={() => void act("start")}>{working === "start" ? "正在准备直播…" : pending && !live ? "重试开始直播" : "开始直播"}</button>
        <button className="stop" disabled={busy || stale || !data} onClick={() => void act("stop")}>{working === "stop" ? "正在结束…" : "结束直播"}</button>
      </div>
      <p className={"readiness " + (!blocker ? "ready" : "")} id={"readiness-" + id}>{blocker || "准备就绪 · 点击后将自动启动 OBS 并开播"}</p>
      <p className="privacy">{privacy} · {data?.configuration.madeForKids ? "面向儿童" : "非面向儿童"} · 结束后 OBS 保持运行</p>
      {data?.state.broadcastId && <a className="watch-link" href={"https://www.youtube.com/watch?v=" + encodeURIComponent(data.state.broadcastId)} target="_blank" rel="noopener noreferrer" aria-label={name + "：打开直播页面（新标签页）"}>打开直播页面 <span aria-hidden="true">↗</span></a>}
    </section>
    <section className="monitor" aria-label={name + " 直播状态"}>
      <div className="monitor-top"><div><h3>直播状态</h3><p className="timer-label">OBS 实际推流时长</p></div><div className="timer">{stale ? "—" : data?.obs.streaming ? time(data.obs.durationMs || 0) : "00:00:00"}</div></div>
      <p className="stage" role="status">{stale ? "等待重新连接" : working === "launch" ? "等待 OBS WebSocket 就绪" : data?.state.stage || "正在读取状态…"}</p>
      <dl className="telemetry">
        <div><dt>OBS stream</dt><dd>{stale || data?.obs.streaming == null ? "Unknown" : data.obs.reconnecting ? "Reconnecting" : data.obs.streaming ? "Active" : "Inactive"}</dd></div>
        <div><dt>YouTube ingest</dt><dd>{stale ? "Unknown" : data?.youtube.ingest || "—"}</dd></div>
        <div><dt>YouTube lifecycle</dt><dd>{stale ? "Unknown" : data?.youtube.lifecycle || "—"}</dd></div>
      </dl>
      {data?.obs.message && <p className="help">{data.obs.message}</p>}
      {data?.youtube.error && <p className="help">{data.youtube.error}</p>}
      <p className="freshness">OBS 每 5 秒读取 · YouTube 最多每 30 秒读取{data?.youtube.checkedAt && " · 最近确认 " + new Date(data.youtube.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}</p>
    </section>
    <details className="advanced"><summary>Debug / Advanced</summary><dl className="telemetry">
      <div><dt>Broadcast ID</dt><dd>{data?.state.broadcastId || "—"}</dd></div><div><dt>Stream ID</dt><dd>{data?.state.streamId || "—"}</dd></div>
      <div><dt>恢复用标题</dt><dd>{data?.state.broadcastTitle || "—"}</dd></div><div><dt>OBS Scene / Version</dt><dd>{data?.obs.scene || "—"} / {data?.obs.version || "—"}</dd></div>
    </dl>
      {!data?.state.broadcastId && data?.state.broadcastIntent && <div className="recovery"><p>仅在 YouTube Studio 确认该场次不存在时使用。</p><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对该场次不存在，且 OBS 没有推流。</label><button disabled={busy || stale || !confirmed} onClick={() => void act("clear-uncertain")}>清理未确认状态</button></div>}
    </details>
    <div className="panel-footer"><span>OBS → YouTube · 独立控制</span><button className="text-button" onClick={() => void refresh()}>刷新状态与媒体</button></div>
  </article>;
}
