/** 文件用途：网页直播编排的互动工作区，明确本场开关，并排呈现人设设置和独立试聊。 */
"use client";

import type { LiveChatConfig } from "@/shared/live-chat";
import type { InstanceDescriptor } from "@/shared/types";
import { ApiSettingsButton } from "./api-settings";
import BroadcastChatPreferences from "./broadcast-chat-preferences";
import LiveChatPreview from "./live-chat-preview";
import styles from "./broadcast-chat-interaction.module.css";

/** 仅编辑当前 Selection；关闭时仍可预配置和试聊，试聊不会启用自动回复或保存草稿。 */
export default function BroadcastChatInteraction({ id, instance, value, disabled, onChange }: {
  id: string;
  instance: InstanceDescriptor;
  value: LiveChatConfig;
  disabled: boolean;
  onChange(value: LiveChatConfig): void;
}) {
  /** 与共用编辑器保持旧配置兼容：首次编辑时补齐接话模式，不改变其他偏好。 */
  function updateConfig(next: LiveChatConfig) {
    onChange({ ...next, replyMode: next.replyMode || "responsive" });
  }

  return <section className={`workflow-section broadcast-chat-interaction ${styles.root}`} aria-labelledby={`chat-heading-${id}`}>
    <div className={styles.heading}>
      <h3 id={`chat-heading-${id}`}>AI 观众互动</h3>
      <ApiSettingsButton disabled={disabled}>AI 服务设置</ApiSettingsButton>
    </div>
    <div className={styles.activation}>
      <div className={styles.activationCopy}>
        <strong id={`chat-enable-${id}`}>自动回复观众</strong>
        <p id={`chat-state-${id}`} role="status">{value.enabled ? "本场已开启，开播后回复新留言" : "本场已关闭，可先配置和试聊"}</p>
      </div>
      <button type="button" className={styles.stateSwitch} role="switch" aria-checked={value.enabled} aria-labelledby={`chat-enable-${id}`} aria-describedby={`chat-state-${id}`} disabled={disabled} onClick={() => updateConfig({ ...value, enabled: !value.enabled })}>
        <span className={styles.switchTrack} aria-hidden="true"><span /></span>
        <span>{value.enabled ? "开启" : "关闭"}</span>
      </button>
    </div>
    <div className={styles.workspace}>
      <section className={styles.settings} aria-labelledby={`chat-preferences-${id}`}>
        <h4 id={`chat-preferences-${id}`}>人设与回复</h4>
        <BroadcastChatPreferences id={id} value={value} disabled={disabled} onChange={updateConfig} />
      </section>
      <section className={`${styles.trial} broadcast-chat-trial`} aria-labelledby={`chat-trial-${id}`}>
        <h4 id={`chat-trial-${id}`}>试聊</h4>
        <LiveChatPreview compact config={value} instanceId={instance.id} agentId={instance.agentId} disabled={disabled} />
      </section>
    </div>
  </section>;
}
