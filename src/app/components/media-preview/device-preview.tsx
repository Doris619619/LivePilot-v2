/** 已配置素材的只读预览：绑定设备/账号/版本，关闭即撤销会话，不重复填写发布字段。 */
"use client";
import { useEffect, useState } from "react";
import type { PreviewSelection, PreviewState, PreviewPart } from "@/shared/media-preview";
import { MediaPreviewPanel, type MediaPreviewProps } from "./media-preview";
import styles from "./preview.module.css";
import { api } from "../../client-request";
export type RemotePreview = PreviewState & { url(part: PreviewPart): string | undefined; action(value: "check" | "prepare" | "cancel"): void };
/** 只调用专用预览端点，接口失败保留安全提示，不转为本地示例。 */
async function request(body: unknown, signal?: AbortSignal) {
  return api<PreviewState & { id: string }>("/api/media-preview", { method: "POST", headers: { "Content-Type": "application/json", "X-LivePilot": "1" }, body: JSON.stringify(body), signal, timeoutMs: 30_000, keepalive: !signal });
}
/** 定期验证会话；改变选择或离开面板时卸载播放器、取消检查并撤销 URL。 */
export default function DevicePreview({ selection, ...props }: Omit<MediaPreviewProps, "selection" | "remote"> & { selection: PreviewSelection }) {
  const key = JSON.stringify(selection); const [retry, setRetry] = useState(0);
  const [session, setSession] = useState<PreviewState & { id: string; key: string }>(); const [error, setError] = useState(""); const [working, setWorking] = useState(false);
  useEffect(() => {
    let disposed = false; let id = ""; let timer: ReturnType<typeof setTimeout> | undefined; const abort = new AbortController();
    /** 设备检查按真实状态轮询，空闲也检查撤销/替换，避免残留播放器。 */
    async function refresh() {
      try { const value = await request(id ? { action: "status", id } : { action: "open", selection: JSON.parse(key) }, abort.signal); id = value.id;
        if (disposed) { void request({ action: "close", id }).catch(() => {}); return; }
        setError(""); setSession({ ...value, key }); timer = setTimeout(() => void refresh(), value.busy ? 800 : 5000);
      } catch (failure) { if (!disposed) { setError(failure instanceof Error ? failure.message : "预览连接失败。"); setSession(undefined); } }
    }
    void refresh();
    return () => { disposed = true; abort.abort(); clearTimeout(timer); if (id) void request({ action: "close", id }).catch(() => {}); };
  }, [key, retry]);
  /** 完整检查/合成须由用户主动发起，动作本身不触发上传或开播。 */
  async function action(value: "check" | "prepare" | "cancel") {
    if (!session || working) return; setWorking(true);
    try { const next = await request({ action: value, id: session.id }); setSession({ ...next, key }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败，请重试。"); }
    finally { setWorking(false); }
  }
  if (error) return <div className={styles.empty} role="alert"><strong>{error}</strong><button type="button" onClick={() => { setError(""); setSession(undefined); setRetry(retry + 1); }}>重新读取</button></div>;
  if (!session || session.key !== key) return <div className={styles.empty} role="status">正在读取设备素材…</div>;
  return <MediaPreviewPanel {...props} remote={{ ...session, busy: session.busy || working, url: part => session.files[part] ? `/api/media-preview?id=${encodeURIComponent(session.id)}&part=${part}` : undefined, action: value => void action(value) }} />;
}
