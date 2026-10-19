/** 文件用途：显示 OBS 检查阶段与倒计时，异常就地提示，常规观测留在详情。 */
import type { DesktopActivity } from "../../src/shared/desktop";
import { CheckCircleIcon } from "../../src/app/components/icons";
import { obsCheckProgressView } from "./obs-startup-state";
import styles from "./obs-startup.module.css";

/** 阶段在左、计时在右，空间不足时换行；倒计时只表示宿主剩余预算。 */
export default function ObsCheckProgress({ activity, now, readFresh }: { activity: DesktopActivity; now: number; readFresh: boolean }) {
  const view = obsCheckProgressView(activity, now, readFresh);
  const labels = activity.action === "launch-obs" ? ["启动 OBS", "连接控制服务", "确认 OBS 状态"] : ["检查进程与端口", "连接控制服务", "读取 OBS 状态"];
  return <section className={styles.progress} data-obs-check-progress aria-label="OBS 检查过程">
    <ol className={styles.steps} aria-label={activity.action === "launch-obs" ? "OBS 启动阶段" : "OBS 复查阶段"}>{labels.map((label, index) => <li key={label} aria-current={index === view.phaseIndex ? "step" : undefined}>
      {index < view.phaseIndex ? <CheckCircleIcon aria-hidden="true" /> : <span className={styles.pending} aria-hidden="true" />}<span>{label}{index < view.phaseIndex ? " · 已确认" : ""}</span>
    </li>)}</ol>
    <div className={styles.progressTiming} aria-live="off"><span data-obs-check-elapsed>已用 {view.elapsed} 秒</span><strong data-obs-remaining data-obs-check-remaining>{view.remaining === undefined ? "正在获取检查时限…" : "剩余检查时间 " + view.remaining + " 秒"}</strong></div>
    {view.unknown && <p className={styles.observation} role="status" aria-live="polite">{view.overdue ? "本轮已达到检查时限，正在核对最终结果。请重新读取状态，避免重复启动。" : "暂时无法确认检查是否仍在进行。可重新读取状态，或查看连接帮助。"}</p>}
  </section>;
}
