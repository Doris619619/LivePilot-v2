/** 在素材检查和最终确认附近给出已有记录及可操作的恢复入口，避免全局错误冒充视频状态。 */
"use client";
import type { UploadBlock } from "./publishing-upload-review";

/** 仅展示阻止本次上传的素材；排除项不出现，查看旧记录不会修改新草稿。 */
export default function UploadReview({ blockers, busy, history, change }: { blockers: UploadBlock[]; busy: boolean; history(): void; change?(): void }) {
  if (!blockers.length) return null;
  const allPublished = blockers.every(value => value.reason === "published");
  return <section className="publishing-warning publishing-upload-review" aria-label="已有发布记录">
    <p>{allPublished ? `${blockers.length} 条视频已在此频道公开，不能重复上传。` : `${blockers.length} 个素材已有任务，请先核对或勾选“暂不发布”。`}</p>
    <details><summary>查看 {blockers.length} 个素材</summary><ul>{blockers.map(value => <li key={value.packageId}><strong>{value.name}</strong><span>{value.label}</span>{value.videoId && <a href={"https://www.youtube.com/watch?v=" + value.videoId} target="_blank" rel="noreferrer">查看视频</a>}</li>)}</ul></details>
    <div className="publishing-actions"><button type="button" disabled={busy} onClick={history}>查看发布记录</button>{change && <button type="button" disabled={busy} onClick={change}>更换素材</button>}</div>
  </section>;
}
