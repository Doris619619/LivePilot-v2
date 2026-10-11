/** 标题栏复用 Radix 浮层，自动避让窗口边缘并恢复键盘焦点。 */
import { Popover, PopoverContent, PopoverTrigger } from "../../src/app/components/ui/primitives";
import { RefreshIcon } from "../../src/app/components/icons";
import UpdateAction, { type UpdateActionProps } from "./update-action";
import UpdateNotice from "./update-notice";
/** 新版入口保持单次点击更新；仅进度或失败详情展开浮层。 */
export default function UpdateEntry(props: UpdateActionProps & { error?: string }) {
  if (["available", "downloaded"].includes(props.update.status)) return <UpdateAction {...props} />;
  if ((!props.update.version && !(props.update.status === "error" && !props.update.automatic)) || !["checking", "downloading", "preparing", "installing", "error"].includes(props.update.status)) return null;
  const label = props.update.status === "error" ? "更新需要处理" : props.update.status === "downloading" ? "下载中" : "更新中";
  return <Popover><PopoverTrigger asChild><button className="desktop-update-entry" aria-label={"软件更新：" + label}><RefreshIcon />{label}</button></PopoverTrigger><PopoverContent className="update-entry-popover" aria-label="软件更新详情"><UpdateNotice {...props} /></PopoverContent></Popover>;
}
