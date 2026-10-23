/* 文件用途：组织网页三步开播与就地恢复，统一摘要和运行状态结论；控制仍由所属实例模型执行。 */

"use client";

import { useEffect, useRef, useState } from "react";
import { canStopBroadcast } from "@/shared/readiness";
import BroadcastSettings from "./components/broadcast-settings";
import LiveChatPanel from "./components/live-chat-panel";
import OAuthFeedback from "./oauth-feedback";
import ProblemCard from "./components/problem-card";
import { makeProblem, configurationLabel, type Problem } from "../shared/problems";
import { useInstance } from "./use-instance";
import { targetKey } from "@/shared/remote";
import { freshYouTubeEvidence } from "@/shared/youtube-evidence";
import type { InstanceDescriptor } from "@/shared/types";
import { StatusBadge } from "./components/status-indicator";
import BroadcastRuntime from "./components/broadcast-runtime";
import { runtimeActionMode, runtimeSummary } from "./components/broadcast-runtime-model";
import { Reveal } from "./components/ui/primitives";
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
export default function InstanceConsole({ instance, onChannelChange, onUpload, initiallyExpanded = true, deviceOffline = false }: { instance: InstanceDescriptor; initiallyExpanded?: boolean; deviceOffline?: boolean; onChannelChange: (key: string, channel: string) => void; onUpload: (target: string, kind: "videos" | "music") => void }) {
  const { name } = instance;
  const id = instance.agentId ? `${instance.agentId}-${instance.id}` : instance.id;
  const model = useInstance(instance);
  const {
    data,
    durationMs,
    selection,
    working,
    checking,
    error,
    stale,
    confirmed,
    setConfirmed,
    refresh,
    checkPlatform,
    act,
    busy,
    live,
    pending,
    locked,
    blocker,
    select,
  } = model;

  const [detailsBusy, setDetailsBusy] = useState(false);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [workflowTab, setWorkflowTab] = useState("media");
  const connectionsRef = useRef<HTMLDetailsElement>(null);
  const channel = data?.youtube.channel?.trim() || "";
  const title = channel || name;
  const key = targetKey(instance);

  /** 复用当前状态轮询，让上传列表与实例标题共享频道名；卸载时清除旧映射。 */
  useEffect(() => {
    onChannelChange(key, channel);
    return () => onChannelChange(key, "");
  }, [key, channel, onChannelChange]);

  const operationLabel = data?.operation && { queued: "等待设备接收", delivering: "等待设备确认", uncertain: "结果待核对", expired: "未接收已过期", accepted: "设备已接收", running: "执行中", succeeded: "已完成", failed: "需要处理", interrupted: "重启后待核对" }[data.operation.status];

  const runtimeInput = { data, stale, busy, live, error, working };
  const summary = runtimeSummary(runtimeInput);
  const statusType = summary.status;
  const stateLabel = !live && !busy && !stale && !error && blocker && summary.status === "ready" ? "待配置" : summary.label;

  const issues: Problem[] = [model.problem, data?.obs.problem, data?.youtube.problem, ...(data?.media.problems || []), ...(data?.problems || [])].filter((p): p is NonNullable<typeof p>=>!!p).map(p=>({...p,target:{...p.target,agentId:instance.agentId,instanceId:instance.id}}));
  // 兼容尚未返回结构化问题的设备，移除诊断区后仍保留真实失败原因。
  if (!stale && data?.obs.ready === false && data.obs.message && !issues.some(p => p.domain === "obs")) issues.push(makeProblem("OBS_READ", data.obs.message, { target: { agentId: instance.agentId, instanceId: instance.id }, outcome: "rejected", stage: "检查 OBS 连接" }));
  if (!stale && data?.youtube.error && !issues.some(p => p.domain === "youtube")) issues.push(makeProblem("YOUTUBE_READ", data.youtube.error, { target: { agentId: instance.agentId, instanceId: instance.id }, outcome: "rejected", stage: "读取频道状态" }));
  if (!issues.length && (error || data?.state.error)) issues.push(makeProblem("CONTROL",error || data!.state.error!,{target:{agentId:instance.agentId,instanceId:instance.id},attemptId:data?.operation?.id,stage:"直播操作"}));
  if(data?.configuration.missing.length)issues.push(makeProblem("CONFIG",[...new Set(data.configuration.missing.map(configurationLabel))].join("；"),{target:{agentId:instance.agentId,instanceId:instance.id},outcome:"rejected",stage:"检查开播配置"}));
  const readiness = data?.configuration.missing.length ? "设备配置未完成，请按上方提示在直播电脑补齐。" : blocker;

  /** 将恢复入口定位到设备与频道，并移动焦点；不依赖其他折叠区的排列顺序。 */
  function showConnections() {
    setExpanded(true);
    requestAnimationFrame(() => {
      const connections = connectionsRef.current;
      if (!connections) return;
      connections.open = true;
      connections.querySelector("summary")?.focus({ preventScroll: true });
      connections.scrollIntoView({ block: "nearest" });
    });
  }

  const stoppable = canStopBroadcast(data);
  const ended = !stale && !!data && freshYouTubeEvidence(data.youtube) && data.youtube.lifecycle === "complete" && data.obs.streaming === false && pending;
  const actionMode = runtimeActionMode(runtimeInput);
  /** 摘要入口只定位到当前实例的开播区，不在摘要栏发送开停播命令。 */
  function showBroadcast() {
    setExpanded(true);
    setWorkflowTab("start");
    requestAnimationFrame(() => {
      const heading = document.getElementById(`step-4-${id}`);
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "nearest" });
    });
  }
  /** 停止前核对当前实例与场次；已确认结束时仅解锁旧素材，不重复询问结束场次。 */
  async function stopBroadcast() {
    if (!ended && !window.confirm(`结束“${title}”的直播？\n电脑：${instance.agentName || "本机"} · OBS：${name}\n场次：${data?.state.broadcastTitle || "当前场次"}\n结束后不能恢复此 YouTube 场次。`)) return;
    await act("stop");
  }
  const broadcastControls = <>
          {actionMode === "working" && <button type="button" className="btn-primary" disabled><span>{working === "stop" ? "结束中…" : "正在处理…"}</span></button>}
          {(actionMode === "check" || actionMode === "live") && <button type="button" className={actionMode === "check" ? "btn-primary" : "btn-secondary"} disabled={busy || checking} onClick={() => void checkPlatform()}><RefreshIcon />{checking ? "正在核对平台…" : "重新检查状态"}</button>}
          {actionMode === "confirm-obs" && <button type="button" className="btn-primary" disabled={busy} onClick={() => void act("launch")}>确认 OBS 已启动</button>}
          {(actionMode === "start" || actionMode === "retry" || actionMode === "resume") && <button type="button" className="btn-primary" disabled={!!blocker || detailsBusy} aria-describedby={`compact-readiness-${id}`} onClick={() => void act("start")}>
            <PlayIcon /><span>{actionMode === "resume" ? "继续本场开播" : actionMode === "retry" ? "重试开播" : "开始直播"}</span>
          </button>}
          {stoppable && <button type="button" className="btn-danger" disabled={busy || stale || actionMode === "working"} onClick={() => void stopBroadcast()}>
            <StopIcon /><span>{working === "stop" ? "结束中…" : ended ? "确认结束并解锁素材" : "结束直播"}</span>
          </button>}
  </>;

  return (
    <article className={`instance-card ${live ? "live-border" : ""}`} id={`instance-${id}`} aria-labelledby={`title-${id}`}>
      <div className="card-compact-bar">
        <div className="compact-info-col">
          <h2 className="compact-title" id={`title-${id}`}>{title}</h2>
          <div className="compact-channel"><ObsIcon /><span>{name}{channel ? " · YouTube 频道" : " · 频道待连接"}</span></div>
        </div>
        <div className="instance-state">
          <StatusBadge status={statusType} label={stateLabel} />
          {live && data?.obs.streaming && <span className="compact-timer">{durationMs === null ? "—" : formatDuration(durationMs)}</span>}
        </div>
        <div className="compact-actions-col">
          {(stoppable || busy) && <button type="button" className="btn-ghost" onClick={showBroadcast}>查看运行状态</button>}
          <button type="button" className="expand-toggle-btn" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "收起详情" : "展开详情"} aria-expanded={expanded} aria-controls={`details-${id}`}>
            <span>{expanded ? "收起" : "配置直播"}</span><span className={`chevron-icon ${expanded ? "is-expanded" : ""}`}><ChevronDownIcon /></span>
          </button>
        </div>
      </div>

      <OAuthFeedback instance={instance} />
      {/* 只把异常和阻塞原因放在主列表，正常状态不重复解释。 */}
      {issues.filter(problem => !(deviceOffline && problem.code === "CLOUD_UNAVAILABLE" && problem.stage === "读取实例状态" && !problem.attemptId)).map((problem,index)=><ProblemCard key={problem.code+index} problem={problem} objectName={(instance.agentName || "本机")+" · "+name} showGuidance settingsLabel="查看设备与频道" onRefresh={()=>void refresh()} onSettings={showConnections} onAuthorize={problem.actions.includes("authorize") && !busy && !stale ? ()=>void act("connect") : undefined} />)}
      {!data?.state.broadcastId && data?.state.broadcastIntent && <section className="problem-card error" role="alert" aria-label="核对未确认场次">
        <strong>上次开播结果尚未确认</strong>
        <p>先在原频道 YouTube Studio 核对场次。确认没有创建直播后，才能清理本地记录并重新准备。</p>
        <div className="problem-actions"><a className="btn-secondary" href="https://studio.youtube.com" target="_blank" rel="noopener noreferrer">打开 YouTube Studio<ExternalLinkIcon /></a><button type="button" className="btn-secondary" disabled={busy} onClick={()=>void refresh()}><RefreshIcon />重新检查</button></div>
        <div className="recovery-controls"><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />已核对原频道没有此场次</label><button type="button" className="btn-secondary" disabled={busy || stale || !confirmed} onClick={() => void act("clear-uncertain")}>清理未确认状态</button></div>
      </section>}
      {data?.operation && data.operation.status !== "succeeded" && <p className="instance-feedback" role="status">最近操作：{data.operation.actor} · {operationLabel}</p>}
      <p className={!expanded && blocker && !live && !stale && !error ? "instance-feedback readiness-text" : "visually-hidden"} id={`compact-readiness-${id}`}>{readiness || "已就绪"}</p>

      <Reveal open={expanded} id={`details-${id}`}><div className="card-expanded-drawer">
        {pending && !live && <p className="readiness-text">{ended ? "该场次已结束，确认后可选择下一场素材。" : "当前场次尚未结束，素材暂时锁定。"}<button type="button" className="btn-ghost" disabled={busy || stale} onClick={ended ? () => void act("stop") : showBroadcast}>{ended ? "解锁素材" : "查看并处理当前场次"}</button></p>}
        <details ref={connectionsRef} className="studio-connections"><summary>设备与频道<span>{stale ? "连接状态待更新" : `${data?.obs.ready ? "OBS 已连接" : "OBS 待连接"} · ${data?.youtube.connected ? "频道已授权" : "频道待授权"}`}</span></summary><div className="instance-workflow">
          <section className="workflow-step" aria-labelledby={`step-1-${id}`}>
            <h3 className="visually-hidden" id={`step-1-${id}`}>设备与频道</h3>
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

          </div></details>
          <BroadcastSettings tab={workflowTab} onTabChange={setWorkflowTab} id={id} instance={instance} value={selection.broadcast} disabled={locked || stale || !data} channel={channel} channelId={data?.youtube.channelId} broadcastId={data?.state.broadcastId} videoName={selection.video} musicName={selection.music} videoAudio={selection.videoAudio} live={data?.state.phase === "live"} onChange={broadcast => select({ broadcast })} onSelectionChange={select} onBusyChange={setDetailsBusy} media={suffix => <section className="workflow-step" aria-labelledby={`step-2-${id}-${suffix}`}>
            <h3 className="visually-hidden" id={`step-2-${id}-${suffix}`}>音视频编排</h3>
        <div className="form-row media-selection">
          <div className="field-group">
            <label htmlFor={`video-${id}-${suffix}`} className="field-label">循环视频</label>
            <select id={`video-${id}-${suffix}`} name={`video-${id}`} autoComplete="off" value={selection.video} disabled={locked || !data?.media.videos.length} onChange={e => select({ video: e.target.value })}>
              <option value="">选择视频素材</option>
              {selection.video && !data?.media.videos.includes(selection.video) && <option value={selection.video}>{selection.video}（缺失）</option>}
              {data?.media.videos.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            {data && !stale && !data.media.error && !data.media.videos.length && <div className="media-empty"><p>还没有视频，添加后即可选择。</p><button type="button" className="btn-secondary" onClick={() => onUpload(key, "videos")}>添加视频</button></div>}
          </div>
          <div className="field-group">
            <label htmlFor={`music-${id}-${suffix}`} className="field-label">背景音乐（必选）</label>
            <select id={`music-${id}-${suffix}`} name={`music-${id}`} autoComplete="off" value={selection.music} disabled={locked || !data?.media.music.length} onChange={e => select({ music: e.target.value })}>
              <option value="">选择背景音乐</option>
              {selection.music && !data?.media.music.includes(selection.music) && <option value={selection.music}>{selection.music}（缺失）</option>}
              {data?.media.music.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            {data && !stale && !data.media.error && !data.media.music.length && <div className="media-empty"><p>请添加背景音乐后开播。</p><button type="button" className="btn-ghost" onClick={() => onUpload(key, "music")}>添加音乐</button></div>}
          </div>
        </div>



          </section>} controls={<BroadcastRuntime key={`${key}:${data?.state.broadcastId || "draft"}`} id={id} data={data} stale={stale} durationMs={durationMs} summary={summary} readiness={actionMode === "start" || actionMode === "retry" ? readiness : undefined} controls={broadcastControls} />} />

        {(live || pending) && <LiveChatPanel key={key} instance={instance} status={data?.liveChat} supported={!data || data.configuration.liveChat === true} stale={stale || !data} onRefresh={refresh} />}

      </div></Reveal>
    </article>
  );
}
