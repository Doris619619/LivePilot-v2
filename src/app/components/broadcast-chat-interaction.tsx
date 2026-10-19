/** 文件用途：网页直播编排的互动设置与可选试聊，折叠时保留本场草稿和试聊结果。 */
"use client";

import { useState } from "react";
import type { LiveChatConfig } from "@/shared/live-chat";
import type { InstanceDescriptor } from "@/shared/types";
import { ApiSettingsButton } from "./api-settings";
import LiveChatFields from "./live-chat-fields";
import LiveChatPreview from "./live-chat-preview";
import styles from "./broadcast-chat-interaction.module.css";

/** 仅编辑当前 Selection；试聊不启用自动回复、不保存设置，也不卸载被收起的编辑器。 */
export default function BroadcastChatInteraction({ id, instance, value, disabled, onChange }: {
  id: string;
  instance: InstanceDescriptor;
  value: LiveChatConfig;
  disabled: boolean;
  onChange(value: LiveChatConfig): void;
}) {
  const [trialOpen, setTrialOpen] = useState(false);

  /** 与共用编辑器保持旧配置兼容：首次编辑时补齐接话模式，不改变其他偏好。 */
  function updateConfig(next: LiveChatConfig) {
    onChange({ ...next, replyMode: next.replyMode || "responsive" });
  }

  return <section className={`workflow-section broadcast-chat-interaction ${styles.root}`} aria-labelledby={`chat-heading-${id}`}>
    <div className={styles.heading}>
      <h3 id={`chat-heading-${id}`}>AI 观众互动</h3>
      <ApiSettingsButton disabled={disabled}>AI 服务设置</ApiSettingsButton>
    </div>
    <div className={styles.settings}>
      <label className={styles.enable}>
        <input type="checkbox" checked={value.enabled} disabled={disabled} onChange={event => updateConfig({ ...value, enabled: event.target.checked })} />
        自动回复观众
      </label>
      <div className={styles.preferences} hidden={!value.enabled && !trialOpen}>
        <LiveChatFields id={id} value={value} hideEnable compact disabled={disabled} onChange={updateConfig} />
      </div>
    </div>
    <details className={`${styles.trial} broadcast-chat-trial`} open={trialOpen} onToggle={event => setTrialOpen(event.currentTarget.open)}>
      <summary>试聊</summary>
      <div className={styles.trialBody}>
        <LiveChatPreview compact config={value} instanceId={instance.id} agentId={instance.agentId} disabled={disabled} />
      </div>
    </details>
  </section>;
}
