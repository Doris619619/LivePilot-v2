/** 文件用途：在网页开播区集中呈现一个状态结论、信号明细、就近操作和可复制的本场观看链接。 */
"use client";
import { useState, type ReactNode } from "react";
import type { Dashboard } from "@/shared/types";
import { youtubeLifecycleLabel } from "@/shared/readiness";
import { StatusBadge } from "./status-indicator";
import { ExternalLinkIcon, VideoIcon } from "./icons";
import { broadcastWatchUrl, runtimeDuration, type RuntimeSummary } from "./broadcast-runtime-model";
import panelStyles from "./broadcast-workflow-panel.module.css";
import styles from "./broadcast-runtime.module.css";

/** 只展示父级已核实的状态；所有开停播操作仍由原实例控制器执行。 */
export default function BroadcastRuntime({ id, data, stale, durationMs, summary, readiness, controls }: { id: string; data?: Dashboard; stale: boolean; durationMs: number | null; summary: RuntimeSummary; readiness?: string; controls: ReactNode }) {
  const url = broadcastWatchUrl(data?.state.broadcastId);
  const [copyResult, setCopyResult] = useState("");
  /** 复制仅写入观众观看链接；失败时保留可手动选择的链接文本。 */
  async function copyLink() {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopyResult("已复制"); }
    catch { setCopyResult("复制失败，请选择链接手动复制"); }
  }
  const obs = stale || data?.obs.streaming == null ? "未知" : data.obs.reconnecting ? "重连中" : data.obs.streaming ? "推流中" : "未推流";
  return <div className={`broadcast-runtime ${styles.root}`}><div className={styles.columns}>
    <section className={panelStyles.root} aria-labelledby={`step-4-${id}`}>
    <h3 id={`step-4-${id}`} tabIndex={-1} className={panelStyles.heading}><VideoIcon width="18" height="18" aria-hidden="true" />本场运行状态</h3>
    <div className={panelStyles.body}>
      <div className={styles.summary} role="status"><StatusBadge status={summary.status} label={summary.label} />{summary.message && <p>{summary.message}</p>}</div>
      <dl className={styles.signals}>
        <div><dt>OBS 推流</dt><dd>{obs}</dd></div>
        <div><dt>YouTube 场次</dt><dd>{stale ? "未知" : youtubeLifecycleLabel(data?.youtube.lifecycle)}</dd></div>
      </dl>
      {readiness && <p className={styles.readiness}>{readiness}</p>}
    </div>
    </section>
    <section className={panelStyles.root} aria-labelledby={`runtime-actions-${id}`}>
      <h3 id={`runtime-actions-${id}`} className={panelStyles.heading}>操作与链接</h3>
      <div className={panelStyles.body}>
        <dl className={styles.clock}><dt>OBS 推流时长</dt><dd>{runtimeDuration(data, stale, durationMs)}</dd></dl>
        <div className={styles.linkArea}>
          <label htmlFor={`watch-link-${id}`}>本场直播链接</label>
          <input id={`watch-link-${id}`} aria-label="本场直播链接" value={url || ""} placeholder="开播后显示" readOnly disabled={!url} />
          {url && <><div className={styles.linkRow}><a className="btn-secondary" href={url} target="_blank" rel="noopener noreferrer">打开直播页<ExternalLinkIcon aria-hidden="true" /></a><button type="button" className="btn-secondary" onClick={() => void copyLink()}>复制链接</button></div><span className={styles.copyResult} role="status">{copyResult}</span></>}
        </div>
        <div className={styles.actions}>{controls}</div>
      </div>
    </section>
  </div></div>;
}
