/* 文件用途：LiveNest 单个直播实例控制卡片，纯净浅色风格，精准排版、即时反馈与无噪声遥测。 */

"use client";

import { useInstance } from "./use-instance";
import type { InstanceDescriptor } from "@/shared/types";
import { StatusBadge, type StatusType } from "./components/status-indicator";
import {
  ObsIcon,
  YouTubeIcon,
  VideoIcon,
  MusicIcon,
  VolumeIcon,
  VolumeMuteIcon,
  PlayIcon,
  StopIcon,
  RefreshIcon,
  ExternalLinkIcon,
  AlertCircleIcon,
} from "./components/icons";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(v => String(v).padStart(2, "0")).join(":");
}

export default function InstanceConsole({ instance }: { instance: InstanceDescriptor }) {
  const { name } = instance;
  const id = instance.agentId ? `${instance.agentId}-${instance.id}` : instance.id;
  const model = useInstance(instance);
  const {
    data,
    selection,
    working,
    error,
    stale,
    confirmed,
    setConfirmed,
    refresh,
    act,
    busy,
    live,
    pending,
    locked,
    blocker,
    select,
  } = model;

  const statusType: StatusType = stale
    ? "stale"
    : live
    ? "live"
    : busy
    ? "busy"
    : data?.state.phase === "error"
    ? "error"
    : data?.state.phase === "live"
    ? "error"
    : data?.state.phase === "stopped"
    ? "standby"
    : "ready";

  const stateLabel = stale
    ? "离线/过期"
    : live
    ? "LIVE 推流中"
    : busy
    ? "处理中…"
    : data?.state.phase === "error"
    ? "需要处理"
    : data?.state.phase === "live"
    ? "异常"
    : data?.state.phase === "stopped"
    ? "已就绪"
    : "待机";

  const privacyText = {
    unlisted: "不公开列出",
    private: "私密",
    public: "公开",
  }[data?.configuration.privacy || "unlisted"];

  return (
    <article className={`instance-card ${live ? "live-border" : ""}`} id={`instance-${id}`} aria-labelledby={`title-${id}`}>
      {/* 头部信息 */}
      <header className="card-header">
        <div className="card-title-group">
          <span className="card-location">
            {instance.agentName || "本机"} / {instance.id}
          </span>
          <h2 className="card-title" id={`title-${id}`}>
            {name}
          </h2>
          <div className="card-channel">
            <YouTubeIcon style={{ color: "#dc2626" }} />
            <span>{data?.youtube.channel || "等待连接 YouTube 频道"}</span>
          </div>
        </div>

        <StatusBadge status={statusType} label={stateLabel} />
      </header>

      {/* 管道状态 */}
      <div className="connections-bar">
        <div className="conn-item">
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <ObsIcon />
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>OBS:</span>
            <span className={`conn-status ${data?.obs.ready && !stale ? "connected" : "disconnected"}`}>
              {stale ? "未知" : data?.obs.ready ? "就绪" : "未启动"}
            </span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || !data || stale || data.obs.ready}
            onClick={() => void act("launch")}
          >
            {working === "launch" ? "启动中…" : "启动 OBS"}
          </button>
        </div>

        <div className="conn-item">
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <YouTubeIcon style={{ color: "#dc2626" }} />
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>YouTube:</span>
            <span className={`conn-status ${data?.youtube.connected && !stale ? "connected" : "disconnected"}`}>
              {stale ? "未知" : data?.youtube.connected ? "已连接" : "未连接"}
            </span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || !data || stale}
            onClick={() => void act("connect")}
          >
            {data?.youtube.connected ? "重新授权" : "连接频道"}
          </button>
        </div>
      </div>

      {(error || data?.state.error || stale) && (
        <div className="banner error" role="alert">
          <AlertCircleIcon />
          <span>{stale ? `状态已过期：${error}` : error || data?.state.error}</span>
        </div>
      )}

      {/* 编排与控制 */}
      <section aria-label={`${name} 节目编排`}>
        <div className="form-row">
          <div className="field-group">
            <label htmlFor={`video-${id}`} className="field-label">
              <VideoIcon /> 循环视频
            </label>
            <select
              id={`video-${id}`}
              value={selection.video}
              disabled={locked || !data?.media.videos.length}
              onChange={e => select({ video: e.target.value })}
            >
              <option value="">选择视频素材</option>
              {selection.video && !data?.media.videos.includes(selection.video) && (
                <option value={selection.video}>{selection.video}（缺失）</option>
              )}
              {data?.media.videos.map(item => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group">
            <label htmlFor={`music-${id}`} className="field-label">
              <MusicIcon /> 背景音乐
            </label>
            <select
              id={`music-${id}`}
              value={selection.music}
              disabled={locked || !data?.media.music.length}
              onChange={e => select({ music: e.target.value })}
            >
              <option value="">选择音乐素材</option>
              {selection.music && !data?.media.music.includes(selection.music) && (
                <option value={selection.music}>{selection.music}（缺失）</option>
              )}
              {data?.media.music.map(item => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 原声开关 */}
        <div className="switch-row">
          <div className="switch-label">
            {selection.videoAudio ? <VolumeIcon /> : <VolumeMuteIcon />}
            <span>保留视频原声</span>
            <small style={{ color: "var(--text-muted)", fontWeight: 400 }}>（关闭时只播放音乐）</small>
          </div>

          <button
            id={`audio-${id}`}
            type="button"
            role="switch"
            aria-checked={selection.videoAudio}
            className={`switch-btn ${selection.videoAudio ? "active" : ""}`}
            disabled={locked}
            onClick={() => select({ videoAudio: !selection.videoAudio })}
          >
            {selection.videoAudio ? "开启 ON" : "静音 OFF"}
          </button>
        </div>

        {/* 开停播主控 */}
        <div className="actions-group">
          <div className="actions-buttons">
            <button
              type="button"
              className="btn-primary"
              disabled={!!blocker}
              aria-describedby={`readiness-${id}`}
              onClick={() => void act("start")}
            >
              <PlayIcon />
              <span>{working === "start" ? "正在准备推流…" : pending && !live ? "重试开始直播" : "开始直播"}</span>
            </button>

            <button
              type="button"
              className="btn-danger"
              disabled={busy || stale || !data}
              onClick={() => void act("stop")}
            >
              <StopIcon />
              <span>{working === "stop" ? "结束中…" : "结束直播"}</span>
            </button>
          </div>

          <div className={`readiness-text ${!blocker ? "ready" : ""}`} id={`readiness-${id}`}>
            {blocker || "已就绪 · 点击开始将自动启动推流"}
          </div>

          <div className="sub-links-row">
            <span>
              {privacyText} · {data?.configuration.madeForKids ? "面向儿童" : "常规内容"}
            </span>

            {data?.state.broadcastId && (
              <a
                className="watch-link"
                href={`https://www.youtube.com/watch?v=${encodeURIComponent(data.state.broadcastId)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>YouTube 直播页</span>
                <ExternalLinkIcon />
              </a>
            )}
          </div>
        </div>
      </section>

      {/* 遥测监测 */}
      <section className="telemetry-box" aria-label={`${name} 遥测状态`}>
        <div className="telemetry-header">
          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>推流监控</span>
          <span className="telemetry-timer">{stale ? "—" : data?.obs.streaming ? formatDuration(data.obs.durationMs || 0) : "00:00:00"}</span>
        </div>

        <div className="telemetry-stage">
          阶段：<strong>{stale ? "离线重连中" : working === "launch" ? "等待 OBS 响应" : data?.state.stage || "读取中…"}</strong>
        </div>

        <div className="telemetry-table">
          <div className="telemetry-cell">
            <span className="telemetry-cell-label">OBS 推流</span>
            <span className="telemetry-cell-value">
              {stale || data?.obs.streaming == null
                ? "未知"
                : data.obs.reconnecting
                ? "重连中"
                : data.obs.streaming
                ? "Active (推流中)"
                : "未推流"}
            </span>
          </div>

          <div className="telemetry-cell">
            <span className="telemetry-cell-label">YouTube 状态</span>
            <span className="telemetry-cell-value">{stale ? "未知" : data?.youtube.lifecycle || "—"}</span>
          </div>
        </div>
      </section>

      {/* 底部刷新与高级展开 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", paddingTop: "8px", borderTop: "1px solid var(--border-subtle)" }}>
        <details style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          <summary style={{ cursor: "pointer" }}>高级诊断</summary>
          <div style={{ marginTop: "6px", fontSize: "11px", fontFamily: "var(--font-mono)" }}>
            <div>Broadcast ID: {data?.state.broadcastId || "—"}</div>
            <div>Stream ID: {data?.state.streamId || "—"}</div>
            {!data?.state.broadcastId && data?.state.broadcastIntent && (
              <div style={{ marginTop: "6px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                  已核对 Studio 无此场次
                </label>
                <button type="button" className="btn-secondary" style={{ marginTop: "4px" }} disabled={busy || stale || !confirmed} onClick={() => void act("clear-uncertain")}>
                  清理未确认状态
                </button>
              </div>
            )}
          </div>
        </details>

        <button type="button" className="btn-ghost" onClick={() => void refresh()}>
          <RefreshIcon />
          <span>刷新</span>
        </button>
      </div>
    </article>
  );
}
