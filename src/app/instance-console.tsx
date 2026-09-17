/* 文件用途：LiveNest 单个直播实例控制台，管理内容编排、双向管道连接、发射控制与实时推流遥测。 */

"use client";

import { useInstance } from "./use-instance";
import type { InstanceDescriptor } from "@/shared/types";
import { StatusIndicator, type StatusType } from "./components/status-indicator";
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
  ClockIcon,
  AlertCircleIcon,
  SettingsIcon,
} from "./components/icons";

/**
 * 格式化推流毫秒时长为 HH:MM:SS。
 *
 * @param ms 毫秒数值
 * @returns 格式化后的时间文本
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(v => String(v).padStart(2, "0")).join(":");
}

/**
 * LiveNest 单个直播实例工作站卡片组件。
 *
 * @param props 包含实例描述符的属性
 * @returns 实例控制台卡片
 */
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
    ? "状态已过期"
    : live
    ? "ON AIR · LIVE"
    : busy
    ? "处理中…"
    : data?.state.phase === "error"
    ? "需要处理"
    : data?.state.phase === "live"
    ? "状态异常"
    : data?.state.phase === "stopped"
    ? "已就绪 / 待机"
    : "待机";

  const privacyText = {
    unlisted: "不公开列出",
    private: "私密",
    public: "公开",
  }[data?.configuration.privacy || "unlisted"];

  return (
    <article className={`instance-card ${live ? "is-live" : ""}`} id={`instance-${id}`} aria-labelledby={`title-${id}`}>
      {/* 头部：实例与频道信息 */}
      <header className="instance-header">
        <div className="instance-meta">
          <span className="instance-location-tag">
            {instance.agentName || "本机发射机"} / {instance.id}
          </span>
          <h2 className="instance-name" id={`title-${id}`}>
            {name}
          </h2>
          <span className="instance-channel">
            <YouTubeIcon style={{ color: "#ef4444" }} />
            {data?.youtube.channel || "等待连接 YouTube 频道"}
          </span>
        </div>

        <StatusIndicator status={statusType} label={stateLabel} />
      </header>

      {data?.device && (
        <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "16px" }}>
          {data.device.online ? "直播电脑在线" : "直播电脑离线"} · 最近通信{" "}
          {data.device.lastSeen
            ? new Date(data.device.lastSeen).toLocaleTimeString("zh-CN", { hour12: false })
            : "尚未建立通信"}
        </div>
      )}

      {/* 双向管道状态（OBS / YouTube） */}
      <div className="pipeline-hub">
        <div className="pipeline-item">
          <div className="pipeline-info">
            <div className="pipeline-icon-box">
              <ObsIcon />
            </div>
            <div className="pipeline-texts">
              <span className="pipeline-label">OBS 管道</span>
              <span className={`pipeline-status-text ${data?.obs.ready && !stale ? "online" : "offline"}`}>
                <span className="dot" />
                {stale ? "Unknown" : data?.obs.ready ? "Connected" : "Offline"}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn-text-action"
            disabled={busy || !data || stale || data.obs.ready}
            onClick={() => void act("launch")}
          >
            {working === "launch" ? "正在启动…" : "启动 OBS"}
          </button>
        </div>

        <div className="pipeline-item">
          <div className="pipeline-info">
            <div className="pipeline-icon-box">
              <YouTubeIcon />
            </div>
            <div className="pipeline-texts">
              <span className="pipeline-label">YouTube 授权</span>
              <span className={`pipeline-status-text ${data?.youtube.connected && !stale ? "online" : "offline"}`}>
                <span className="dot" />
                {stale ? "Unknown" : data?.youtube.connected ? "Authorized" : "Disconnected"}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn-text-action"
            disabled={busy || !data || stale}
            onClick={() => void act("connect")}
          >
            {data?.youtube.connected ? "重新授权" : "连接频道"}
          </button>
        </div>
      </div>

      {(error || data?.state.error || stale) && (
        <div className="alert-banner error" role="alert">
          <AlertCircleIcon />
          <span>{stale ? `此实例状态已过期：${error}` : error || data?.state.error}</span>
        </div>
      )}

      {!!data?.configuration.missing.length && (
        <details className="alert-banner warning" style={{ display: "block" }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>存在未完成的配置项</summary>
          <p style={{ marginTop: "8px", fontSize: "12px" }}>
            请在对应直播电脑的配置文件中补充以下环境变量后重启：
          </p>
          <ul style={{ paddingLeft: "20px", marginTop: "6px", fontSize: "12px", fontFamily: "var(--font-mono)" }}>
            {data.configuration.missing.map(key => (
              <li key={key}>{key}</li>
            ))}
          </ul>
        </details>
      )}

      {/* 媒体与节目编排区 */}
      <section className="program-section" aria-label={`${name} 直播内容`}>
        <div className="section-title-row">
          <span className="section-title">节目编排</span>
          <span className="section-hint">视频与背景音乐循环推流</span>
        </div>

        <div className="media-selectors-grid">
          <div className="form-field">
            <label htmlFor={`video-${id}`} className="form-label">
              <VideoIcon /> 视频源 <small>Video</small>
            </label>
            <select
              id={`video-${id}`}
              value={selection.video}
              disabled={locked || !data?.media.videos.length}
              onChange={e => select({ video: e.target.value })}
            >
              <option value="">选择循环视频素材</option>
              {selection.video && !data?.media.videos.includes(selection.video) && (
                <option value={selection.video}>{selection.video}（素材库中未找到）</option>
              )}
              {data?.media.videos.map(item => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor={`music-${id}`} className="form-label">
              <MusicIcon /> 音乐源 <small>Music</small>
            </label>
            <select
              id={`music-${id}`}
              value={selection.music}
              disabled={locked || !data?.media.music.length}
              onChange={e => select({ music: e.target.value })}
            >
              <option value="">选择背景音频素材</option>
              {selection.music && !data?.media.music.includes(selection.music) && (
                <option value={selection.music}>{selection.music}（素材库中未找到）</option>
              )}
              {data?.media.music.map(item => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 视频原声微动效开关 */}
        <div className="audio-switch-card">
          <div className="audio-switch-meta">
            <span className="audio-switch-title">
              {selection.videoAudio ? <VolumeIcon /> : <VolumeMuteIcon />} 视频原声音轨
            </span>
            <span className="audio-switch-desc">
              {selection.videoAudio ? "同时混音播放视频自带的原声与背景音乐" : "静音视频原声，仅播放所选背景音乐"}
            </span>
          </div>

          <button
            id={`audio-${id}`}
            type="button"
            role="switch"
            aria-checked={selection.videoAudio}
            aria-label={`${name} 视频原声`}
            className={`switch-control ${selection.videoAudio ? "is-active" : ""}`}
            disabled={locked}
            onClick={() => select({ videoAudio: !selection.videoAudio })}
          >
            <span className="switch-indicator" />
            <span>{selection.videoAudio ? "ON" : "OFF"}</span>
          </button>
        </div>

        {data?.media.error && <p style={{ fontSize: "12px", color: "var(--status-error)", marginBottom: "12px" }}>{data.media.error}</p>}
        {data && (!data.media.videos.length || !data.media.music.length) && (
          <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px" }}>
            提示：当前实例素材库为空，可通过上方素材中心上传或将文件放入目标目录。
          </p>
        )}
        {pending && !live && (
          <p style={{ fontSize: "12px", color: "var(--status-warning)", marginBottom: "12px" }}>
            提示：当前场次尚未结束，可直接重试开始直播，或点击结束直播恢复。
          </p>
        )}

        {/* 控制操作区 */}
        <div className="action-panel">
          <div className="action-buttons-row">
            <button
              type="button"
              className="btn-primary-live"
              disabled={!!blocker}
              aria-describedby={`readiness-${id}`}
              onClick={() => void act("start")}
            >
              <PlayIcon />
              <span>{working === "start" ? "正在准备直播中…" : pending && !live ? "重试开始直播" : "开始直播推流"}</span>
            </button>

            <button
              type="button"
              className="btn-stop-live"
              disabled={busy || stale || !data}
              onClick={() => void act("stop")}
            >
              <StopIcon />
              <span>{working === "stop" ? "正在结束…" : "结束直播"}</span>
            </button>
          </div>

          <div className={`readiness-status-bar ${!blocker ? "is-ready" : "is-blocked"}`} id={`readiness-${id}`}>
            <span className="dot" />
            <span>{blocker || "发射台已就绪 · 点击开始后将自动调度 OBS 与 YouTube API 开播"}</span>
          </div>

          <div className="privacy-tag-row">
            <span>
              {privacyText} · {data?.configuration.madeForKids ? "面向儿童内容" : "非面向儿童"}
            </span>

            {data?.state.broadcastId && (
              <a
                className="watch-youtube-link"
                href={`https://www.youtube.com/watch?v=${encodeURIComponent(data.state.broadcastId)}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${name}：在新标签页中打开 YouTube 直播`}
              >
                <YouTubeIcon />
                <span>观看直播页面</span>
                <ExternalLinkIcon />
              </a>
            )}
          </div>
        </div>
      </section>

      {/* 实时推流监控与遥测 */}
      <section className="telemetry-monitor-card" aria-label={`${name} 实时推流遥测`}>
        <div className="monitor-header">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <ClockIcon style={{ color: "var(--text-secondary)" }} />
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-secondary)" }}>实时推流遥测</span>
          </div>

          <div className="timer-wrapper">
            <span className="stream-timer">{stale ? "—" : data?.obs.streaming ? formatDuration(data.obs.durationMs || 0) : "00:00:00"}</span>
            <span className="stream-timer-label">OBS 实际推流计时</span>
          </div>
        </div>

        <div className="stage-pill" role="status">
          <span style={{ color: "var(--text-muted)", marginRight: "6px" }}>当前状态:</span>
          <strong>
            {stale ? "等待重新连接" : working === "launch" ? "等待 OBS WebSocket 就绪" : data?.state.stage || "正在读取遥测状态…"}
          </strong>
        </div>

        <div className="telemetry-grid">
          <div className="telemetry-cell">
            <span className="telemetry-cell-label">OBS 推流状态</span>
            <span className="telemetry-cell-value">
              {stale || data?.obs.streaming == null
                ? "Unknown"
                : data.obs.reconnecting
                ? "Reconnecting"
                : data.obs.streaming
                ? "Active (推流中)"
                : "Inactive (未推流)"}
            </span>
          </div>

          <div className="telemetry-cell">
            <span className="telemetry-cell-label">YouTube Ingest</span>
            <span className="telemetry-cell-value">{stale ? "Unknown" : data?.youtube.ingest || "—"}</span>
          </div>

          <div className="telemetry-cell">
            <span className="telemetry-cell-label">YouTube 周期</span>
            <span className="telemetry-cell-value">{stale ? "Unknown" : data?.youtube.lifecycle || "—"}</span>
          </div>

          <div className="telemetry-cell">
            <span className="telemetry-cell-label">最近操作人</span>
            <span className="telemetry-cell-value">
              {data?.operation
                ? `${data.operation.actor} (${
                    {
                      queued: "等待接收",
                      delivering: "确认中",
                      uncertain: "待核对",
                      expired: "已过期",
                      accepted: "已接收",
                      running: "执行中",
                      succeeded: "已完成",
                      failed: "失败",
                      interrupted: "待核对",
                    }[data.operation.status] || data.operation.status
                  })`
                : "—"}
            </span>
          </div>
        </div>

        {data?.obs.message && <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "8px" }}>{data.obs.message}</p>}
        {data?.youtube.error && <p style={{ fontSize: "12px", color: "var(--status-error)", marginTop: "8px" }}>{data.youtube.error}</p>}

        <div className="telemetry-footer-meta">
          <span>
            OBS 每 5 秒同步 · YouTube 每 30 秒核验
            {data?.youtube.checkedAt &&
              ` · 最近核对 ${new Date(data.youtube.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}`}
          </span>
        </div>
      </section>

      {/* 高级诊断与异常恢复 */}
      <details className="advanced-details">
        <summary>
          <SettingsIcon />
          <span>高级诊断与状态恢复 (Debug)</span>
        </summary>

        <div className="advanced-body">
          <div className="telemetry-grid">
            <div className="telemetry-cell">
              <span className="telemetry-cell-label">Broadcast ID</span>
              <span className="telemetry-cell-value">{data?.state.broadcastId || "—"}</span>
            </div>
            <div className="telemetry-cell">
              <span className="telemetry-cell-label">Stream ID</span>
              <span className="telemetry-cell-value">{data?.state.streamId || "—"}</span>
            </div>
            <div className="telemetry-cell">
              <span className="telemetry-cell-label">恢复用场次标题</span>
              <span className="telemetry-cell-value">{data?.state.broadcastTitle || "—"}</span>
            </div>
            <div className="telemetry-cell">
              <span className="telemetry-cell-label">OBS 场景与版本</span>
              <span className="telemetry-cell-value">
                {data?.obs.scene || "—"} / {data?.obs.version || "—"}
              </span>
            </div>
          </div>

          {!data?.state.broadcastId && data?.state.broadcastIntent && (
            <div className="recovery-box">
              <p>仅在 YouTube Studio 确认该场次不存在且 OBS 确实未推流时使用：</p>
              <label className="recovery-checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={e => setConfirmed(e.target.checked)}
                />
                <span>我已在 YouTube Studio 确认该场次不存在，且 OBS 未推流</span>
              </label>
              <button
                type="button"
                className="btn-subtle"
                disabled={busy || stale || !confirmed}
                onClick={() => void act("clear-uncertain")}
              >
                清理未确认状态
              </button>
            </div>
          )}
        </div>
      </details>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px", paddingTop: "12px", borderTop: "1px solid var(--border-subtle)" }}>
        <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>OBS → YouTube 独立控制通道</span>
        <button type="button" className="btn-subtle" onClick={() => void refresh()}>
          <RefreshIcon />
          <span>刷新状态</span>
        </button>
      </div>
    </article>
  );
}
