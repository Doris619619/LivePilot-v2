/** 账号通用直播模板；频道播放列表和素材只在工作台设置。 */
"use client";
import { useState } from "react";
import type { Selection } from "@/shared/types";
import { defaultBroadcast } from "@/shared/broadcast";
import BroadcastProfiles from "./broadcast-profiles";
import LiveChatFields from "./live-chat-fields";
import { defaultLiveChatConfig } from "@/shared/live-chat";
import { ConfigurationStepTitle } from "./configuration-step";
import BroadcastRuleFields from "./broadcast-rule-fields";

/** 编辑器不依赖设备在线或频道授权；类型切换保持未保存的参数。 */
export default function BroadcastProfileSettings({ onSaving }: { onSaving(value: boolean): void }) {
  const [value, setValue] = useState<Selection>({ video: "", music: "", videoAudio: false, broadcast: { ...defaultBroadcast(), liveChat: { ...defaultLiveChatConfig } } });
  const [busy, setBusy] = useState(false);
  const details = value.broadcast || defaultBroadcast();
  return <section className="api-service-section" aria-label="管理直播配置包">
    <h4 className="configuration-step-title"><ConfigurationStepTitle number={1}>选择或创建配置包</ConfigurationStepTitle></h4><BroadcastProfiles management value={value} disabled={busy} onApply={setValue} onBusyChange={saving => { setBusy(saving); onSaving(saving); }} />
    <h4 className="configuration-step-title"><ConfigurationStepTitle number={2}>直播规则</ConfigurationStepTitle></h4><BroadcastRuleFields id="profile-editor" value={{ privacy: details.privacy, madeForKids: details.madeForKids, videoAudio: value.videoAudio }} disabled={busy} onChange={rules => setValue({ ...value, videoAudio: rules.videoAudio, broadcast: { ...details, privacy: rules.privacy, madeForKids: rules.madeForKids } })} />
    <h4 className="configuration-step-title"><ConfigurationStepTitle number={3}>AI 观众互动</ConfigurationStepTitle></h4><LiveChatFields id="profile-editor" value={details.liveChat || defaultLiveChatConfig} disabled={busy} onChange={liveChat => setValue({ ...value, broadcast: { ...details, liveChat } })} />
  </section>;
}
