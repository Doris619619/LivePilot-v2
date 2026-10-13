/** 登录和设置共用紧凑更新提示，进度只来自本机更新器。 */
import { Popover, PopoverContent, PopoverTrigger, Progress } from "../../src/app/components/ui/primitives";
import { RefreshIcon } from "../../src/app/components/icons";
import UpdateAction, { type UpdateActionProps } from "./update-action";

/** 次要说明按需展开；失败原因保持可见，不以浮层隐藏恢复信息。 */
export default function UpdateNotice({ version, error, update, busy, act }: UpdateActionProps & { version?: string; error?: string }) {
  const titles: Record<string, string> = { idle: "软件更新", checking: "正在检查更新", available: "有新版本可用", downloading: "正在下载更新", downloaded: "更新已准备好", preparing: "正在准备重启", installing: "正在安装更新", error: "更新未完成" };
  const showMessage = !!error || update.status === "error" || !["available", "downloading"].includes(update.status);
  return <section className="update-notice" aria-label="软件更新">
    <div className="update-notice-heading"><RefreshIcon /><div><strong>{titles[update.status] || "软件更新"}</strong><p>{version ? `LiveNest ${version}` : "软件更新"}{update.version ? ` → ${update.version}` : ""}</p></div>
      <Popover><PopoverTrigger asChild><button className="btn-ghost" aria-label="更新说明">详情</button></PopoverTrigger><PopoverContent aria-label="更新说明"><strong>软件更新</strong><p>更新会关闭并重新打开 LiveNest。账号、频道授权、OBS 和素材保留。</p><p>正在直播或处理任务时，安装前会先检查是否可以安全退出。</p></PopoverContent></Popover>
    </div>
    {update.status === "downloading" && <Progress aria-label="更新下载进度" value={update.percent ?? null} />}
    {showMessage && (update.message || error) && <p className="update-notice-message" role={update.status === "error" || error ? "alert" : "status"}>{error || update.message}</p>}
    <UpdateAction update={update} busy={busy} act={act} subtle />
  </section>;
}
