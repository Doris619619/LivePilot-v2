/** 默认展开的侧栏分组；展开状态只留在当前登录会话，折叠不卸载菜单或业务内容。 */
"use client";
import { createContext, useContext, useId, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

type GroupState = Record<string, boolean>;
const SidebarGroupsContext = createContext<{ groups: GroupState; setGroups: Dispatch<SetStateAction<GroupState>> } | undefined>(undefined);

/** 状态放在抽屉和导航 Portal 之外，模块切换、关闭抽屉及响应式重挂载仍保留用户选择。 */
export function SidebarGroupsProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState<GroupState>({});
  return <SidebarGroupsContext.Provider value={{ groups, setGroups }}>{children}</SidebarGroupsContext.Provider>;
}

/** 整行按钮支持 Enter/Space；隐藏子项退出焦点和读屏顺序，当前页面仍保持挂载。 */
export default function SidebarGroup({ name, title, label = title, flush = false, children }: { name: string; title: string; label?: string; flush?: boolean; children: ReactNode }) {
  const context = useContext(SidebarGroupsContext);
  const [localOpen, setLocalOpen] = useState(true);
  const open = context ? context.groups[name] ?? true : localOpen;
  const contentId = useId();
  /** 独立组件预览可使用本地状态；已登录网页由会话 Provider 保存各组的独立开关。 */
  const toggle = () => {
    if (context) context.setGroups(previous => ({ ...previous, [name]: !(previous[name] ?? true) }));
    else setLocalOpen(previous => !previous);
  };
  return <div className={"sidebar-group" + (flush ? " sidebar-group-flush" : "")}>
    <button type="button" className="sidebar-heading" aria-expanded={open} aria-controls={contentId} onClick={toggle}>
      <span>{title}</span><svg className="sidebar-group-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
    </button>
    <nav id={contentId} className="sidebar-group-items" aria-label={label} hidden={!open}>{children}</nav>
  </div>;
}
