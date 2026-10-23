/** 发布流程中的本次文案生成选项；具体视频文案仍在确认计划中编辑。 */
"use client";
import { useId } from "react";
import type { PublishingCopyOptions } from "@/shared/publishing-copy-options";
import { ApiSettingsButton } from "../components/api-settings";

/** 关闭后保留当前输入；只对缺失的标题或说明生成文案。 */
export default function PublishingCopyFields({ value, change, busy }: { value: PublishingCopyOptions; change(value: PublishingCopyOptions): void; busy: boolean }) {
  const id = useId();
  return <fieldset><legend>视频文案</legend>
    <label className="publishing-check"><input name="publishing-ai-enabled" autoComplete="off" type="checkbox" disabled={busy} checked={value.enabled} onChange={e => change({ ...value, enabled: e.target.checked })} />AI 自动生成标题和说明</label>
    {value.enabled && <div className="publishing-ai-fields">
      <p className="publishing-hint">仅补全缺失的文案，已填写的内容保留。</p>
      <label>生成语言<input name="publishing-ai-language" autoComplete="off" disabled={busy} required maxLength={40} value={value.language} onChange={e => change({ ...value, language: e.target.value })} /></label>
      <label><span id={id + "-prompt"}>生成要求</span><textarea name="publishing-ai-prompt" autoComplete="off" aria-labelledby={id + "-prompt"} disabled={busy} required maxLength={4000} rows={3} value={value.prompt} onChange={e => change({ ...value, prompt: e.target.value })} /></label>
      <ApiSettingsButton disabled={busy}>AI 服务设置</ApiSettingsButton>
    </div>}
  </fieldset>;
}
