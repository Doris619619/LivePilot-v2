/* 文件用途：按四个步骤组织直播操作，明确电脑、OBS 实例与授权频道的对应关系。 */

"use client";

import { useEffect, useState } from "react";
import OAuthFeedback from "./oauth-feedback";
import ProblemCard from "./components/problem-card";
import { makeProblem, configurationLabel, type Problem } from "../shared/problems";
import { useInstance } from "./use-instance";
import { targetKey } from "@/shared/remote";
import type { InstanceDescriptor } from "@/shared/types";
import { StatusBadge, type StatusType } from "./components/status-indicator";
import {
  ObsIcon,
  YouTubeIcon,
  PlayIcon,
  StopIcon,
  RefreshIcon,
  ExternalLinkIcon,
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
export default function InstanceConsole({ instance, onChannelChange, onUpload }: { instance: InstanceDescriptor; onChannelChange: (key: string, channel: string) => void; onUpload: (target: string, kind: "videos" | "music") => void }) {
  const { name } = instance;
  const id = instance.agentId ? `${instance.agentId}-${instance.id}` : instance.id;
  const model = useInstance(instance);
  const {
    data,
    durationMs,
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

  const [expanded, setExpanded] = useState(true);
  const channel = data?.youtube.channel?.trim() || "";
  const title = channel || name;
  const key = targetKey(instance);

  /** 复用当前状态轮询，让上传列表与实例标题共享频道名；卸载时清除旧映射。 */
  useEffect(() => {
    onChannelChange(key, channel);
    return () => onChannelChange(key, "");
  }, [key, channel, onChannelChange]);

  const operationLabel = data?.operation && { queued: "等待设备接收", delivering: "等待设备确认", uncertain: "结果待核对", expired: "未接收已过期", accepted: "设备已接收", running: "执行中", succeeded: "已完成", failed: "需要处理", interrupted: "重启后待核对" }[data.operation.status];

  const statusType: StatusType = stale
    ? "stale"
    : !data ? "busy" : live
    ? "live"
    : busy
    ? "busy"
    : error || data?.state.phase === "error"
    ? "error"
    : data?.state.phase === "live"
    ? "error"
    : data?.state.phase === "stopped"
    ? "standby"
    : blocker ? "standby" : "ready";

  const stateLabel = stale
    ? "离线/过期"
    : !data ? "读取中" : live
    ? "直播中"
    : busy
    ? operationLabel || "处理中"
    : error || data?.state.phase === "error"
    ? "需处理"
    : data?.state.phase === "live"
    ? "异常"
    : data?.state.phase === "stopped"
    ? "待机"
    : blocker ? "待配置" : "就绪";

  const privacyText = {
    unlisted: "不公开列出",
    private: "私密",
    public: "公开",
  }[data?.configuration.privacy || "unlisted"];

  const issues: Problem[] = [model.problem, data?.obs.problem, data?.youtube.problem, ...(data?.media.problems || []), ...(data?.problems || [])].filter((p): p is NonNullable<typeof p>=>!!p).map(p=>({...p,target:{...p.target,agentId:instance.agentId,instanceId:instance.id}}));
  if (!issues.length && (error || data?.state.error)) issues.push(makeProblem("CONTROL",error || data!.state.error!,{target:{agentId:instance.agentId,instanceId:instance.id},attemptId:data?.operation?.id,stage:"直播操作"}));
  if(data?.configuration.missing.length)issues.push(makeProblem("CONFIG",[...new Set(data.configuration.missing.map(configurationLabel))].join("；"),{target:{agentId:instance.agentId,instanceId:instance.id},outcome:"rejected",stage:"检查开播配置"}));
  const readiness = data?.configuration.missing.length ? "设备配置未完成，请查看连接与诊断。" : blocker;

  const broadcastControls = <>
          <button type="button" className="btn-primary" disabled={!!blocker} aria-describedby={`compact-readiness-${id}`} onClick={() => void act("start")}>
            <PlayIcon /><span>{working === "start" ? "开播中…" : pending && !live ? "重试开播" : "开始直播"}</span>
          </button>
          <button type="button" className="btn-danger" disabled={busy || stale || !data} onClick={() => void act("stop")}>
            <StopIcon /><span>{working === "stop" ? "结束中…" : "结束直播"}</span>
          </button>
  </>;

  return (
    <article className={`instance-card ${live ? "live-border" : ""}`} id={`instance-${id}`} aria-labelledby={`title-${id}`}>
      <div className="card-compact-bar">
        <div className="compact-info-col">
          <h2 className="compact-title" id={`title-${id}`}>{title}</h2>
          <div className="compact-channel"><ObsIcon /><span>{instance.agentName || "本机"} · {name} · {instance.id}</span></div>
        </div>
        <div className="instance-state">
          <StatusBadge status={statusType} label={stateLabel} />
          {live && data?.obs.streaming && <span className="compact-timer">{durationMs === null ? "—" : formatDuration(durationMs)}</span>}
        </div>
        <div className="compact-actions-col">
          {!expanded && broadcastControls}
          <button type="button" className="expand-toggle-btn" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "收起详情" : "展开详情"} aria-expanded={expanded} aria-controls={`details-${id}`}>
            <span>{expanded ? "收起" : "设置"}</span><span className={`chevron-icon ${expanded ? "is-expanded" : ""}`}><ChevronDownIcon /></span>
          </button>
        </div>
      </div>

      <OAuthFeedback instance={instance} />
      {/* 只把异常和阻塞原因放在主列表，正常状态不重复解释。 */}
      {issues.map((problem,index)=><ProblemCard key={problem.code+index} problem={problem} objectName={(instance.agentName || "本机")+" · "+name} onRefresh={()=>void refresh()} onSettings={()=>{setExpanded(true);requestAnimationFrame(()=>{const details=document.querySelector<HTMLDetailsElement>("#instance-"+id+" .instance-diagnostics");if(details){details.open=true;details.scrollIntoView({block:"nearest"});}});}} onHelp={()=>{setExpanded(true);requestAnimationFrame(()=>{const details=document.querySelector<HTMLDetailsElement>("#instance-"+id+" .instance-diagnostics");if(details){details.open=true;details.scrollIntoView({block:"nearest"});}});}} onAuthorize={problem.actions.includes("authorize") && !busy && !stale ? ()=>void act("connect") : undefined} />)}
      {data?.operation && data.operation.status !== "succeeded" && <p className="instance-feedback" role="status">最近操作：{data.operation.actor} · {operationLabel}</p>}
      <p className={blocker && !live && !stale && !error ? "instance-feedback readiness-text" : "visually-hidden"} id={`compact-readiness-${id}`}>{readiness || "已就绪"}</p>

      {expanded && <div className="card-expanded-drawer" id={`details-${id}`}>
        {pending && !live && <p className="readiness-text">当前场次尚未结束，重试或结束直播后可更换素材。</p>}
        <div className="instance-workflow">
          <section className="workflow-step" aria-labelledby={`step-1-${id}`}>
            <h3 id={`step-1-${id}`}><span className="step-number">1</span>设备与频道</h3>
            <div className="connections-grid">
              <div className="conn-box">
                <div className="conn-info"><ObsIcon /><span>{name}</span><span className={`conn-status ${data?.obs.ready && !stale ? "connected" : "disconnected"}`}>{stale ? "未知" : data?.obs.ready ? "已连接" : data?.obs.processKnown === false ? "状态未知" : data?.obs.running ? "控制未连接" : "未启动"}</span></div>
                <button type="button" className="btn-ghost" disabled={busy || !data || stale || data.obs.ready || data.obs.running || data.obs.processKnown === false} onClick={() => void act("launch")}>{working === "launch" ? "启动中…" : "启动 OBS"}</button>
              </div>
              <div className="conn-box">
                <div className="conn-info"><YouTubeIcon /><span>{channel || "YouTube 频道"}</span><span className={`conn-status ${data?.youtube.connected && !stale ? "connected" : "disconnected"}`}>{stale ? "未知" : data?.youtube.query === "failed" ? "查询受阻" : data?.youtube.connected ? "已授权" : channel ? "授权失效" : "未连接"}</span></div>
                <button type="button" className="btn-ghost" disabled={busy || !data || stale} onClick={() => void act("connect")}>{data?.youtube.connected ? "重新授权" : "连接频道"}</button>
              </div>
            </div>

            {data?.youtube.channelId && <a className="channel-link" href={`https://www.youtube.com/channel/${encodeURIComponent(data.youtube.channelId)}`} target="_blank" rel="noopener noreferrer">打开已绑定频道<ExternalLinkIcon /></a>}
          </section>
          <section className="workflow-step" aria-labelledby={`step-2-${id}`}>
            <h3 id={`step-2-${id}`}><span className="step-number">2</span>音视频编排</h3>
        <div className="form-row media-selection">
          <div className="field-group">
            <label htmlFor={`video-${id}`} className="field-label">循环视频</label>
            <select id={`video-${id}`} value={selection.video} disabled={locked || !data?.media.videos.length} onChange={e => select({ video: e.target.value })}>
              <option value="">选择视频素材</option>
              {selection.video && !data?.media.videos.includes(selection.video) && <option value={selection.video}>{selection.video}（缺失）</option>}
              {data?.media.videos.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            {data && !stale && !data.media.error && !data.media.videos.length && <div className="media-empty"><p>还没有视频，添加后即可选择。</p><button type="button" className="btn-secondary" onClick={() => onUpload(key, "videos")}>添加视频</button></div>}
          </div>
          <div className="field-group">
            <label htmlFor={`music-${id}`} className="field-label">背景音乐</label>
            <select id={`music-${id}`} value={selection.music} disabled={locked || !data?.media.music.length} onChange={e => select({ music: e.target.value })}>
              <option value="">选择背景音乐</option>
              {selection.music && !data?.media.music.includes(selection.music) && <option value={selection.music}>{selection.music}（缺失）</option>}
              {data?.media.music.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            {data && !stale && !data.media.error && !data.media.music.length && <div className="media-empty"><p>还没有音乐，可添加背景音乐。</p><button type="button" className="btn-ghost" onClick={() => onUpload(key, "music")}>添加音乐</button></div>}
          </div>
        </div>
        <div className="media-options">
          <div className="switch-row">
            <span className="switch-label">视频原声</span>
            <button id={`audio-${id}`} type="button" role="switch" aria-checked={selection.videoAudio} aria-label={`${title} 视频原声`} className={`switch-btn ${selection.videoAudio ? "active" : ""}`} disabled={locked} onClick={() => select({ videoAudio: !selection.videoAudio })}>
              <span className="switch-track" aria-hidden="true"><span /></span><span>{selection.videoAudio ? "开启" : "关闭"}</span>
            </button>
          </div>
          {data?.state.broadcastId && <a className="watch-link" href={`https://www.youtube.com/watch?v=${encodeURIComponent(data.state.broadcastId)}`} target="_blank" rel="noopener noreferrer">查看直播<ExternalLinkIcon /></a>}
        </div>


          </section>
          <section className="workflow-step" aria-labelledby={`step-3-${id}`}>
            <h3 id={`step-3-${id}`}><span className="step-number">3</span>直播控制</h3>
            <div className="broadcast-actions">{broadcastControls}</div>
          </section>
          <section className="workflow-step" aria-labelledby={`step-4-${id}`}>
            <h3 id={`step-4-${id}`}><span className="step-number">4</span>运行状态</h3>
            <div className="workflow-status"><StatusBadge status={statusType} label={stateLabel} /><span className="runtime-duration">{stale || durationMs === null ? "—" : formatDuration(durationMs)}</span></div>
            <dl className="runtime-values">
              <div><dt>OBS 推流</dt><dd>{stale || data?.obs.streaming == null ? "未知" : data.obs.reconnecting ? "重连中" : data.obs.streaming ? "推流中" : "未推流"}</dd></div>
              <div><dt>YouTube</dt><dd>{stale ? "未知" : data?.youtube.lifecycle || "—"}</dd></div>
            </dl>
          </section>
        </div>

        <details className="instance-diagnostics">
          <summary>连接与诊断</summary>
          <div className="diagnostics-content">
            {!!data?.configuration.missing.length && <div className="banner error"><span>请在直播电脑补齐：{[...new Set(data.configuration.missing.map(configurationLabel))].join("、")}</span></div>}
            {data?.obs.message && <p className="readiness-text">{data.obs.message}</p>}
            {data?.youtube.error && <p className="readiness-text">{data.youtube.error}</p>}
            <dl className="diagnostic-values">
              <div><dt>频道 ID</dt><dd>{data?.youtube.channelId || "—"}</dd></div>
              <div><dt>当前步骤</dt><dd>{stale ? "离线重连中" : working === "launch" ? "等待 OBS 响应" : data?.state.stage || "读取中…"}</dd></div>
              <div><dt>可见范围</dt><dd>{privacyText} · {data?.configuration.madeForKids ? "面向儿童" : "常规内容"}</dd></div>
              <div><dt>实例</dt><dd>{instance.agentName || "本机"} / {instance.id}</dd></div>
              <div><dt>Broadcast ID</dt><dd>{data?.state.broadcastId || "—"}</dd></div>
              <div><dt>Stream ID</dt><dd>{data?.state.streamId || "—"}</dd></div>
            </dl>
            {!data?.state.broadcastId && data?.state.broadcastIntent && <div className="recovery-controls">
              <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />已核对 Studio 无此场次</label>
              <button type="button" className="btn-secondary" disabled={busy || stale || !confirmed} onClick={() => void act("clear-uncertain")}>清理未确认状态</button>
            </div>}
            <button type="button" className="btn-ghost" onClick={() => void refresh()}><RefreshIcon />刷新状态</button>
          </div>
        </details>
      </div>}
    </article>
  );
}
