/** 文件用途：集中展示网页直播状态，以内嵌复制的观看链接和分级控制操作减少按钮堆叠。 */
"use client";
import { useState, type ReactNode } from "react";
import type { Dashboard } from "@/shared/types";
import { youtubeLifecycleLabel } from "@/shared/readiness";
import { StatusBadge } from "./status-indicator";
import { CheckCircleIcon, ExternalLinkIcon, VideoIcon } from "./icons";
import { broadcastWatchUrl, runtimeDuration, type RuntimeSummary } from "./broadcast-runtime-model";
import panelStyles from "./broadcast-workflow-panel.module.css";
import styles from "./broadcast-runtime.module.css";

/** 只展示父级已核实的状态；所有开停播操作仍由原实例控制器执行。 */
export default function BroadcastRuntime({ id, data, stale, durationMs, summary, readiness, controls }: { id: string; data?: Dashboard; stale: boolean; durationMs: number | null; summary: RuntimeSummary; readiness?: string; controls: ReactNode }) {
  const url = broadcastWatchUrl(data?.state.broadcastId);
  const [copyResult, setCopyResult] = useState<"" | "copied" | "failed">("");
  /** 仅复制当前观看链接；成功原位反馈，失败保留可选择的文本，不移动其他操作。 */
  async function copyLink() {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopyResult("copied"); }
    catch { setCopyResult("failed"); }
  }
  const obs = stale || data?.obs.streaming == null ? "未知" : data.obs.reconnecting ? "重连中" : data.obs.streaming ? "推流中" : "未推流";
  return <div className={`broadcast-runtime ${styles.root}`}><div className={styles.columns}>
    <section className={panelStyles.root} aria-labelledby={`step-4-${id}`}>
    <h3 id={`step-4-${id}`} tabIndex={-1} className={panelStyles.heading}><VideoIcon width="18" height="18" aria-hidden="true" />本场运行状态</h3>
    <div className={panelStyles.body}>
      <div className={styles.summary} role="status"><StatusBadge status={summary.status} label={summary.label} />{summary.message && <p>{summary.message}</p>}</div>
      <dl className={styles.signals}>
        <div><dt>OBS 推流</dt><dd>{obs}</dd></div>
        <div><dt>YouTube 场次</dt><dd>{stale ? "未知" : data?.state.platformClosePending ? "待确认结束" : youtubeLifecycleLabel(data?.youtube.lifecycle)}</dd></div>
      </dl>
      {readiness && <p className={styles.readiness}>{readiness}</p>}
    </div>
    </section>
    <section className={panelStyles.root} aria-labelledby={`runtime-actions-${id}`}>
      <h3 id={`runtime-actions-${id}`} className={panelStyles.heading}>操作与链接</h3>
      <div className={panelStyles.body}>
        <dl className={styles.clock}><dt>OBS 推流时长</dt><dd>{runtimeDuration(data, stale, durationMs)}</dd></dl>
        <div className={styles.linkArea}>
          <div className={styles.linkHeading}>
            <label htmlFor={`watch-link-${id}`}>本场直播链接</label>
            {url && <a className={styles.watchLink} href={url} target="_blank" rel="noopener noreferrer">打开直播页<ExternalLinkIcon width="16" height="16" aria-hidden="true" /></a>}
          </div>
          <div className={styles.linkField}>
            <input id={`watch-link-${id}`} aria-label="本场直播链接" value={url || ""} placeholder="开播后显示" readOnly disabled={!url} />
            {url && <button type="button" className={styles.copyButton} aria-label="复制链接" title={copyResult === "copied" ? "已复制" : "复制链接"} onClick={() => void copyLink()}>
              {copyResult === "copied" ? <CheckCircleIcon width="18" height="18" aria-hidden="true" /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>}
            </button>}
          </div>
          <span className="visually-hidden" role="status">{copyResult === "copied" ? "链接已复制" : ""}</span>
          {copyResult === "failed" && <p className={styles.copyError} role="alert">复制失败，请选择链接手动复制。</p>}
        </div>
        <div className={styles.actions}>{controls}</div>
      </div>
    </section>
  </div></div>;
}
