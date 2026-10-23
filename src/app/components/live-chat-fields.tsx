/** 共用互动编辑器；人设示例仅展示风格，不代表模型实测。 */
"use client";
import type { LiveChatConfig } from "@/shared/live-chat";
import { chatPersonas, type ChatPersona } from "@/shared/chat-personas";
import "./live-chat-fields.css";
import FieldCounter from "./field-counter";
/** 回写完整草稿；设置页隐藏启停但允许编辑已关闭的偏好。 */
export default function LiveChatFields({ id, value, disabled, onChange: onCommit, hideEnable = false }: { id: string; value: LiveChatConfig; disabled?: boolean; hideEnable?: boolean; onChange(value: LiveChatConfig): void }) {
  /** 编辑后明确保存新接话模式；未编辑的旧包保持原协议兼容。 */
  function onChange(next: LiveChatConfig) { onCommit({ ...next, replyMode: next.replyMode || "responsive" }); }
  const persona = chatPersonas[value.preset];
  return <fieldset className="broadcast-fields live-chat-fields" disabled={disabled}><legend className="visually-hidden">AI 观众互动</legend>
    {!hideEnable && <label className="live-chat-enable"><input name="chatEnabled" type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} />自动回复观众</label>}
    {(value.enabled || hideEnable) && <>
      <div className="live-chat-field-grid">
        <div className="field-group"><label htmlFor={`chat-persona-${id}`}>互动人设</label><select id={`chat-persona-${id}`} name="preset" autoComplete="off" value={value.preset} onChange={e => onChange({ ...value, preset: e.target.value as ChatPersona })}>{Object.entries(chatPersonas).map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}</select></div>
        <div className="field-group"><label htmlFor={`chat-mode-${id}`}>什么时候接话</label><select id={`chat-mode-${id}`} name="replyMode" autoComplete="off" value={value.replyMode || "responsive"} onChange={e => onChange({ ...value, replyMode: e.target.value as LiveChatConfig["replyMode"] })}><option value="responsive">尽量回应 · 有效留言优先</option><option value="natural">自然参与 · 不抢话</option><option value="addressed">被叫才回 · 昵称或明确对话</option></select></div>
      </div>
      <details className="chat-persona-directory"><summary>比较全部人设风格</summary><p>以下是风格示例，实际回复请在试聊中比较。</p>{Object.entries(chatPersonas).map(([key, item]) => <button type="button" key={key} aria-pressed={value.preset === key} onClick={() => onChange({ ...value, preset: key as ChatPersona })}><strong>{item.name}</strong><span>{item.description}</span><q>{item.example}</q></button>)}</details>
      <div className="chat-persona-sample" aria-live="polite"><strong>{persona.description}</strong><p>风格示例 · 观众说「好好听呀」</p><blockquote>{persona.example}</blockquote><p lang="en">{persona.english}</p></div>
      <details className="chat-expression" open={value.preset === "custom" ? true : undefined}><summary>更多设置 · 昵称、频道背景与表达</summary>
      <div className="live-chat-field-grid">
        <div className="field-group"><label htmlFor={`chat-nickname-${id}`}>助手昵称</label><input id={`chat-nickname-${id}`} name="nickname" autoComplete="off" maxLength={40} value={value.nickname || ""} placeholder="助手" onChange={e => onChange({ ...value, nickname: e.target.value })} /></div>
        <div className="field-group"><label htmlFor={`chat-interval-${id}`}>发送间隔（秒）</label><select id={`chat-interval-${id}`} name="intervalSeconds" autoComplete="off" value={value.intervalSeconds} onChange={e => onChange({ ...value, intervalSeconds: Number(e.target.value) })}>{Array.from({ length: 56 }, (_, index) => index + 5).map(seconds => <option key={seconds} value={seconds}>{seconds}{seconds === 5 ? " · 活跃" : seconds === 15 ? " · 适中" : seconds === 30 ? " · 安静" : ""}</option>)}</select></div>
      </div>
      <div className="field-group"><label htmlFor={`chat-facts-${id}`}>频道背景</label><textarea id={`chat-facts-${id}`} name="channelFacts" autoComplete="off" rows={2} maxLength={1500} value={value.channelFacts || ""} onChange={e => onChange({ ...value, channelFacts: e.target.value })} placeholder="只填已确认事实，例如音乐来源、是否命名。留空时不会猜测。" /><button type="button" onClick={() => onChange({ ...value, channelFacts: "本直播间播放 AI 生成音乐，当前音乐未命名。" })}>填入「AI 音乐，未命名」</button><small>仅在符合本场内容时使用；不会推断版权、下载或点歌能力。</small></div>
      <div className="live-chat-field-grid">
        <div className="field-group"><label htmlFor={`chat-length-${id}`}>回复长短</label><select id={`chat-length-${id}`} name="verbosity" autoComplete="off" value={value.verbosity || "brief"} onChange={e => onChange({ ...value, verbosity: e.target.value as LiveChatConfig["verbosity"] })}><option value="brief">简短接话</option><option value="balanced">需要时多说一句</option></select></div>
        <div className="field-group"><label htmlFor={`chat-humor-${id}`}>幽默程度</label><select id={`chat-humor-${id}`} name="humor" autoComplete="off" value={value.humor || ""} onChange={e => onChange({ ...value, humor: (e.target.value || undefined) as LiveChatConfig["humor"] })}><option value="">跟随人设</option><option value="none">不用玩笑</option><option value="light">偶尔接梗</option><option value="frequent">更有趣一些</option></select></div>
        <div className="field-group"><label htmlFor={`chat-emoji-${id}`}>表情</label><select id={`chat-emoji-${id}`} name="emoji" autoComplete="off" value={value.emoji || ""} onChange={e => onChange({ ...value, emoji: (e.target.value || undefined) as LiveChatConfig["emoji"] })}><option value="">跟随人设</option><option value="none">不用表情</option><option value="occasional">偶尔使用</option></select></div>
      </div><label className="live-chat-enable"><input name="askQuestions" type="checkbox" checked={value.askQuestions ?? false} onChange={e => onChange({ ...value, askQuestions: e.target.checked })} />偶尔主动提问（必要的澄清始终允许）</label>
      <div className="field-group"><label htmlFor={`chat-prompt-${id}`}>人设描述（可选）</label><textarea id={`chat-prompt-${id}`} name="customPrompt" autoComplete="off" rows={3} maxLength={2000} value={value.customPrompt} onChange={e => onChange({ ...value, customPrompt: e.target.value })} placeholder="写角色、喜欢的表达、禁用口头禅，以及两三组回复示例。" aria-describedby={`chat-count-${id}`} /><FieldCounter id={`chat-count-${id}`} count={value.customPrompt.length} limit={2000} /></div></details>
    </>}
  </fieldset>;
}
