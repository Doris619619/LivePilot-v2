/** 直播配置包编辑表单；名称与规则作为独立草稿，提交前不会改变已保存配置。 */
"use client";
import { useEffect, useState } from "react";
import type { BroadcastProfile, BroadcastProfileSelection } from "@/shared/broadcast-profiles";
import { broadcastOptionsSnapshot, broadcastOptionsSignature } from "@/shared/broadcast-options";
import { defaultLiveChatConfig } from "@/shared/live-chat";
import { ConfigurationStepTitle } from "./configuration-step";
import BroadcastRuleFields from "./broadcast-rule-fields";
import LiveChatFields from "./live-chat-fields";
import { useSettingsDraft } from "./settings-drafts";

/** 新建与修改共用相同编号字段；保存失败保留值，切换分类不卸载表单。 */
export default function BroadcastProfileEditor({ initial, busy, save, back, onDirtyChange }: { initial: BroadcastProfile; busy: boolean; save(name: string, selection: BroadcastProfileSelection): Promise<void>; back(): void; onDirtyChange(value: boolean): void }) {
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState(() => broadcastOptionsSnapshot(initial.selection));
  const dirty = !initial.revision && !!name.trim() || name !== initial.name || broadcastOptionsSignature(value) !== broadcastOptionsSignature(initial.selection);
  useSettingsDraft("live-profile-editor", dirty);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const details = value.broadcast;
  return <form className="profile-editor" onSubmit={event => { event.preventDefault(); if (!busy) void save(name, broadcastOptionsSnapshot(value)); }}>
    <h4 className="configuration-step-title"><ConfigurationStepTitle number={1}>配置名称</ConfigurationStepTitle></h4>
    <label className="visually-hidden" htmlFor="live-profile-name">配置名称</label><input id="live-profile-name" name="profileName" autoComplete="off" required maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="例如：公开音乐直播" />
    <h4 className="configuration-step-title"><ConfigurationStepTitle number={2}>直播规则</ConfigurationStepTitle></h4>
    <BroadcastRuleFields id="profile-editor" value={{ privacy: details.privacy, madeForKids: details.madeForKids, videoAudio: value.videoAudio }} disabled={busy} onChange={rules => setValue({ ...value, videoAudio: rules.videoAudio, broadcast: { ...details, privacy: rules.privacy, madeForKids: rules.madeForKids } })} />
    <h4 className="configuration-step-title"><ConfigurationStepTitle number={3}>AI 观众互动</ConfigurationStepTitle></h4>
    <LiveChatFields id="profile-editor" value={details.liveChat || defaultLiveChatConfig} disabled={busy} onChange={liveChat => setValue({ ...value, broadcast: { ...details, liveChat } })} />
    <div className="profile-editor-actions"><button type="submit" className="btn-primary" disabled={busy || !name.trim()}>{busy ? "保存中…" : "保存配置包"}</button><button type="button" disabled={busy} onClick={back}>返回</button></div>
  </form>;
}
