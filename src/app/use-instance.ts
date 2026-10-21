/** 为一个 OBS 面板管理状态轮询、媒体草稿及命令；各面板互不阻塞。 */
"use client";
import { makeProblem, type Problem } from "../shared/problems";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dashboard, Selection, InstanceDescriptor } from "@/shared/types";
import { targetKey } from "@/shared/remote";
import { api, requestProblem } from "./client-request";
import type { BroadcastDefaults } from "@/shared/broadcast-options";
import { defaultLiveChatConfig } from "@/shared/live-chat";
import { defaultBroadcast } from "@/shared/broadcast";
import { useStreamClock } from "./use-stream-clock";
import { startBlocker } from "@/shared/readiness";
import { hasPendingBroadcast } from "@/shared/broadcast-recovery";
import { freshYouTubeEvidence, mergeDashboardEvidence } from "@/shared/youtube-evidence";
import { useWorkbenchActive } from "./components/workbench-context";

/** 保存实例媒体与公开直播详情，不保存路径、图片原始数据或授权信息。 */
function readDraft(id: string): Selection | undefined {
  try {
    const draft = JSON.parse(sessionStorage.getItem("livepilot-selection-" + id) || "null");
    if (draft && typeof draft.video === "string" && typeof draft.music === "string" && typeof draft.videoAudio === "boolean") return draft;
  } catch { /* 浏览器禁用存储时仍可使用面板。 */ }
}

