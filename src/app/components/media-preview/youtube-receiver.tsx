/** 已有场次的官方播放器入口；展开才加载，不创建场次或测试推流。 */
"use client";
import { useState } from "react";
import styles from "./preview.module.css";
/** 私密场次提供官方入口；公开场次被禁止嵌入时同样可以转到官方页面。 */
export default function YouTubeReceiver({ id, privacy }: { id?: string; privacy?: string }) {
  const [open, setOpen] = useState(false);
  const valid = id && /^[A-Za-z0-9_-]{11}$/.test(id);
  return <details className={styles.previewHelp} onToggle={event => setOpen(event.currentTarget.open)}><summary>YouTube 接收画面</summary>
    {!valid ? <p>尚无可查看的 YouTube 场次。</p> : <>
      {open && privacy !== "private" && <iframe title="YouTube 当前场次" src={`https://www.youtube-nocookie.com/embed/${id}`} width="100%" style={{ aspectRatio: "16 / 9", border: 0 }} allow="fullscreen; encrypted-media" allowFullScreen />}
      <p>{privacy === "private" ? "私密场次请登录 YouTube 查看。" : "无法嵌入时，可前往 YouTube 查看；平台画面可能延迟。"}</p>
      <a href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noopener noreferrer">在 YouTube 观看</a>{" · "}<a href={`https://studio.youtube.com/video/${id}/livestreaming`} target="_blank" rel="noopener noreferrer">打开 Studio</a>
    </>}
  </details>;
}
