/** 本场与配置包共用的受控互动参数，不直接修改运行中的聊天配置。 */
"use client";
import type { LiveChatConfig } from "@/shared/live-chat";
import "./live-chat-fields.css";
import FieldCounter from "./field-counter";
/** 四个参数始终回写父级完整配置；关闭时保留人设与间隔。 */
export default function LiveChatFields({ id, value, disabled, onChange }: { id: string; value: LiveChatConfig; disabled?: boolean; onChange(value: LiveChatConfig): void }) {
  return <fieldset className="broadcast-fields live-chat-fields" disabled={disabled}><legend className="visually-hidden">AI 观众互动</legend>
    <label className="live-chat-enable"><input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} />自动回复观众</label>
    {value.enabled && <><div className="live-chat-field-grid"><div className="field-group"><label htmlFor={`chat-persona-${id}`}>互动人设</label><select id={`chat-persona-${id}`} value={value.preset} onChange={e => onChange({ ...value, preset: e.target.value as LiveChatConfig["preset"] })}><option value="friendly">友善陪聊</option><option value="playful">活泼幽默</option><option value="gentle">安静温柔</option><option value="custom">自定义</option></select></div><div className="field-group"><label htmlFor={`chat-interval-${id}`}>发送间隔（秒）</label><select id={`chat-interval-${id}`} value={value.intervalSeconds} onChange={e => onChange({ ...value, intervalSeconds: Number(e.target.value) })}>{Array.from({ length: 56 }, (_, index) => index + 5).map(seconds => <option key={seconds} value={seconds}>{seconds}</option>)}</select></div></div>
    <div className="field-group"><label htmlFor={`chat-prompt-${id}`}>人设描述（可选）</label><textarea id={`chat-prompt-${id}`} rows={3} maxLength={2000} value={value.customPrompt} onChange={e => onChange({ ...value, customPrompt: e.target.value })} placeholder="例如：温柔的电台主持人，回答简短自然。" aria-describedby={`chat-count-${id}`} /><FieldCounter id={`chat-count-${id}`} count={value.customPrompt.length} limit={2000} /></div></>}
  </fieldset>;
}
