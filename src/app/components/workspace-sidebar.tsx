/** 网页和客户端共用侧栏；窄屏使用有焦点管理的 Sheet，配对表单始终只有一个实例。 */
"use client";
import { useEffect, useState, type ReactNode } from "react";
import { SurfaceDialog } from "./ui/primitives";
/** 匹配布局断点后移动导航内容，不复制带状态的配对表单。 */
export default function WorkspaceSidebar({ children, label, className = "" }: { children: ReactNode; label: string; className?: string }) {
  const [mobile, setMobile] = useState(false); const [open, setOpen] = useState(false);
  useEffect(() => { const query = matchMedia("(max-width: 760px)"); const sync = () => { setMobile(query.matches); if (!query.matches) setOpen(false); }; sync(); query.addEventListener("change", sync); return () => query.removeEventListener("change", sync); }, []);
  const content = <div className={"workspace-sidebar-content " + className}>{children}<div className="sidebar-footnote"><span className="sidebar-footnote-mark" />LiveNest Studio</div></div>;
  if (mobile) return <div className="workspace-mobile-navigation"><SurfaceDialog open={open} onOpenChange={setOpen} title={label} description="选择工作区或定位设备" side="left" trigger={<button className="sidebar-mobile-trigger" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>导航</button>}><div onClick={event => { if ((event.target as HTMLElement).closest(".sidebar-link")) setOpen(false); }}>{content}</div></SurfaceDialog></div>;
  return <aside className="workspace-sidebar" aria-label={label}>{content}</aside>;
}
