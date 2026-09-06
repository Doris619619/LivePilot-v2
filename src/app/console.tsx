"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dashboard } from "@/shared/types";

function time(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, "0")).join(":");
}
export default function Console() {
  const [data, setData] = useState<Dashboard>();
  const [video, setVideo] = useState("");
  const [music, setMusic] = useState("");
  const [videoAudio, setVideoAudio] = useState(false);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const initialized = useRef(false);
  const fetching = useRef(false);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const response = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(60_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "无法读取控制台状态");
      setData(result);
      setStale(false);
      if (!initialized.current) {
        initialized.current = true;
        if (result.state.selection) {
          setVideo(result.state.selection.video); setMusic(result.state.selection.music); setVideoAudio(result.state.selection.videoAudio);
        }
      }
    } catch { setStale(true); }
    finally { fetching.current = false; }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      const cookie = document.cookie.split("; ").find(v => v.startsWith("livepilot_notice="));
      if (cookie) {
        setNotice(decodeURIComponent(cookie.slice("livepilot_notice=".length)));
        document.cookie = "livepilot_notice=; Max-Age=0; Path=/; SameSite=Strict";
      }
      void refresh();
    }, 0);
    const interval = setInterval(() => void refresh(), 5000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [refresh]);

  const busy = !!working || !!data?.busy;
  const live = !stale && data?.youtube.lifecycle === "live" && data.obs.streaming === true && data.youtube.ingest === "active";
  const pending = !!data?.state.broadcastTitle && data.state.phase !== "stopped";
  const locked = busy || live || pending;
  const startDisabled = busy || stale || !data || !video || !music || !data.youtube.connected || live || data.configuration.missing.length > 0;
  const stateLabel = stale ? "连接中断" : live ? "LIVE" : busy ? "处理中" : data?.state.phase === "stopped" ? "Stopped" : data?.state.phase === "error" ? "需要处理" : data?.state.phase === "live" ? "状态异常" : "待机";
  const privacy = { unlisted: "不公开列出", private: "私密", public: "公开" }[data?.configuration.privacy || "unlisted"];
  async function act(action: string) {
    setWorking(action); setError(""); setNotice("");
    try {
      const response = await fetch(action === "connect" ? "/api/youtube/connect" : "/api/control", {
        method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" },
        body: JSON.stringify(action === "connect" ? {} : action === "start" ? { action, video, music, videoAudio } : action === "clear-uncertain" ? { action, confirmed } : { action }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "操作失败，请刷新状态后重试");
      if (result.url) { window.location.assign(result.url); return; }
      if (action === "clear-uncertain") setConfirmed(false);
    } catch (e) { setError(e instanceof Error ? e.message : "请求中断，请刷新状态后核对，切勿重复点击。"); }
    finally { setWorking(""); await refresh(); }
  }
  return <main>
    <header className="masthead">
      <div><div className="eyebrow">LOCAL BROADCAST CONTROL</div><h1>LivePilot<span className="brand-dot">.</span></h1></div>
      <span className="local-label"><span className="dot" />本机控制台</span>
    </header>
    <section className="connections" aria-label="连接状态">
      <div className="connection"><span className="connection-name">OBS</span><strong><span className={"dot " + (data?.obs.ready && !stale ? "on" : "")} />{stale ? "Unknown" : data?.obs.ready ? "Ready" : "Offline"}</strong>
        <button className="text-button" disabled={busy || !data || stale || data.obs.ready} onClick={() => void act("launch")}>{working === "launch" ? "正在启动…" : "启动 OBS"}</button>
      </div>
      <div className="connection"><span className="connection-name">YouTube</span><strong><span className={"dot " + (data?.youtube.connected && !stale ? "on" : "")} />{stale ? "Unknown" : data?.youtube.connected ? "Connected" : "Disconnected"}</strong>
        <button className="text-button" disabled={busy || !data || stale} onClick={() => void act("connect")}>{data?.youtube.connected ? "重新授权" : "连接 YouTube"}</button>
      </div>
    </section>

    {(error || notice || data?.state.error || stale) && <div className="notice error" role="alert">{stale ? "与 LivePilot 服务连接中断。下方状态可能已过期，请检查本机服务并刷新。" : error || notice || data?.state.error}</div>}
    {!!data?.configuration.missing.length && <details className="setup" open><summary>完成本机配置后即可开始</summary><p>在项目的 <code>.env.local</code> 填写以下配置，再重新启动 LivePilot。详见 README。</p><p className="config-keys">{data.configuration.missing.join(" · ")}</p></details>}

    <div className="workspace">
      <section className="media-section" aria-labelledby="media-title">
        <div className="section-heading"><h2 id="media-title">直播内容</h2><span>视频与音乐持续循环</span></div>
        <div className="field"><label htmlFor="video"><span className="field-number">01</span>Video <small>视频</small></label>
          <select id="video" value={video} disabled={locked || !data?.media.videos.length} onChange={e => setVideo(e.target.value)}>
            <option value="">选择一个视频</option>
            {video && !data?.media.videos.includes(video) && <option value={video}>{video}（当前不可用）</option>}
            {data?.media.videos.map(name => <option key={name}>{name}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="music"><span className="field-number">02</span>Music <small>音乐</small></label>
          <select id="music" value={music} disabled={locked || !data?.media.music.length} onChange={e => setMusic(e.target.value)}>
            <option value="">选择一段音乐</option>
            {music && !data?.media.music.includes(music) && <option value={music}>{music}（当前不可用）</option>}
            {data?.media.music.map(name => <option key={name}>{name}</option>)}
          </select>
        </div>
        <div className="audio-row"><div><label htmlFor="audio">Video Audio <small>视频原声</small></label><p>音乐始终播放，原声可叠加。</p></div>
          <button id="audio" role="switch" aria-checked={videoAudio} aria-label="视频原声" className={"switch " + (videoAudio ? "enabled" : "")} disabled={locked} onClick={() => setVideoAudio(v => !v)}><span className="switch-knob" /><span>{videoAudio ? "ON" : "OFF"}</span></button>
        </div>
        {data?.media.error ? <p className="help">{data.media.error}</p> : data && (!data.media.videos.length || !data.media.music.length) ? <p className="help">媒体目录为空。请在 videos / music 文件夹中放入真实媒体文件。</p> : null}
        {pending && !live && <p className="help">当前场次尚未结束。保留原媒体重试开始，或点击结束直播恢复。</p>}
        <div className="actions"><button className="primary" disabled={startDisabled} onClick={() => void act("start")}><span aria-hidden="true">▶</span> {working === "start" ? "正在准备直播…" : pending && !live ? "重试开始直播" : "开始直播"}</button>
          <button className="stop" disabled={busy || stale || !data} onClick={() => void act("stop")}><span aria-hidden="true">■</span> {working === "stop" ? "正在结束…" : "结束直播"}</button></div>
        <p className="privacy">本场可见性：{privacy} · {data?.configuration.madeForKids ? "面向儿童" : "非面向儿童"}<br />结束直播后 OBS 保持运行。</p>
      </section>
      <section className="monitor" aria-labelledby="monitor-title">
        <div className="section-heading"><h2 id="monitor-title">直播状态</h2><span className={"state-pill " + (live ? "live" : "")}><span className="dot" />{stateLabel}</span></div>
        <div className="timer">{data?.obs.streaming ? time(data.obs.durationMs || 0) : "00:00:00"}</div>
        <p className="timer-label">OBS 本次推流时间</p>
        <div className="stage" role="status" aria-live="polite"><span className={"stage-mark " + (live ? "on" : "")} />{working === "launch" ? "等待 OBS WebSocket 就绪" : data?.state.stage || "正在读取本机状态…"}</div>
        <dl className="telemetry">
          <div><dt>OBS stream status</dt><dd>{stale ? "Unknown" : data?.obs.streaming === null ? "Unknown" : data?.obs.reconnecting ? "Reconnecting" : data?.obs.streaming ? "Active" : "Inactive"}</dd></div>
          <div><dt>YouTube ingest</dt><dd>{data?.youtube.ingest || "—"}</dd></div>
          <div><dt>YouTube lifecycle</dt><dd>{data?.youtube.lifecycle || "—"}</dd></div>
          <div><dt>Channel</dt><dd>{data?.youtube.channel || "尚未连接"}</dd></div>
        </dl>
        {data?.obs.message && <p className="help">{data.obs.message}</p>}
        {data?.youtube.error && <p className="help">{data.youtube.error}</p>}
        <p className="freshness">OBS 每 5 秒读取 · YouTube 最多每 30 秒读取{data?.youtube.checkedAt && <><br />YouTube 最近确认：{new Date(data.youtube.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}</>}</p>
      </section>
    </div>
    <details className="advanced"><summary>Debug / Advanced</summary><dl className="telemetry">
      <div><dt>Broadcast ID</dt><dd>{data?.state.broadcastId || "—"}</dd></div><div><dt>Stream ID</dt><dd>{data?.state.streamId || "—"}</dd></div>
      <div><dt>恢复用场次标题</dt><dd>{data?.state.broadcastTitle || "—"}</dd></div><div><dt>OBS Scene / Version</dt><dd>{data?.obs.scene || "—"} / {data?.obs.version || "—"}</dd></div></dl>
      {!data?.state.broadcastId && data?.state.broadcastIntent && <div className="recovery"><p>仅在创建请求结果不确定、YouTube Studio 中确认不存在该场次时使用。服务端还会核对频道、场次和 OBS 状态。</p><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已在 YouTube Studio 核对该场次不存在，且 OBS 没有推流。</label><button disabled={busy || !confirmed} onClick={() => void act("clear-uncertain")}>清理未确认的创建状态</button></div>}
    </details>
    <footer><span>LivePilot v2 <span className="footer-separator">/</span> OBS → YouTube</span><button className="text-button" onClick={() => void refresh()}>刷新状态与媒体</button></footer>
  </main>;
}