/** 每个调用绑定一个稳定实例 ID；请求和草稿永远携带该 ID。 */
export function useInstance(instance: InstanceDescriptor) {
  const active = useWorkbenchActive();
  const id = targetKey(instance); const instanceId = instance.id; const agentId = instance.agentId;
  const [data, setData] = useState<Dashboard>();
  const { durationMs, synchronize, clear: clearClock } = useStreamClock();
  const [selection, setSelection] = useState<Selection>({ video: "", music: "", videoAudio: false });
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [problem, setProblem] = useState<Problem>(); const failedRequest = useRef<string | undefined>(undefined);
  const [readFailed, setStale] = useState(false);
  const [readAt,setReadAt]=useState(0);const [now,setNow]=useState(0);
  const stale=readFailed || (!!data && now-readAt>20_000);
  const [readError, setReadError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const initialized = useRef(false);
  const fetching = useRef<AbortController | undefined>(undefined);
  const acting = useRef(false);
  const check = useRef<AbortController | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const evidence = useRef<Dashboard | undefined>(undefined);
  const sequence = useRef(0), accepted = useRef(0), generation = useRef(0);
  /** 一次接受决定覆盖状态、草稿、计时与请求确认；读取默认值后再次核对，旧成功/失败均无副作用。 */
  const accept = useCallback(async (result: Dashboard, ticket: number, epoch: number, signal: AbortSignal) => {
    /** 同时比较请求次序、写入代次与设备证据，不能只过滤最终setData。 */
    const eligible = () => !signal.aborted && epoch === generation.current && ticket >= accepted.current && mergeDashboardEvidence(evidence.current, result) !== evidence.current;
    if (!eligible()) return;
    const saved = !initialized.current ? (hasPendingBroadcast(result.state) ? result.state.selection : readDraft(id)) || result.state.selection : undefined;
    const defaults = !initialized.current && !saved ? (await api<{ value: BroadcastDefaults }>("/api/broadcast-defaults", { signal })).value : undefined;
    if (!eligible()) return;
    const current = mergeDashboardEvidence(evidence.current, result);
    accepted.current = ticket; evidence.current = current;
    setData(current); setReadAt(Date.now()); synchronize(current);
    setStale(!!current.device && !current.device.online); setReadError(current.device && !current.device.online ? current.obs.message || "设备状态不可用" : "");
    if (current.operation?.id === failedRequest.current && ["succeeded", "failed", "interrupted", "expired"].includes(current.operation?.status || "")) { setError(""); setProblem(undefined); failedRequest.current = undefined; }
    try {
      const key = "livepilot-request-" + id;
      const request = JSON.parse(sessionStorage.getItem(key) || "null");
      if (request?.requestId === current.operation?.id) sessionStorage.removeItem(key);
    } catch { /* 存储不可用不影响已接受状态。 */ }
    if (current.state.selection && hasPendingBroadcast(current.state)) setSelection(current.state.selection);
    if (!initialized.current) {
      const initial = saved || { video: current.media.videos.length === 1 ? current.media.videos[0] : "", music: current.media.music.length === 1 ? current.media.music[0] : "", videoAudio: defaults?.videoAudio ?? false };
      initialized.current = true;
      setSelection(hasPendingBroadcast(current.state) && current.state.broadcastTitle ? initial : { ...initial, broadcast: { ...(initial.broadcast || { ...defaultBroadcast(), ...(defaults ? { privacy: defaults.privacy, madeForKids: defaults.madeForKids } : {}) }), liveChat: initial.broadcast?.liveChat || current.liveChat?.config || { ...defaultLiveChatConfig } } });
    }
  }, [id, synchronize]);
  /** 普通轮询与人工核对共享接受顺序，写操作会使之前的读取失效。 */
  const refresh = useCallback(async () => {
    if (fetching.current || acting.current) return;
    const controller = new AbortController(); fetching.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const ticket = ++sequence.current, epoch = generation.current;
    try {
      const result = await api<Dashboard>("/api/status?instanceId=" + encodeURIComponent(instanceId) + (agentId ? "&agentId=" + encodeURIComponent(agentId) : ""), { signal });
      await accept(result, ticket, epoch, signal);
    } catch (e) { if (!controller.signal.aborted && epoch === generation.current && ticket >= accepted.current) { accepted.current = ticket; clearClock(); setStale(true); setReadError(e instanceof Error ? e.message : "读取失败，请检查本机服务"); } }
    finally { if (fetching.current === controller) fetching.current = undefined; }
  }, [instanceId, agentId, accept, clearClock]);

  /** 人工核对只读且可被停止取代；取消后迟到的成功和错误都不能覆盖后续操作。 */
  async function checkPlatform() {
    if (!data) { await refresh(); return; }
    if (!data.configuration.youtubeRefresh) { setError("请升级直播电脑的 Agent 后重新核对平台，或到 YouTube Studio 手动核对。"); return; }
    if (acting.current || check.current) return;
    const controller = new AbortController(); check.current = controller; setChecking(true);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const ticket = ++sequence.current, epoch = generation.current;
    setError(""); setProblem(undefined);
    try {
      const result = await api<Dashboard>("/api/status?instanceId=" + encodeURIComponent(instanceId) + (agentId ? "&agentId=" + encodeURIComponent(agentId) : ""), { method: "POST", headers: { "X-LivePilot": "1" }, signal });
      await accept(result, ticket, epoch, signal);
    } catch (e) { if (!controller.signal.aborted && epoch === generation.current && ticket >= accepted.current) { accepted.current = ticket; setProblem({ ...requestProblem(e), target: { agentId, instanceId } }); setError(e instanceof Error ? e.message : "平台核对失败，请稍后重试。"); } }
    finally { if (check.current === controller) { check.current = undefined; setChecking(false); } }
  }

  /** 挂载时读取状态；卸载时停止定期轮询。 */
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const clock=setInterval(()=>setNow(Date.now()),1000);
    const interval = setInterval(() => void refresh(), active ? 5000 : 15000);
    /** 素材发布后刷新列表，不自动选择或替换当前直播内容。 */
    const mediaUpdated = () => { void refresh(); };
    window.addEventListener("livepilot-media-updated", mediaUpdated);
    return () => { clearTimeout(first); clearInterval(interval); clearInterval(clock); window.removeEventListener("livepilot-media-updated", mediaUpdated); };
  }, [refresh, active]);

  /** 修改当前实例草稿，在 OAuth 页面往返后仍可恢复选择。 */
  function select(next: Partial<Selection>) {
    const updated = { ...selection, ...next };
    setSelection(updated);
    try { sessionStorage.setItem("livepilot-selection-" + id, JSON.stringify(updated)); } catch { /* 草稿存储不是开播前提。 */ }
  }
  /** 提交显式实例命令；网络错误不自动重放，避免重复创建直播。 */
  async function act(action: string) {
    if (acting.current) return;
    // 写操作使旧读取失效；停止不等待只读核对，真正的写操作继续互斥。
    generation.current++; fetching.current?.abort(); fetching.current = undefined; check.current?.abort(); check.current = undefined; setChecking(false);
    acting.current = true; setWorking(action); setError(""); setProblem(undefined);
    const payload = { instanceId, ...(agentId ? { agentId } : {}), ...(action === "connect" ? {} : action === "start" ? { action, ...selection } : action === "clear-uncertain" ? { action, confirmed } : { action }) };
    const key = "livepilot-request-" + id;
    let requestId = crypto.randomUUID();
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (saved?.payload === JSON.stringify(payload)) requestId = saved.requestId;
      if (action !== "connect") sessionStorage.setItem(key, JSON.stringify({ payload: JSON.stringify(payload), requestId }));
    } catch { /* 浏览器禁用存储时仍使用本次唯一标识。 */ }
    try {
      const result = await api<{ url?: string }>(action === "connect" ? "/api/youtube/connect" : "/api/control", {
        method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" },
        body: JSON.stringify({ ...payload, ...(action === "connect" ? {} : { requestId }) }),
      });
      try { sessionStorage.removeItem(key); } catch { /* 受理结果已确认。 */ }
      if (result.url) { window.location.assign(result.url); return; }
      if (action === "clear-uncertain") setConfirmed(false);
    } catch (e) {
      failedRequest.current = requestId; setProblem({...requestProblem(e),target:{agentId,instanceId},attemptId:requestId});
      const status = (e as { status?: number }).status;
      if (status && status < 500) { try { sessionStorage.removeItem(key); } catch { /* 明确拒绝的请求不保留。 */ } }
      setError(e instanceof Error ? e.message : "请求中断，结果待确认，请核对状态后重试");
    }
    finally { acting.current = false; setWorking(""); await refresh(); }
  }
  const busy = !!working || !!data?.busy;
  const live = !stale && !!data && freshYouTubeEvidence(data.youtube) && data.youtube.lifecycle === "live" && data.obs.streaming === true && data.youtube.ingest === "active";
  const pending = !!data && hasPendingBroadcast(data.state);
  const locked = busy || live || pending;
  const uncertain = problem?.outcome === "unknown" && !!problem.attemptId;
  const blocker = uncertain ? "上次操作结果尚未确认，请先查询原任务。" : data?.operation && data.operation.status === "uncertain" ? "原任务状态尚未确认，请先查询。" : startBlocker(data, selection, busy, stale, live);
  return { problem: stale ? makeProblem("CLOUD_UNAVAILABLE",readError || "实例状态已过期，实际推流状态未知。",{target:{agentId,instanceId},stage:"读取实例状态"}) : problem || (data?.operation && ["failed","interrupted","uncertain","expired"].includes(data.operation.status) ? data.operation.problem : undefined), data, durationMs, selection, select, working, checking, error: stale ? readError : error || (data?.operation && ["failed", "interrupted", "expired", "uncertain"].includes(data.operation.status) ? data.operation.message || "操作需要核对" : ""), stale, confirmed, setConfirmed, refresh, checkPlatform, act, busy, live, pending, locked, blocker };
}
