/** 21st.dev 收录的 shadcn/Radix 组件适配层；使用本地 CSS，保留键盘、焦点与受控状态。来源见 docs/UI组件来源.md。 */
"use client";
import { useRef, type ComponentProps, type ReactNode } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as PopoverPrimitive from "@radix-ui/react-popover";

export const Tabs = TabsPrimitive.Root;
/** 使用 Radix 的 roving focus；方向键不会触发业务写操作。 */
export function TabsList({ className = "", ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={"ui-tabs-list " + className} {...props} />;
}
/** 当前选项的标记与底色只跟随调用方传入的 value。 */
export function TabsTrigger({ className = "", ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={"ui-tabs-trigger " + className} {...props} />;
}
/** 隐藏面板继续挂载，避免切换时丢失草稿、上传预览或异步状态。 */
export function TabsContent({ className = "", ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content forceMount data-slot="tabs-content" className={"ui-tabs-content " + className} {...props} />;
}
/** 展开动画保持子组件挂载；关闭时 inert 排除键盘焦点和交互。 */
export function Reveal({ open, children, id, className = "" }: { open: boolean; children: ReactNode; id?: string; className?: string }) {
  return <CollapsiblePrimitive.Root open={open}><CollapsiblePrimitive.Content forceMount id={id} inert={!open} aria-hidden={!open} className={"ui-reveal " + className}><div className="ui-reveal-inner">{children}</div></CollapsiblePrimitive.Content></CollapsiblePrimitive.Root>;
}
/** 百分比只展示调用方确认的数值，未知值保持不确定状态，不模拟推进。 */
export function Progress({ value, className = "", ...props }: ComponentProps<typeof ProgressPrimitive.Root>) {
  const bounded = typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
  return <ProgressPrimitive.Root data-slot="progress" value={bounded} className={"ui-progress " + className} {...props}><ProgressPrimitive.Indicator data-slot="progress-indicator" className="ui-progress-indicator" style={{ transform: `translateX(-${100 - (bounded ?? 35)}%)` }} /></ProgressPrimitive.Root>;
}
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
/** 门户避免被侧栏或表格裁切，Radix 处理 Escape、外部点击与焦点返回。 */
export function PopoverContent({ className = "", ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return <PopoverPrimitive.Portal><PopoverPrimitive.Content sideOffset={8} collisionPadding={12} align="end" className={"ui-popover " + className} {...props} /></PopoverPrimitive.Portal>;
}
/** Sheet/Dialog 共用 shadcn 门户结构；锁定时不能通过遮罩或 Escape 取消正在提交的操作。 */
export function SurfaceDialog({ open, onOpenChange, title, description, children, trigger, side = "center", locked = false }: { open: boolean; onOpenChange: (value: boolean) => void; title: string; description: string; children: ReactNode; trigger?: ReactNode; side?: "center" | "left" | "right"; locked?: boolean }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <DialogPrimitive.Root open={open} onOpenChange={value => { if (!locked) onOpenChange(value); }}>
    {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
    <DialogPrimitive.Portal><DialogPrimitive.Overlay className="ui-overlay" /><DialogPrimitive.Content className={"ui-dialog ui-dialog-" + side} onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { if (!trigger && returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }} onEscapeKeyDown={event => { if (locked) event.preventDefault(); }} onInteractOutside={event => { if (locked) event.preventDefault(); }}>
      <div className="ui-dialog-heading"><DialogPrimitive.Title>{title}</DialogPrimitive.Title><DialogPrimitive.Close disabled={locked} className="ui-close" aria-label="关闭"><span aria-hidden="true">×</span></DialogPrimitive.Close></div>
      <DialogPrimitive.Description className="ui-dialog-description">{description}</DialogPrimitive.Description>{children}
    </DialogPrimitive.Content></DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
