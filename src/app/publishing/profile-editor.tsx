/** 发布方式配置表单；发布时间归属计划，封面和高级设置按需展开。 */
"use client";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { PublishingTemplate } from "@/shared/publishing-template";
import { useSettingsDraft } from "../components/settings-drafts";
import { ConfigurationStepTitle } from "../components/configuration-step";
export type PublishingTarget = { agentId: string; instanceId: string; name: string; accountId?: string; channelId?: string; channel?: string };
type Props = { initial?: PublishingTemplate; save(profile: PublishingTemplate): Promise<void>; cancel(): void; busy: boolean; numbered?: boolean; onDirtyChange?(dirty: boolean): void };
/** 默认值可编辑；儿童内容仍须在表单中明确选择。 */
export function newProfile(): PublishingTemplate {
  return {
    id: crypto.randomUUID(), revision: 1, name: "常规发布",
    titleTemplate: "{{packageName}}", descriptionTemplate: "", tags: [], categoryId: "10", privacy: "public", scheduled: true, madeForKids: false,
    license: "youtube", embeddable: true, containsSyntheticMedia: false, notifySubscribers: true, thumbnailMode: "matching",
    ai: { enabled: false, language: "English", prompt: "根据素材主题生成准确、自然的视频标题和说明。", fallbackTitle: "{{packageName}}", fallbackDescription: "" },
    schedule: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", weekdays: [1, 3, 5, 7], localTime: "20:00", startDate: new Date().toLocaleDateString("en-CA"), preuploadDays: 28 },
  };
}
/** 编辑只保存新版本，不修改已确认的批次快照。 */
export default function ProfileEditor({ initial, save, cancel, busy, numbered = false, onDirtyChange }: Props) {
  const [value, setValue] = useState(() => initial || newProfile());
  const id = useId();
  const [childrenChoice, setChildrenChoice] = useState(initial ? String(initial.madeForKids) : "");
  const [original] = useState(() => JSON.stringify(value));
  const dirty = JSON.stringify(value) !== original || childrenChoice !== (initial ? String(initial.madeForKids) : "");
  useSettingsDraft("publishing-profile-" + id, dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  /** 原生表单校验后提交完整 Profile，儿童内容不由 AI 推断。 */
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; await save({ ...value, revision: initial ? initial.revision + 1 : 1, madeForKids: childrenChoice === "true" });
  }
  return <form className="publishing-form" onSubmit={e => void submit(e)}>
    <label><span className={numbered ? "visually-hidden" : undefined}>配置名称</span><input disabled={busy} required value={value.name} maxLength={80} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
    <fieldset><legend>{numbered ? <ConfigurationStepTitle number={2}>发布方式</ConfigurationStepTitle> : "发布方式"}</legend>
      <div className="publishing-fields"><label>可见性<select disabled={busy} value={value.privacy} onChange={e => setValue({ ...value, privacy: e.target.value as PublishingTemplate["privacy"], scheduled: e.target.value === "public" })}><option value="public">公开</option><option value="private">私密</option><option value="unlisted">不公开</option></select></label><label>是否专为儿童制作<select disabled={busy} required value={childrenChoice} onChange={e => { setChildrenChoice(e.target.value); setValue({ ...value, madeForKids: e.target.value === "true" }); }}><option value="">请选择</option><option value="false">否</option><option value="true">是</option></select></label></div>
      <div className="publishing-fields"><label>封面<select disabled={busy} value={value.thumbnailMode} onChange={e => setValue({ ...value, thumbnailMode: e.target.value as PublishingTemplate["thumbnailMode"] })}><option value="matching">使用发布包封面</option><option value="fixed">固定图片</option><option value="none">YouTube 自动选择</option></select></label></div>
    </fieldset>
    {numbered && <h4 className="configuration-step-title"><ConfigurationStepTitle number={3}>补充设置</ConfigurationStepTitle></h4>}
    <label>标签 · 逗号分隔<input disabled={busy} value={value.tags.join(",")} onChange={e => setValue({ ...value, tags: e.target.value.split(",").filter(Boolean) })} /></label>
    <details className="publishing-details"><summary>高级设置</summary>
      <div className="publishing-fields"><label>分类<select disabled={busy} value={value.categoryId} onChange={e => setValue({ ...value, categoryId: e.target.value })}><option value="10">音乐</option><option value="22">人物与博客</option><option value="24">娱乐</option><option value="27">教育</option><option value="28">科学与技术</option><option value="20">游戏</option><option value="1">电影与动画</option></select></label><label>授权许可<select disabled={busy} value={value.license} onChange={e => setValue({ ...value, license: e.target.value as PublishingTemplate["license"] })}><option value="youtube">标准 YouTube 许可</option><option value="creativeCommon">Creative Commons</option></select></label></div>
      {([ ["embeddable", "允许嵌入"], ["notifySubscribers", "通知频道订阅者"], ["containsSyntheticMedia", "含需披露的修改或合成内容"] ] as const).map(([key, label]) => <label key={key} className="publishing-check"><input disabled={busy} type="checkbox" checked={value[key]} onChange={e => setValue({ ...value, [key]: e.target.checked })} />{label}</label>)}
    </details>
    <div className="publishing-actions"><button className="btn-primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存配置包"}</button><button type="button" disabled={busy} onClick={cancel}>返回</button></div>
  </form>;
}
