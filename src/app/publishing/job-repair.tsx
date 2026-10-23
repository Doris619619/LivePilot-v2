/** 修复已上传原视频的列表和封面设置；保留用户草稿，不创建新上传。 */
"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { PublishingRepair, VideoJob } from "@/shared/publishing";
import PublishingChannelOptionsFields from "./publishing-channel-options";
import { confirmDiscardChanges, useUnsavedChanges } from "../use-unsaved-changes";

/** 复用频道选项表单，成功受理才关闭；失败继续保留修复输入。 */
export default function JobRepair({ job, busy, save, cancel, onDirtyChange }: { job: VideoJob; busy: boolean; save(settings: PublishingRepair): Promise<boolean>; cancel(): void; onDirtyChange?(dirty: boolean): void }) {
  const [profile, setProfile] = useState(job.spec.profile); const [error, setError] = useState("");
  const dirty = JSON.stringify(profile) !== JSON.stringify(job.spec.profile);
  useUnsavedChanges(dirty);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  /** 只发送可修复的设置，原频道、素材和videoId不会进入编辑请求。 */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setError("");
    if (await save({ playlistIds: profile.playlistIds, thumbnailMode: profile.thumbnailMode, ...(profile.thumbnailMode === "fixed" ? { thumbnailFilename: profile.thumbnailFilename } : {}) })) cancel();
    else setError("修复未提交，请查看提示后重试。");
  }
  return <form className="publishing-sheet-editor" aria-label="修复发布设置" onSubmit={event => void submit(event)}>
    <PublishingChannelOptionsFields profile={profile} busy={busy} change={options => setProfile(value => ({ ...value, ...options }))} />
    <label>封面处理<select name="publishing-thumbnail-mode" autoComplete="off" value={profile.thumbnailMode} disabled={busy} onChange={event => setProfile(value => ({ ...value, thumbnailMode: event.target.value as typeof value.thumbnailMode }))}><option value={job.spec.profile.thumbnailMode}>保留当前封面设置</option>{job.spec.profile.thumbnailMode !== "none" && <option value="none">跳过封面设置</option>}</select></label>
    {error && <p role="alert" className="publishing-validation">{error}</p>}
    <div className="publishing-actions"><button className="btn-primary" disabled={busy}>保存并继续处理</button><button type="button" disabled={busy} onClick={() => { if (confirmDiscardChanges(dirty)) cancel(); }}>返回</button></div>
  </form>;
}
