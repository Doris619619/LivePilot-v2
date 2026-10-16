/** 设置分类的滚动正文与固定操作区；表单保留自身状态，操作区不随正文离开视口。 */
"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TabsContent } from "./ui/primitives";

const FooterContext = createContext<HTMLDivElement | null | undefined>(undefined);

/** 每个分类拥有独立滚动容器和操作挂载点，隐藏时仍保留表单与滚动位置。 */
export function SettingsPanel({ value, children }: { value: string; children: ReactNode }) {
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  return <TabsContent value={value}><FooterContext.Provider value={footer}><div className="settings-panel-body">{children}</div><div className="settings-panel-footer" ref={setFooter} /></FooterContext.Provider></TabsContent>;
}

/** 将表单操作放到本分类底部；在设置中心外仍以内联方式渲染。 */
export function SettingsActions({ children }: { children: ReactNode }) {
  const footer = useContext(FooterContext);
  const actions = <div className="api-settings-actions">{children}</div>;
  return footer === undefined ? actions : footer ? createPortal(actions, footer) : null;
}
