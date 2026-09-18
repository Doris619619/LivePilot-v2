/* 文件用途：LiveNest 单个直播实例控制卡片，支持 20+ 多实例极简紧凑单行与点击展开 1-2-3-4 深度编排。 */

"use client";

import { useState } from "react";
import { useInstance } from "./use-instance";
import type { InstanceDescriptor } from "@/shared/types";
import { StatusBadge, StepSection, type StatusType } from "./components/status-indicator";
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
  ChevronDownIcon,
} from "./components/icons";

/**
 * 将推流时长毫秒数格式化为时分秒。
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(v => String(v).padStart(2, "0")).join(":");
}

/**
 * 单个 OBS 直播实例的极简折叠与展开控制卡片。
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

  const [expanded, setExpanded] = useState(false);

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
    ? "LIVE"
    : busy
    ? "处理中"
    : data?.state.phase === "error"
    ? "需处理"
    : data?.state.phase === "live"
    ? "异常"
    : data?.state.phase === "stopped"
    ? "待机"
    : "就绪";

  const privacyText = {
    unlisted: "不公开列出",
    private: "私密",
    public: "公开",
  }[data?.configuration.privacy || "unlisted"];

  return (
    <article className={`instance-card ${live ? "live-border" : ""}`} id={`instance-${id}`} aria-labelledby={`title-${id}`}>
      {/* 极简折叠顶栏（紧凑定宽，20+ 账号一览全局） */}
      <div
        className="card-compact-bar"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <div className="compact-info-col">
          <span className="compact-id-tag">
            {instance.agentName || "本机"} / {instance.id}
          </span>
          <h2 className="compact-title" id={`title-${id}`}>
            {name}
          </h2>
          <div className="compact-channel">
            <YouTubeIcon style={{ color: "#e11d48" }} />
            <span>{data?.youtube.channel || "等待连接频道"}</span>
          </div>
          {live && data?.obs.streaming && (
            <span className="compact-timer">{formatDuration(data.obs.durationMs || 0)}</span>
          )}
          <StatusBadge status={statusType} label={stateLabel} />
        </div>

        <div className="compact-actions-col" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            className="btn-primary"
            disabled={!!blocker}
            onClick={() => void act("start")}
          >
            <PlayIcon />
            <span>{working === "start" ? "开播中…" : pending && !live ? "重试开播" : "开始直播"}</span>
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

          <button
            type="button"
            className="expand-toggle-btn"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? "收起详情" : "展开详情"}
          >
            <span>{expanded ? "收起" : "编排详情"}</span>
            <span className={`chevron-icon ${expanded ? "is-expanded" : ""}`}>
              <ChevronDownIcon />
            </span>
          </button>
        </div>
      </div>

      {/* 展开后的 1-2-3-4 结构化详情工作台 */}
      {expanded && (
        <div className="card-expanded-drawer">
          {/* 错误提示条 */}
          {(error || data?.state.error || stale) && (
            <div className="banner error" role="alert">
              <AlertCircleIcon />
              <span>{stale ? `状态已过期：${error}` : error || data?.state.error}</span>
            </div>
          )}

          {/* 步骤 1: 管道连接 */}
          <StepSection step="1" title="连接管道检查">
            <div className="connections-grid">
              <div className="conn-box">
                <div className="conn-info">
                  <ObsIcon />
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>OBS 管道:</span>
                  <span className={`conn-status ${data?.obs.ready && !stale ? "connected" : "disconnected"}`}>
                    {stale ? "未知" : data?.obs.ready ? "已就绪" : "未启动"}
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

              <div className="conn-box">
                <div className="conn-info">
                  <YouTubeIcon style={{ color: "#e11d48" }} />
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>YouTube 授权:</span>
                  <span className={`conn-status ${data?.youtube.connected && !stale ? "connected" : "disconnected"}`}>
                    {stale ? "未知" : data?.youtube.connected ? "已授权" : "未连接"}
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
          </StepSection>

          {/* 步骤 2: 节目编排 */}
          <StepSection step="2" title="编排音视频素材">
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
                  <option value="">选择背景音频</option>
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

            <div className="switch-row">
              <div className="switch-label">
                {selection.videoAudio ? <VolumeIcon /> : <VolumeMuteIcon />}
                <span>保留视频原声</span>
                <small style={{ color: "var(--text-muted)", fontWeight: 400 }}>（关则只播背景音乐）</small>
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
          </StepSection>

          {/* 步骤 3: 开播控制与就绪判断 */}
          <StepSection step="3" title="开停播操作">
            <div className="actions-buttons">
              <button
                type="button"
                className="btn-primary"
                disabled={!!blocker}
                aria-describedby={`readiness-${id}`}
                onClick={() => void act("start")}
              >
                <PlayIcon />
                <span>{working === "start" ? "准备推流中…" : pending && !live ? "重试开始直播" : "开始直播"}</span>
              </button>

              <button
                type="button"
                className="btn-danger"
                disabled={busy || stale || !data}
                onClick={() => void act("stop")}
              >
                <StopIcon />
                <span>{working === "stop" ? "正在停止…" : "结束直播"}</span>
              </button>
            </div>

            <div className={`readiness-text ${!blocker ? "ready" : ""}`} id={`readiness-${id}`}>
              {blocker || "✓ 就绪 · 点击开始后将自动调度 OBS 并推送至 YouTube"}
            </div>

            <div className="sub-meta-row">
              <span>{privacyText} · {data?.configuration.madeForKids ? "面向儿童" : "常规内容"}</span>
              {data?.state.broadcastId && (
                <a
                  className="watch-link"
                  href={`https://www.youtube.com/watch?v=${encodeURIComponent(data.state.broadcastId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>YouTube 直播页面</span>
                  <ExternalLinkIcon />
                </a>
              )}
            </div>
          </StepSection>

          {/* 步骤 4: 实时遥测 */}
          <StepSection step="4" title="推流遥测监视">
            <div className="telemetry-timer-banner">
              <span className="telemetry-stage-text">
                状态：<strong>{stale ? "离线重连中" : working === "launch" ? "等待 OBS 响应" : data?.state.stage || "读取中…"}</strong>
              </span>
              <span className="telemetry-timer">{stale ? "—" : data?.obs.streaming ? formatDuration(data.obs.durationMs || 0) : "00:00:00"}</span>
            </div>

            <div className="telemetry-table">
              <div className="telemetry-cell">
                <span className="telemetry-cell-label">OBS 推流状态</span>
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
                <span className="telemetry-cell-label">YouTube 周期</span>
                <span className="telemetry-cell-value">{stale ? "未知" : data?.youtube.lifecycle || "—"}</span>
              </div>
            </div>
          </StepSection>

          {/* 卡片底部辅助与诊断 */}
          <div className="card-footer">
            <details style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              <summary style={{ cursor: "pointer" }}>高级诊断与恢复</summary>
              <div style={{ marginTop: "6px", fontSize: "11px", fontFamily: "var(--font-mono)" }}>
                <div>Broadcast ID: {data?.state.broadcastId || "—"}</div>
                <div>Stream ID: {data?.state.streamId || "—"}</div>
                {!data?.state.broadcastId && data?.state.broadcastIntent && (
                  <div style={{ marginTop: "6px" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                      已核对 Studio 无此场次
                    </label>
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ marginTop: "4px" }}
                      disabled={busy || stale || !confirmed}
                      onClick={() => void act("clear-uncertain")}
                    >
                      清理未确认状态
                    </button>
                  </div>
                )}
              </div>
            </details>

            <button type="button" className="btn-ghost" onClick={() => void refresh()}>
              <RefreshIcon />
              <span>刷新状态</span>
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
