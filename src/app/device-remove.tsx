/** 设备移除的弹窗确认与失败重试，不把网络异常当作已移除。 */
"use client";
import { useRef, useState, type ReactNode } from "react";
import { api } from "./client-request";
import { SurfaceDialog } from "./components/ui/primitives";
import type { AgentDescriptor } from "@/shared/remote";
/** 成功后刷新设备清单；移除不代表 OBS 或直播已停止。 */
export default function DeviceRemove({ agent, changed, children }: { agent: AgentDescriptor; changed: () => void; children: ReactNode }) {
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const pending = useRef(false);
  /** 同一设备只允许一次在途移除，明确结果后才关闭确认。 */
  async function remove() {
    if (pending.current) return; pending.current = true; setBusy(true); setError("");
    try { await api("/api/devices", { method: "DELETE", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify({ agentId: agent.id, confirmed: true }) }); setConfirm(false); changed(); }
    catch (e) { setError((e as Error).message); } finally { pending.current = false; setBusy(false); }
  }
  return <><div className="device-header">{children}<button className="btn-ghost" disabled={busy} onClick={() => setConfirm(true)}>移除电脑</button></div><SurfaceDialog open={confirm} onOpenChange={setConfirm} title="移除直播电脑" description={agent.name} locked={busy}><div className="device-remove-confirm" role="group" aria-label={"移除 " + agent.name}><p>确认从工作台移除「{agent.name}」？网页将无法控制它。移除不会停止 OBS 或直播，请先在本机核对直播状态。</p><p>移除后，频道可连接到其他电脑。本机 OBS、素材和授权文件保留；原电脑以后也可用新配对码重新连接。</p><div className="device-remove-actions"><button disabled={busy} onClick={() => void remove()}>{busy ? "正在移除…" : "确认移除"}</button><button disabled={busy} onClick={() => { setConfirm(false); setError(""); }}>取消</button></div>{error && <p role="alert">{error}</p>}</div></SurfaceDialog></>;
}
