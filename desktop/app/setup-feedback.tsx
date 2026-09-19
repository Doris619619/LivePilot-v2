/** 将真实阶段和可恢复的错误放在操作旁，避免长页面顶部提示被遗漏。 */
import type { DesktopActivity } from "../../src/shared/desktop";
export default function SetupFeedback({ activity, now, retry, help, disabled }: { activity: DesktopActivity; now: number; retry: () => void; help: () => void; disabled: boolean }) {
  if (activity.status === "complete") return null;
  const failed = activity.status === "failed";
  return <div className={"setup-feedback " + (failed ? "failed" : "")}>
    <div role={failed ? "alert" : "status"} aria-live={failed ? "assertive" : "polite"}>
      <p>{activity.stage}</p>
      {failed ? <p>{activity.message}</p> : <p className="setup-elapsed" aria-live="off">本次操作已用 {Math.max(0, Math.floor((now - activity.startedAt) / 1000))} 秒</p>}
    </div>
    {failed && <div className="desktop-actions"><button disabled={disabled} onClick={retry}>{activity.step === 2 ? "重新检查 OBS" : "重试"}</button><button className="btn-ghost" onClick={help}>{activity.step === 2 ? "查看 OBS 配置图解" : "查看帮助"}</button></div>}
  </div>;
}
