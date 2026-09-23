/** 标题栏更新浮层与设置页共用动作规则，始终由用户发起下载和重启。 */
import type { DesktopAction, DesktopState } from "../../src/shared/desktop";
export type UpdateActionProps = { update: DesktopState["update"]; busy: boolean; act: (action: DesktopAction, input?: Record<string, unknown>) => Promise<boolean> };
export default function UpdateAction({ update, busy, act }: UpdateActionProps) {
  const updating = ["checking", "downloading", "installing"].includes(update.status);
  const downloadRetry=update.status==="error"&&update.stage==="download"&&update.problem?.code!=="UPDATE_INTEGRITY";
  const action: DesktopAction = update.status === "available" || downloadRetry ? "update-download" : update.status === "downloaded" ? "update-install" : "update-check";
  const label = downloadRetry ? "重新下载" : update.status === "available" ? "下载更新" : update.status === "downloaded" ? "重启更新" : update.status === "checking" ? "正在检查…" : update.status === "installing" ? "正在安装…" : update.status === "downloading" ? "正在下载 " + Math.round(update.percent || 0) + "%" : "检查更新";
  return <button className={action !== "update-check" ? "btn-primary" : ""} disabled={busy || updating} onClick={() => void act(action)}>{label}</button>;
}
