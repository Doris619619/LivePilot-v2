/** 对照 Threadline：标题栏仅在发现版本后显示小入口，点击才展开详情。 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshIcon } from "../../src/app/components/icons";
import UpdateAction, { type UpdateActionProps } from "./update-action";
type Props = UpdateActionProps & { error?: string };
/** 无新版或仅后台检查失败时不打扰；版本切换重新挂载，避免自动弹出详情。 */
export default function UpdateEntry(props: Props) {
  if ((!props.update.version && !(props.update.status==="error"&&!props.update.automatic)) || !["available", "checking", "downloading", "downloaded", "installing", "error"].includes(props.update.status)) return null;
  return <UpdateNotice key={props.update.version} {...props} />;
}
/** 外部点击、Escape、调整窗口收起详情；下载完成只更新入口文字。 */
function UpdateNotice({ update, busy, act, error }: Props) {
  const [position, setPosition] = useState<{ top: number; right: number }>();
  const trigger = useRef<HTMLButtonElement>(null); const panel = useRef<HTMLDivElement>(null); const id = useId();
  useEffect(() => {
    if (!position) return;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    /** 仅关闭 UI，不中止下载或触发安装。 */
    const dismiss = () => setPosition(undefined);
    /** 内部按钮与入口点击交给自身处理，其他位置收起详情。 */
    const pointer = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) dismiss(); };
    /** Escape 将焦点交回入口。 */
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { dismiss(); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", key); window.addEventListener("resize", dismiss);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); window.removeEventListener("resize", dismiss); };
  }, [position]);
  const label = update.status === "error" ? "更新需要处理" : update.status === "downloaded" ? "重启更新" : update.status === "downloading" ? "下载中" : update.status === "installing" ? "更新中" : "更新";
  return <><button ref={trigger} className="desktop-update-entry" aria-label={"软件更新：" + label} title={update.version ? "新版本 " + update.version : "检查更新未完成"} aria-expanded={!!position} aria-controls={position ? id : undefined} onClick={() => { const rect = trigger.current!.getBoundingClientRect(); setPosition(position ? undefined : { top: rect.bottom + 8, right: Math.max(12, Math.min(window.innerWidth - 292, window.innerWidth - rect.right)) }); }}><RefreshIcon />{label}</button>
    {position && createPortal(<div id={id} ref={panel} className="desktop-update-panel" role="region" aria-label="软件更新详情" style={position}><div className="desktop-update-heading"><strong>LiveNest {update.version}</strong><button className="btn-ghost" aria-label="关闭更新详情" onClick={() => { setPosition(undefined); trigger.current?.focus(); }}>×</button></div><p role="status">{update.message || "发现新版本"}</p>{error && <p role="alert" className="check-message">{error}</p>}{update.status === "downloading" && <progress aria-label="更新下载进度" max={100} value={update.percent || 0} />}<UpdateAction update={update} busy={busy} act={act} /></div>, document.body)}
  </>;
}
