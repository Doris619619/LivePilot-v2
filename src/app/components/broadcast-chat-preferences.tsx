/** 文件用途：网页互动偏好编辑器，用独立功能面板编辑人设、接话规则、身份背景与回复风格。 */
"use client";

import type { ChangeEvent } from "react";
import { chatPersonas, type ChatPersona } from "@/shared/chat-personas";
import type { LiveChatConfig } from "@/shared/live-chat";
import FieldCounter from "./field-counter";
import BroadcastChatIcon from "./broadcast-chat-icon";
import { ChevronDownIcon } from "./icons";
import styles from "./broadcast-chat-preferences.module.css";

/** 编辑完整偏好并保留启停状态；关闭自动回复仍可编辑，各面板不触发试聊或真实发送。 */
export default function BroadcastChatPreferences({ id, value, disabled, onChange }: {
  id: string;
  value: LiveChatConfig;
  disabled?: boolean;
  onChange(value: LiveChatConfig): void;
}) {
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
    <section className={styles.panel} aria-labelledby={`chat-persona-heading-${id}`}>
      <h4 className={styles.panelHeading} id={`chat-persona-heading-${id}`}><BroadcastChatIcon name="persona" /><label htmlFor={`chat-persona-${id}`}>互动人设</label></h4>
      <div className={`${styles.panelBody} ${styles.field}`}><select id={`chat-persona-${id}`} name="preset" autoComplete="off" value={value.preset} onChange={handleFieldChange}>
        {Object.entries(chatPersonas).map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}
      </select></div>
    </section>

    <section className={styles.panel} aria-labelledby={`chat-behavior-${id}`}>
      <h4 className={styles.panelHeading} id={`chat-behavior-${id}`}><BroadcastChatIcon name="behavior" />接话设置</h4>
      <div className={styles.panelBody}>
      <div className={styles.paired}>
        <div className={styles.field}>
          <label htmlFor={`chat-mode-${id}`}>接话方式</label>
          <select id={`chat-mode-${id}`} name="replyMode" autoComplete="off" value={value.replyMode || "responsive"} onChange={handleFieldChange}>
            <option value="responsive">尽量回应</option>
            <option value="natural">自然参与</option>
            <option value="addressed">被叫才回</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`chat-interval-${id}`}>发送间隔</label>
          <select id={`chat-interval-${id}`} name="intervalSeconds" autoComplete="off" value={value.intervalSeconds} onChange={handleFieldChange}>
            {Array.from({ length: 56 }, (_, index) => index + 5).map(seconds => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
          </select>
        </div>
      </div>
        <label className={styles.checkbox} htmlFor={`chat-questions-${id}`}>
          <input id={`chat-questions-${id}`} name="askQuestions" type="checkbox" checked={value.askQuestions ?? false} onChange={handleFieldChange} />
          偶尔主动提问
        </label>
      </div>
    </section>

    <details className={`${styles.panel} ${styles.collapsible}`} open={value.preset === "custom" ? true : undefined}>
      <summary><span><BroadcastChatIcon name="identity" />身份与背景</span><ChevronDownIcon aria-hidden="true" /></summary>
      <div className={styles.panelBody}>
          <div className={styles.field}>
            <label htmlFor={`chat-nickname-${id}`}>助手昵称</label>
            <input id={`chat-nickname-${id}`} name="nickname" autoComplete="off" maxLength={40} value={value.nickname || ""} placeholder="助手" onChange={handleFieldChange} />
          </div>
          <div className={styles.field}>
            <label htmlFor={`chat-facts-${id}`}>频道背景</label>
            <textarea id={`chat-facts-${id}`} name="channelFacts" autoComplete="off" rows={3} maxLength={1500} value={value.channelFacts || ""} onChange={handleFieldChange} placeholder="填写已确认的频道事实" />
            <button className={styles.factButton} type="button" onClick={fillMusicFacts}>填入「AI 音乐，未命名」</button>
          </div>
          <div className={styles.field}>
            <label htmlFor={`chat-prompt-${id}`}>人设描述</label>
            <textarea id={`chat-prompt-${id}`} name="customPrompt" autoComplete="off" rows={3} maxLength={2000} value={value.customPrompt} onChange={handleFieldChange} aria-describedby={`chat-count-${id}`} />
            <FieldCounter id={`chat-count-${id}`} count={value.customPrompt.length} limit={2000} />
          </div>
      </div>
    </details>
    <details className={`${styles.panel} ${styles.collapsible}`}>
      <summary><span><BroadcastChatIcon name="style" />回复风格</span><ChevronDownIcon aria-hidden="true" /></summary>
      <div className={styles.panelBody}>
          <div className={styles.field}>
            <label htmlFor={`chat-length-${id}`}>回复长短</label>
            <select id={`chat-length-${id}`} name="verbosity" autoComplete="off" value={value.verbosity || "brief"} onChange={handleFieldChange}>
              <option value="brief">简短</option>
              <option value="balanced">适中</option>
            </select>
          </div>
          <div className={styles.paired}>
            <div className={styles.field}>
              <label htmlFor={`chat-humor-${id}`}>幽默程度</label>
              <select id={`chat-humor-${id}`} name="humor" autoComplete="off" value={value.humor || ""} onChange={handleFieldChange}>
                <option value="">跟随人设</option>
                <option value="none">不用玩笑</option>
                <option value="light">偶尔接梗</option>
                <option value="frequent">更有趣一些</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor={`chat-emoji-${id}`}>表情</label>
              <select id={`chat-emoji-${id}`} name="emoji" autoComplete="off" value={value.emoji || ""} onChange={handleFieldChange}>
                <option value="">跟随人设</option>
                <option value="none">不用表情</option>
                <option value="occasional">偶尔使用</option>
              </select>
            </div>
          </div>
      </div>
    </details>
  </fieldset>;
}
