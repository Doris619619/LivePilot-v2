/** 调用记录仅展开安全标识和连接统计，禁止呈现上游请求、响应正文或任何凭据。 */
"use client";
import type { StoredYouTubeEvent } from "@/shared/youtube-usage";
import styles from "./youtube-usage.module.css";
/** 由独立详情行承载字段，不能把九项关联信息塞进单个表格单元格撑高主行。 */
export default function YouTubeEventDetails({ event }: { event: StoredYouTubeEvent }) {
  const values: [string, string | number | undefined][] = [["调用 ID", event.attemptId], ["关联操作 ID", event.operationId], ["发布任务 ID", event.jobId], ["发布账号 ID", event.accountId], ["连接接收批次", event.streamBatches], ["连接接收消息", event.streamMessages], ["耗时（ms）", event.durationMs], ["重试次数", event.retryCount], ["重试等待（ms）", event.retryDelayMs]];
  const present = values.filter(([, value]) => value !== undefined);
  return present.length ? <dl className={styles.eventDetails}>{present.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === "number" ? value.toLocaleString("zh-CN") : <code>{value}</code>}</dd></div>)}</dl> : <span className={styles.caption}>无关联信息</span>;
}
