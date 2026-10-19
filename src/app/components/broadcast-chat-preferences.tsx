/** 文件用途：网页互动偏好编辑器，以单一人设选择、即时风格示例和分组高级设置编辑本场草稿。 */
"use client";

import type { ChangeEvent } from "react";
import { chatPersonas, type ChatPersona } from "@/shared/chat-personas";
import type { LiveChatConfig } from "@/shared/live-chat";
import FieldCounter from "./field-counter";
import styles from "./broadcast-chat-preferences.module.css";

/** 编辑完整偏好并保留启停状态；静态示例只展示当前人设，不触发试聊或真实发送。 */
export default function BroadcastChatPreferences({ id, value, disabled, onChange }: {
  id: string;
  value: LiveChatConfig;
  disabled?: boolean;
  onChange(value: LiveChatConfig): void;
}) {
  const persona = chatPersonas[value.preset];

  /** 只合并被编辑的字段；首次编辑旧配置时补齐默认接话模式，其余值原样保留。 */
  function update(patch: Partial<LiveChatConfig>) {
    onChange({ ...value, ...patch, replyMode: patch.replyMode || value.replyMode || "responsive" });
  }

  /** 将原生表单值转换回配置类型，空白的可选风格仍表示跟随人设。 */
  function handleFieldChange(event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    const field = event.currentTarget;
    switch (field.name) {
      case "preset": update({ preset: field.value as ChatPersona }); break;
      case "replyMode": update({ replyMode: field.value as LiveChatConfig["replyMode"] }); break;
      case "intervalSeconds": update({ intervalSeconds: Number(field.value) }); break;
      case "askQuestions": update({ askQuestions: (field as HTMLInputElement).checked }); break;
      case "nickname": update({ nickname: field.value }); break;
      case "channelFacts": update({ channelFacts: field.value }); break;
      case "customPrompt": update({ customPrompt: field.value }); break;
      case "verbosity": update({ verbosity: field.value as LiveChatConfig["verbosity"] }); break;
      case "humor": update({ humor: (field.value || undefined) as LiveChatConfig["humor"] }); break;
      case "emoji": update({ emoji: (field.value || undefined) as LiveChatConfig["emoji"] }); break;
    }
  }

  /** 仅在用户点击且确认事实适用时填入已知的 AI 音乐说明，不推断其他频道能力。 */
  function fillMusicFacts() {
    update({ channelFacts: "本直播间播放 AI 生成音乐，当前音乐未命名。" });
  }

  return <fieldset className={styles.root} disabled={disabled}>
    <legend className="visually-hidden">互动偏好</legend>
    <div className={styles.field}>
      <label htmlFor={`chat-persona-${id}`}>互动人设</label>
      <select id={`chat-persona-${id}`} name="preset" value={value.preset} onChange={handleFieldChange} aria-describedby={`chat-persona-sample-${id}`}>
        {Object.entries(chatPersonas).map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}
      </select>
      <div id={`chat-persona-sample-${id}`} className={styles.personaSample} aria-live="polite">
        <p className={styles.hint}>{persona.description}</p>
        <p className={styles.sampleLabel}>风格示例 · 非实际试聊结果</p>
        <blockquote>{persona.example}</blockquote>
      </div>
    </div>

    <fieldset className={styles.group}>
      <legend>互动行为</legend>
      <div className={styles.paired}>
        <div className={styles.field}>
          <label htmlFor={`chat-mode-${id}`}>什么时候接话</label>
          <select id={`chat-mode-${id}`} name="replyMode" value={value.replyMode || "responsive"} onChange={handleFieldChange}>
            <option value="responsive">尽量回应 · 有效留言优先</option>
            <option value="natural">自然参与 · 不抢话</option>
            <option value="addressed">被叫才回 · 昵称或明确对话</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`chat-interval-${id}`}>发送间隔（秒）</label>
          <select id={`chat-interval-${id}`} name="intervalSeconds" value={value.intervalSeconds} onChange={handleFieldChange}>
            {Array.from({ length: 56 }, (_, index) => index + 5).map(seconds => <option key={seconds} value={seconds}>{seconds}{seconds === 5 ? " · 活跃" : seconds === 15 ? " · 适中" : seconds === 30 ? " · 安静" : ""}</option>)}
          </select>
        </div>
      </div>
      <div className={styles.questionField}>
        <label className={styles.checkbox} htmlFor={`chat-questions-${id}`}>
          <input id={`chat-questions-${id}`} name="askQuestions" type="checkbox" checked={value.askQuestions ?? false} onChange={handleFieldChange} aria-describedby={`chat-questions-note-${id}`} />
          偶尔主动提问
        </label>
        <p id={`chat-questions-note-${id}`} className={styles.hint}>必要的澄清始终允许。</p>
      </div>
    </fieldset>

    <details className={styles.advanced} open={value.preset === "custom" ? true : undefined}>
      <summary>高级设置<span className={styles.summaryHint}>身份、背景与表达</span></summary>
      <div className={styles.advancedBody}>
        <fieldset className={styles.group}>
          <legend>身份与背景</legend>
          <div className={styles.field}>
            <label htmlFor={`chat-nickname-${id}`}>助手昵称</label>
            <input id={`chat-nickname-${id}`} name="nickname" maxLength={40} value={value.nickname || ""} placeholder="助手" onChange={handleFieldChange} />
          </div>
          <div className={styles.field}>
            <label htmlFor={`chat-facts-${id}`}>频道背景</label>
            <textarea id={`chat-facts-${id}`} name="channelFacts" rows={3} maxLength={1500} value={value.channelFacts || ""} onChange={handleFieldChange} placeholder="只填已确认事实，例如音乐来源、是否命名。留空时不会猜测。" aria-describedby={`chat-facts-note-${id}`} />
            <button className={styles.factButton} type="button" onClick={fillMusicFacts}>填入「AI 音乐，未命名」</button>
            <p id={`chat-facts-note-${id}`} className={styles.hint}>仅在符合本场内容时使用；不会推断版权、下载或点歌能力。</p>
          </div>
          <div className={styles.field}>
            <label htmlFor={`chat-prompt-${id}`}>人设描述（可选）</label>
            <textarea id={`chat-prompt-${id}`} name="customPrompt" rows={3} maxLength={2000} value={value.customPrompt} onChange={handleFieldChange} placeholder="写角色、喜欢的表达、禁用口头禅，以及两三组回复示例。" aria-describedby={`chat-count-${id}`} />
            <FieldCounter id={`chat-count-${id}`} count={value.customPrompt.length} limit={2000} />
          </div>
        </fieldset>
        <fieldset className={styles.group}>
          <legend>表达风格</legend>
          <div className={styles.field}>
            <label htmlFor={`chat-length-${id}`}>回复长短</label>
            <select id={`chat-length-${id}`} name="verbosity" value={value.verbosity || "brief"} onChange={handleFieldChange}>
              <option value="brief">简短接话</option>
              <option value="balanced">需要时多说一句</option>
            </select>
          </div>
          <div className={styles.paired}>
            <div className={styles.field}>
              <label htmlFor={`chat-humor-${id}`}>幽默程度</label>
              <select id={`chat-humor-${id}`} name="humor" value={value.humor || ""} onChange={handleFieldChange}>
                <option value="">跟随人设</option>
                <option value="none">不用玩笑</option>
                <option value="light">偶尔接梗</option>
                <option value="frequent">更有趣一些</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor={`chat-emoji-${id}`}>表情</label>
              <select id={`chat-emoji-${id}`} name="emoji" value={value.emoji || ""} onChange={handleFieldChange}>
                <option value="">跟随人设</option>
                <option value="none">不用表情</option>
                <option value="occasional">偶尔使用</option>
              </select>
            </div>
          </div>
        </fieldset>
      </div>
    </details>
  </fieldset>;
}
