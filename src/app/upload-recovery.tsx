/** 显示服务器保留的上传记录，响应丢失、刷新或换浏览器后仍可查询和取消。 */
"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./client-request";
import { uploadUrl } from "./upload-client";
import type { UploadStatus } from "@/shared/uploads";
type Recovery = Pick<UploadStatus, "id" | "instanceId" | "agentId" | "filename"> & { message: string };
/** 查询与取消严格等待服务器回报；失败不从界面抹去待确认记录。 */
export default function UploadRecovery({ agentId, instanceId, restore }: { agentId?: string; instanceId: string; restore: (status: UploadStatus) => void }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [items, setItems] = useState<Recovery[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const url = "/api/uploads?agentId=" + encodeURIComponent(agentId || "") + "&instanceId=" + encodeURIComponent(instanceId);
  useEffect(() => { let active = true; if (agentId) void api<Recovery[]>(url).then(value => { if (active) setItems(value); }, () => { if (active) setError("上传恢复列表暂不可用，请刷新重试。"); }); return () => { active = false; }; }, [agentId, url]);
  /** 只接纳当前目标的服务端结果，错误保留记录供后续对账。 */
  async function act(item?: Recovery, cancel = false) {
    if (busy) return; setBusy(true); setError("");
    try {
      if (item) {
        if (cancel) await api(uploadUrl(item), { method: "DELETE", headers: { "x-livepilot": "1" } });
        else { const status = await api<UploadStatus>(uploadUrl(item)); if (mounted.current) restore(status); }
      }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { try { const items = await api<Recovery[]>(url); if (mounted.current) setItems(items); } catch { if (mounted.current) setError("结果仍待确认，请重新查询。"); } if (mounted.current) setBusy(false); }
  }
  if (!agentId) return null;
  return <div className="upload-recovery"><button type="button" className="btn-secondary" disabled={busy} onClick={() => void act()}>查询未结束的上传</button>{items.map(item => <div key={item.id}><strong>{item.filename}</strong><p>{item.message}</p><button type="button" disabled={busy} onClick={() => void act(item)}>查询／恢复</button><button type="button" disabled={busy} onClick={() => void act(item, true)}>取消上传</button></div>)}{error && <p role="alert">{error}</p>}</div>;
}
