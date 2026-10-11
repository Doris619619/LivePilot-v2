/** 批次删除为常驻操作；设备确认停止未公开内容后移出总览，文件和历史保留。 */
"use client";
import { useId, useState } from "react";
import type { PublishingBatchRemoval } from "@/shared/publishing";
import styles from "./batch-removal.module.css";
import { SurfaceDialog } from "../components/ui/primitives";

export type BatchRemovalOperation = (batchId: string) => Promise<boolean | string>;

/** 受控对话框管理焦点和 Escape；失败保留确认框，Cloud 受理不冒充已取消。 */
export default function BatchRemoval({ batchId, name, removal, busy, remove }: { batchId: string; name: string; removal?: PublishingBatchRemoval; busy: boolean; remove: BatchRemovalOperation }) {
  const [open, setOpen] = useState(false); const descriptionId = useId();
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
  const pending = !!removal && !removal.completedAt;
  /** 只有受理成功才关闭确认框；失败原因留在当前框内供用户重试。 */
  async function confirm() {
    if (busy || submitting) return; setSubmitting(true); setError("");
    try { const result = await remove(batchId); if (result === true) setOpen(false); else setError(typeof result === "string" ? result : "删除未提交，请重试。"); }
    catch { setError("删除未提交，请重试。"); }
    finally { setSubmitting(false); }
  }
  if (removal?.completedAt) return null;
  return <>
    <button type="button" className={"btn-danger " + styles.trigger} disabled={busy || pending} aria-label={(pending ? "删除待确认：" : "删除批次：") + name} onClick={() => { setError(""); setOpen(true); }}>{pending ? "删除待确认" : "删除批次"}</button>
    <SurfaceDialog open={open} onOpenChange={setOpen} title="删除批次" description={name} locked={submitting}>
      <p id={descriptionId}>停止未公开的视频，确认后移出总览。已公开视频、电脑素材和历史记录保留。</p>
      <p className={styles.warning}>设备离线时，已排期的视频仍可能公开。</p>
      {error && <p className="publishing-validation" role="alert">{error}</p>}
      <div className={styles.actions}><button type="button" disabled={submitting} onClick={() => setOpen(false)}>保留批次</button><button type="button" className="btn-danger" disabled={busy || submitting} onClick={() => void confirm()}>{submitting ? "正在提交…" : "确认删除"}</button></div>
    </SurfaceDialog>
  </>;
}
