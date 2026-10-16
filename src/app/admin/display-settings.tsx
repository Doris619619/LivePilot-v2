/** 管理员总览的显示偏好单独放入设置窗口，避免时区表单占用监控页标题栏。 */
"use client";
import { useState } from "react";
import { SurfaceDialog } from "../components/ui/primitives";

/** 显示时区仍由总览沿用原浏览器存储；切换不触碰系统时区、设备或排期。 */
export default function DisplaySettings({ timeZone, zones, labels, onChange }: { timeZone: string; zones: string[]; labels: Record<string, string>; onChange: (zone: string) => void }) {
  const [open, setOpen] = useState(false);
  return <SurfaceDialog open={open} onOpenChange={setOpen} title="显示设置" description="管理员总览的时间显示。" descriptionHidden trigger={<button type="button" className="btn-ghost">显示设置</button>}>
    <label className="field-group">显示时区<select value={timeZone} onChange={event => onChange(event.target.value)}>{zones.map(zone => <option key={zone} value={zone}>{labels[zone] ? labels[zone] + " · " : ""}{zone}</option>)}</select></label>
    <p className="field-hint">自动保存在本浏览器，仅影响总览显示，不改变发布排期。</p>
  </SurfaceDialog>;
}
