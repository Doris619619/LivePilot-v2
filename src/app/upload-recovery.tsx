/** 显示服务器保留的上传记录，响应丢失、刷新或换浏览器后仍可查询和取消。 */
"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./client-request";
import { uploadUrl } from "./upload-client";
import type { UploadStatus } from "@/shared/uploads";
type Recovery = Pick<UploadStatus, "id" | "instanceId" | "agentId" | "filename"> & { message: string };
export type UploadOperation = { current: () => boolean; release: () => void };
/** 查询与取消严格等待服务器回报；失败不从界面抹去待确认记录。 */
export default function UploadRecovery({ agentId, instanceId, destinationLabel, restore, cancelled, acquire, currentId, disabled = false }: { agentId?: string; instanceId: string; destinationLabel?: string; restore: (status: UploadStatus) => void; cancelled: (id: string) => void; acquire: () => UploadOperation | undefined; currentId?: string; disabled?: boolean }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [items, setItems] = useState<Recovery[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const url = "/api/uploads?agentId=" + encodeURIComponent(agentId || "") + "&instanceId=" + encodeURIComponent(instanceId);
  useEffect(() => { let active = true; if (agentId) void api<Recovery[]>(url).then(value => { if (active) setItems(value); }, () => { if (active) setError("上传恢复列表暂不可用，请刷新重试。"); }); return () => { active = false; }; }, [agentId, url]);
  /** 只接纳当前目标的服务端结果，错误保留记录供后续对账。 */
  async function act(item?: Recovery, cancel = false) {
    if (cancel && item && !window.confirm(`取消“${item.filename}”的上传？\n目标：${destinationLabel || instanceId}\n已上传的临时数据将删除，本次上传无法继续。`)) return;
    if (busy || disabled) return; const operation = acquire(); if (!operation) return; setBusy(true); setError("");
    try {
      if (item) {
        if (cancel) { await api(uploadUrl(item), { method: "DELETE", headers: { "x-livepilot": "1" } }); if (mounted.current && operation.current()) cancelled(item.id); }
        else {
          const status = await api<UploadStatus>(uploadUrl(item));
          if (status.id !== item.id || status.instanceId !== instanceId || status.agentId !== agentId) throw new Error("上传记录与当前目标不一致，请重新查询原电脑。");
          if (mounted.current && operation.current()) restore(status);
        }
      }
    } catch (e) { if (mounted.current && operation.current()) setError((e as Error).message); }
    finally { try { if (operation.current()) { const items = await api<Recovery[]>(url); if (mounted.current && operation.current()) setItems(items); } } catch { if (mounted.current && operation.current()) setError(previous => previous ? previous + " 另：恢复列表暂未刷新，请稍后重新查询。" : "操作已返回，但恢复列表暂未刷新，请重新查询。"); } if (mounted.current) setBusy(false); operation.release(); }
  }
  if (!agentId) return null;
  const remaining = items.filter(item => item.id !== currentId);
  return <div className="upload-recovery"><details><summary>找回未完成的上传{remaining.length ? `（${remaining.length}）` : ""}</summary><div className="upload-recovery-content"><p className="upload-hint">上传中断或刷新页面后，可在这里查询并继续。</p><button type="button" className="btn-secondary" disabled={busy || disabled} onClick={() => void act()}>{busy ? "正在查询…" : "查询未结束的上传"}</button>{remaining.map(item => <div className="upload-recovery-item" key={item.id}><strong>{item.filename}</strong><p>{item.message}</p><div className="upload-actions"><button type="button" disabled={busy || disabled} onClick={() => void act(item)}>查询／恢复</button><button type="button" className="btn-ghost" disabled={busy || disabled} onClick={() => void act(item, true)}>取消上传</button></div></div>)}</div></details>{error && <p role="alert">{error}</p>}</div>;
}
