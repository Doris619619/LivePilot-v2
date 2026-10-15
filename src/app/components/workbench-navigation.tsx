/** 模块次级导航投递到常驻侧栏；与纯生命周期 Context 分离，避免共享控件循环依赖。 */
"use client";
import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import WorkspaceSidebar from "./workspace-sidebar";
import { WorkbenchViewContext } from "./workbench-context";
/** 移动导航抽屉仅重新挂载导航，不移动业务页面和上传组件。 */
export default function WorkbenchNavigation({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  const view = useContext(WorkbenchViewContext);
  if (!view) return <WorkspaceSidebar label={label} className={className}>{children}</WorkspaceSidebar>;
  return view.navigation ? createPortal(<div className={className}>{children}</div>, view.navigation) : null;
}
