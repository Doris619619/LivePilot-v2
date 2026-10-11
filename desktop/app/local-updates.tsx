/** 登录前后共享本机更新状态；独立 IPC 不读取客户设备与配置。 */
"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { DesktopAction, LocalUpdateState, UpdateCommand } from "../../src/shared/desktop";
import UpdateNotice from "./update-notice";
type Updates = { state?: LocalUpdateState; pending: boolean; error: string; act(action: DesktopAction): Promise<boolean> };
const Context = createContext<Updates>({ pending: false, error: "", act: async () => false });
/** 轮询与操作有独立序号，旧响应不得覆盖点击后的结果；重复点击只发送一次。 */
export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LocalUpdateState>(); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [readError, setReadError] = useState("");
  const running = useRef(false); const revision = useRef(0);
  useEffect(() => {
    let disposed = false; let reading = false;
    /** 更新读取失败明确标记，登录失败不会阻止后续重新读取。 */
    async function load() {
      if (reading || !window.liveNest?.updateState) return; reading = true; const current = revision.current;
      try { const next = await window.liveNest.updateState(); if (!disposed && current === revision.current) { setState(next); setReadError(""); } }
      catch { if (!disposed && current === revision.current) setReadError("本机更新状态读取失败，请重试；无需重新配对设备。"); }
      finally { reading = false; }
    }
    void load(); const timer = setInterval(() => void load(), 1000); return () => { disposed = true; clearInterval(timer); };
  }, []);
  /** 失败保留原安装阶段；取消不是成功，也不构造故障提示。 */
  async function act(action: DesktopAction) {
    if (running.current || !["update-check", "update-download", "update-install", "update-apply"].includes(action)) return false;
    running.current = true; revision.current++; setPending(true); setError("");
    try {
      if (!window.liveNest?.update) throw new Error("bridge unavailable");
      const result = await window.liveNest.update(action as UpdateCommand); revision.current++; setState(result.state); setReadError("");
      if (!result.ok && result.problem?.message !== result.state.update.message) setError(result.problem?.message || "更新未完成，请核对本机状态后重试。");
      return result.ok && !result.cancelled;
    } catch { setError("本机更新结果尚未确认，请查看当前更新状态；不要重复启动安装程序。"); return false; }
    finally { running.current = false; setPending(false); }
  }
  return <Context.Provider value={{ state, pending, error: error || readError, act }}>{children}</Context.Provider>;
}
/** 同一状态用于登录页、标题栏和设置，避免各自缓存不同安装结果。 */
export function useLocalUpdates() { return useContext(Context); }
/** 登录过期、配对撤销或云端离线时仍能检查、下载和安全安装。 */
export function LoginUpdate() {
  const local = useLocalUpdates();
  return <div className="login-update"><UpdateNotice version={local.state?.version} error={local.error} update={local.state?.update || { status: "idle" }} busy={local.pending || !local.state || !!local.state.busy} act={local.act} /></div>;
}
