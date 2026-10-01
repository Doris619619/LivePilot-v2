/** 批次确认：紧凑排期清单、单项文案编辑和上传同意，不隐藏最终可见性。 */
"use client";
import { useState } from "react";
import { UPLOAD_NOTICE, type ItemOverride, type MediaAsset, type PublishingProfile } from "@/shared/publishing";
import { descriptionBytes, visibilityLabel, titleCharacters } from "./display";
import { itemOverrideSchema } from "@/shared/publishing";

export type PublishingPreview = {
  id: string; profile: PublishingProfile; assets: MediaAsset[]; thumbnails: string[];
  copies: { title: string; description: string }[];
  slots: { publishAt: string; local: string; overlapping: boolean }[]; skipped: string[];
};
type Props = { preview: PublishingPreview; channel?: string; busy: boolean; cancel(): void; confirm(ai: boolean, overrides: ItemOverride[]): Promise<void> };

/** 一次只展开一个素材编辑器，批次清单保持可扫描；无效覆盖阻止提交。 */
export default function BatchConfirm({ preview, channel, busy, cancel, confirm }: Props) {
  const [editing, setEditing] = useState("");
  const [overrides, setOverrides] = useState<Record<string, ItemOverride>>({});
  const [accepted, setAccepted] = useState(false); const [ai, setAi] = useState(false);
  const invalid = Object.values(overrides).some(value => !itemOverrideSchema.safeParse(value).success);
  const profile = preview.profile;
  /** 留空标题恢复模板 / AI，说明允许用户明确清空。 */
  function change(id: string, values: Partial<ItemOverride>) {
    setOverrides(old => ({ ...old, [id]: { ...old[id], assetId: id, ...values } }));
  }
  return <section className="publishing-preview" aria-label="确认上传与自动发布">
    <dl className="publishing-summary">
      <div><dt>频道</dt><dd>{channel || profile.channelId}</dd></div>
      <div><dt>可见性</dt><dd>{visibilityLabel(profile)}</dd></div>
      <div><dt>配置</dt><dd>{profile.name}</dd></div>
      <div><dt>视频</dt><dd>{preview.assets.length} 个</dd></div>
    </dl>
    <div className="publishing-section-heading"><h2>发布清单</h2><span>{profile.scheduled ? profile.schedule.timezone : "整理完成后发布"}</span></div>
    {profile.ai.enabled && <p className="publishing-hint">AI 文案已开启，以下标题为失败兜底。</p>}
    <div className="publishing-preview-list">
      {preview.assets.map((asset, index) => {
        const override = overrides[asset.id]; const copy = preview.copies[index]; const slot = preview.slots[index];
        const title = override?.title || copy?.title || asset.filename;
        const description = override?.description ?? copy?.description ?? "";
        const issues = override ? itemOverrideSchema.safeParse(override) : undefined;
        return <article key={asset.id} className="publishing-preview-item">
          <div className="publishing-preview-row">
            <span className="publishing-order">{index + 1}</span>
            <div className="publishing-file"><h3>{title}</h3><span>{asset.filename}</span></div>
            <div className="publishing-slot">{slot?.local || "整理完成后"}{slot?.overlapping && <small>重叠时刻，采用第一次</small>}</div>
            <button className="btn-ghost" aria-expanded={editing === asset.id} onClick={() => setEditing(editing === asset.id ? "" : asset.id)}>编辑文案</button>
          </div>
          {editing === asset.id && <div className="publishing-inline-editor">
            <div className="publishing-section-heading"><h3>{asset.filename}</h3><button className="btn-ghost" onClick={() => setEditing("")}>收起</button></div>
            <label>标题覆盖<input value={override?.title || ""} placeholder={copy?.title} onChange={e => change(asset.id, { title: e.target.value || undefined })} /></label>
            <div className="publishing-field-meta"><span>留空使用配置文案</span><span>{titleCharacters(title)} / 100</span></div>
            <label>说明<textarea rows={3} value={description} onChange={e => change(asset.id, { description: e.target.value })} /></label>
            <div className="publishing-field-meta"><span /><span>{descriptionBytes(description)} / 5000 bytes</span></div>
            {profile.thumbnailMode === "matching" && <label>封面<select value={override?.thumbnail || asset.thumbnail || ""} onChange={e => change(asset.id, { thumbnail: e.target.value || undefined })}><option value="">请选择图片</option>{preview.thumbnails.map(name => <option key={name}>{name}</option>)}</select></label>}
            {issues && !issues.success && <p className="publishing-validation" role="alert">{issues.error.issues[0]?.message}</p>}
          </div>}
        </article>;
      })}
    </div>
    {preview.skipped.length > 0 && <p className="publishing-warning">已跳过夏令时不存在的时刻：{preview.skipped.join("、")}</p>}
    <details className="publishing-details"><summary>发布规则</summary><dl className="publishing-summary">
      <div><dt>提前上传</dt><dd>{profile.schedule.preuploadDays} 天</dd></div>
      <div><dt>封面</dt><dd>{profile.thumbnailMode === "matching" ? "同名图片" : profile.thumbnailMode === "fixed" ? profile.thumbnailFilename : "YouTube 自动选择"}</dd></div>
      <div><dt>儿童内容</dt><dd>{profile.madeForKids ? "是" : "否"}</dd></div>
      <div><dt>AI 失败</dt><dd>{profile.ai.enabled ? "使用已确认兜底" : "未启用 AI"}</dd></div>
    </dl><p className="publishing-hint">迟到任务继续恢复，最终生效时间在队列中显示。</p></details>
    <div className="publishing-consent">
      <p>{UPLOAD_NOTICE}</p>
      <div className="publishing-legal-links"><a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms</a><a href="https://www.youtube.com/howyoutubeworks/policies/community-guidelines/" target="_blank" rel="noreferrer">Community Guidelines</a></div>
      <label className="publishing-check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />确认频道、素材和排期；同意上传期间使用临时私密标题，完成后恢复发布文案。</label>
      {profile.ai.enabled && <label className="publishing-check"><input type="checkbox" checked={ai} onChange={e => setAi(e.target.checked)} />同意 AI 生成标题与说明，失败时使用已确认的兜底文案。</label>}
    </div>
    <div className="publishing-actions"><button className="btn-primary" disabled={busy || !accepted || invalid || profile.ai.enabled && !ai} onClick={() => void confirm(ai, Object.values(overrides))}>{busy ? "提交中…" : "确认上传并按计划发布"}</button><button disabled={busy} onClick={cancel}>返回修改</button></div>
  </section>;
}
