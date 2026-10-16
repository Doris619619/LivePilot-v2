/** 常用文案与完整配置使用同一个受控编辑器，不创建第二份标题或说明状态。 */
"use client";
import type { BroadcastDetails } from "@/shared/broadcast";
import { titleCharacters, descriptionBytes } from "@/shared/video-metadata";
import FieldCounter from "./field-counter";
/** 不同展示位置使用独立 DOM 标识，数据直接回写同一份本场配置。 */
export default function BroadcastCopyFields({ id, value, disabled, onChange }: { id: string; value: BroadcastDetails; disabled: boolean; onChange(value: BroadcastDetails): void }) {
  return <fieldset disabled={disabled} className="broadcast-fields"><legend className="visually-hidden">标题与说明</legend>
    <div className="field-group"><label htmlFor={`broadcast-title-${id}`}>标题 <span className="field-required">必填</span></label><input id={`broadcast-title-${id}`} aria-required="true" aria-invalid={titleCharacters(value.title) > 100} value={value.title} placeholder="填写本场直播标题" onChange={e => onChange({ ...value, title: e.target.value })} aria-describedby={`title-hint-${id}`} /><FieldCounter id={`title-hint-${id}`} count={titleCharacters(value.title)} limit={100} /></div>
    <div className="field-group"><label htmlFor={`broadcast-description-${id}`}>说明</label><textarea id={`broadcast-description-${id}`} aria-invalid={descriptionBytes(value.description) > 5000} aria-describedby={`description-hint-${id}`} rows={4} value={value.description} placeholder="直播简介与相关链接" onChange={e => onChange({ ...value, description: e.target.value })} /><FieldCounter id={`description-hint-${id}`} count={descriptionBytes(value.description)} limit={5000} unit="字节" /></div>
  </fieldset>;
}
