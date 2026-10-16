/** 默认设置、配置包与完整配置共用规则字段，值始终由调用方的唯一状态驱动。 */
"use client";
import type { BroadcastDefaults } from "@/shared/broadcast-options";

/** 不维护字段副本；所有修改直接回传本场配置或设置草稿。 */
export default function BroadcastRuleFields({ id, value, disabled, onChange }: { id: string; value: BroadcastDefaults; disabled: boolean; onChange(value: BroadcastDefaults): void }) {
  return <fieldset className="broadcast-fields" disabled={disabled}><legend className="visually-hidden">直播规则</legend>
    <div className="broadcast-pair">
      <div className="field-group"><label htmlFor={`privacy-${id}`}>公开范围</label><select id={`privacy-${id}`} value={value.privacy} onChange={e => onChange({ ...value, privacy: e.target.value as BroadcastDefaults["privacy"] })}><option value="public">公开</option><option value="unlisted">不公开列出</option><option value="private">私密</option></select></div>
      <div className="field-group"><label htmlFor={`audience-${id}`}>是否面向儿童</label><select id={`audience-${id}`} value={String(value.madeForKids)} onChange={e => onChange({ ...value, madeForKids: e.target.value === "true" })}><option value="false">不面向儿童</option><option value="true">面向儿童</option></select></div>
    </div>
    <label className="broadcast-original-audio"><input type="checkbox" checked={value.videoAudio} onChange={e => onChange({ ...value, videoAudio: e.target.checked })} />保留视频原声</label>
  </fieldset>;
}
