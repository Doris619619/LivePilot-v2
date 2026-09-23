/** 为一个 OBS 面板管理状态轮询、媒体草稿及命令；各面板互不阻塞。 */
"use client";
import { makeProblem, type Problem } from "../shared/problems";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dashboard, Selection, InstanceDescriptor } from "@/shared/types";
import { targetKey } from "@/shared/remote";
import { api, requestProblem } from "./client-request";
import { useStreamClock } from "./use-stream-clock";
import { startBlocker } from "@/shared/readiness";

/** 仅保存媒体名称及原声选项，不保存路径或授权信息。 */
function readDraft(id: string): Selection | undefined {
  try {
    const draft = JSON.parse(sessionStorage.getItem("livepilot-selection-" + id) || "null");
    if (draft && typeof draft.video === "string" && typeof draft.music === "string" && typeof draft.videoAudio === "boolean") return draft;
  } catch { /* 浏览器禁用存储时仍可使用面板。 */ }
}

/** 每个调用绑定一个稳定实例 ID；请求和草稿永远携带该 ID。 */
export function useInstance(instance: InstanceDescriptor) {
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
  const fetching = useRef(false);
  const acting = useRef(false);
  /** 只读取所属实例；失败时保留旧值但标记过期，禁止基于旧值控制。 */
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const result = await api<Dashboard>("/api/status?instanceId=" + encodeURIComponent(instanceId) + (agentId ? "&agentId=" + encodeURIComponent(agentId) : ""), { signal: AbortSignal.timeout(60_000) });
      setReadAt(Date.now()); synchronize(result);
      if (result.operation?.id === failedRequest.current && result.operation?.status === "succeeded") { setError(""); setProblem(undefined); failedRequest.current = undefined; }
      setData(result); setStale(!!result.device && !result.device.online); setReadError(result.device && !result.device.online ? result.obs.message || "设备状态不可用" : "");
      // 状态读取确认过受理记录后解除“响应丢失”标记，后续显式恢复使用新请求。
      try {
        const key = "livepilot-request-" + id;
        const saved = JSON.parse(sessionStorage.getItem(key) || "null");
        if (saved?.requestId === result.operation?.id) sessionStorage.removeItem(key);
      } catch { /* 禁用浏览器存储不影响真实状态显示。 */ }
      if (result.state.selection && !["idle", "stopped"].includes(result.state.phase)) {
        const actual = result.state.selection;
        setSelection(previous => JSON.stringify(previous) === JSON.stringify(actual) ? previous : actual);
      }
      if (!initialized.current) {
        initialized.current = true;
        const active = result.state.phase !== "stopped" && result.state.phase !== "idle";
        const saved = (active ? result.state.selection : readDraft(id)) || result.state.selection;
        setSelection(saved || { video: result.media.videos.length === 1 ? result.media.videos[0] : "", music: result.media.music.length === 1 ? result.media.music[0] : "", videoAudio: false });
      }
    } catch (e) { clearClock(); setStale(true); setReadError(e instanceof Error ? e.message : "读取失败，请检查本机服务"); }
    finally { fetching.current = false; }
  }, [id, instanceId, agentId, synchronize, clearClock]);

  /** 挂载时读取状态；卸载时停止定期轮询。 */
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const clock=setInterval(()=>setNow(Date.now()),1000);
    const interval = setInterval(() => void refresh(), 5000);
    /** 素材发布后刷新列表，不自动选择或替换当前直播内容。 */
    const mediaUpdated = () => { void refresh(); };
    window.addEventListener("livepilot-media-updated", mediaUpdated);
    return () => { clearTimeout(first); clearInterval(interval); clearInterval(clock); window.removeEventListener("livepilot-media-updated", mediaUpdated); };
  }, [refresh]);

  /** 修改当前实例草稿，在 OAuth 页面往返后仍可恢复选择。 */
  function select(next: Partial<Selection>) {
    const updated = { ...selection, ...next };
    setSelection(updated);
    try { sessionStorage.setItem("livepilot-selection-" + id, JSON.stringify(updated)); } catch { /* 草稿存储不是开播前提。 */ }
  }
  /** 提交显式实例命令；网络错误不自动重放，避免重复创建直播。 */
  async function act(action: string) {
    if (acting.current) return;
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
  const live = !stale && data?.youtube.lifecycle === "live" && data.obs.streaming === true && data.youtube.ingest === "active";
  const pending = !!data?.state.broadcastTitle && data.state.phase !== "stopped";
  const locked = busy || live || pending;
  const blocker = startBlocker(data, selection, busy, stale, live);
  return { problem: stale ? makeProblem("CLOUD_UNAVAILABLE",readError || "实例状态已过期，实际推流状态未知。",{target:{agentId,instanceId},stage:"读取实例状态"}) : problem || (data?.operation && ["failed","interrupted","uncertain","expired"].includes(data.operation.status) ? data.operation.problem : undefined), data, durationMs, selection, select, working, error: stale ? readError : error || (data?.operation && ["failed", "interrupted", "expired", "uncertain"].includes(data.operation.status) ? data.operation.message || "操作需要核对" : ""), stale, confirmed, setConfirmed, refresh, act, busy, live, pending, locked, blocker };
}
