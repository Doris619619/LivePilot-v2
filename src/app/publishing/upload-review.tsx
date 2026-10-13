/** 在素材检查和最终确认附近给出已有记录及可操作的恢复入口，避免全局错误冒充视频状态。 */
"use client";
import type { UploadBlock, UploadRepeat } from "./publishing-upload-review";

/** 已完成记录不阻挡设置；尚未核对的旧任务仍提示恢复，排除项不出现。 */
export default function UploadReview({ blockers, repeats = [], busy, history, change }: { blockers: UploadBlock[]; repeats?: UploadRepeat[]; busy: boolean; history(): void; change?(): void }) {
  if (!blockers.length && !repeats.length) return null;
  const published = repeats.every(value => value.label === "已发布");
  const entries = [...blockers, ...repeats];
  return <section className={(blockers.length ? "publishing-warning" : "publishing-message") + " publishing-upload-review"} aria-label="已有发布记录">
    {blockers.length > 0 && <p>{blockers.length} 个素材已有任务，请先核对或勾选“暂不发布”。</p>}
    {repeats.length > 0 && <p>{repeats.length} 条视频{published ? "已发布" : "已完成"}，可再次发布。</p>}
    <details><summary>查看 {entries.length} 个素材</summary><ul>{entries.map(value => <li key={value.packageId}><strong>{value.name}</strong><span>{value.label}</span>{value.videoId && <a href={"https://www.youtube.com/watch?v=" + value.videoId} target="_blank" rel="noreferrer">查看视频</a>}</li>)}</ul></details>
    <div className="publishing-actions"><button type="button" disabled={busy} onClick={history}>查看发布记录</button>{change && <button type="button" disabled={busy} onClick={change}>更换素材</button>}</div>
  </section>;
}
