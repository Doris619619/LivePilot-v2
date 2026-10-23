/** 确认计划后的只读视频预览入口，标题/频道/封面直接取当前计划，不再要求用户填写。 */
"use client";
import { useId, useState } from "react";
import type { PublishingPlan } from "@/shared/publishing";
import { SurfaceDialog } from "../components/ui/primitives";
import { PlayIcon } from "../components/icons";
import MediaPreview from "../components/media-preview/media-preview";
import { packagePreviewSelection } from "../components/media-preview/selection";
import styles from "../components/media-preview/preview.module.css";
/** 打开后选择待核对的视频；关闭卸载会话，配置修改仍回到原有计划编辑器。 */
export default function PlanMediaPreview({ plan, channel }: { plan: PublishingPlan; channel?: string }) {
  const [open, setOpen] = useState(false); const [selected, setSelected] = useState("");
  const id = useId();
  const items = plan.items.filter(item => !item.excluded); const item = items.find(i => i.packageId === selected) || items[0];
  const pkg = plan.batch.packages.find(p => p.id === item?.packageId);
  const copy = plan.copies.find(c => c.packageId === item?.packageId);
  return <SurfaceDialog open={open} onOpenChange={setOpen} title="发布前预览" description={channel || plan.profile.channelId} side="right" trigger={<button type="button" className="btn-ghost publishing-plan-preview" disabled={!pkg}><PlayIcon aria-hidden="true" /><span>预览视频</span></button>}>
    {open && pkg && item && <div className={styles.dialogContent}><label htmlFor={id}>视频</label><select name="publishing-preview-package" autoComplete="off" id={id} value={item.packageId} onChange={event => setSelected(event.target.value)}>{items.map(i => <option value={i.packageId} key={i.packageId}>{i.title ?? plan.copies.find(c => c.packageId === i.packageId)?.title ?? plan.batch.packages.find(p => p.id === i.packageId)?.name}</option>)}</select>
      <MediaPreview key={pkg.id + pkg.version} title={item.title ?? copy?.title ?? pkg.title ?? pkg.name} channel={channel || plan.profile.channelId} mode="video" selection={packagePreviewSelection(plan.profile, pkg, plan.profile)} coverName={plan.profile.thumbnailMode === "fixed" ? plan.profile.thumbnailFilename : plan.profile.thumbnailMode === "matching" ? pkg.cover?.filename : undefined} />
    </div>}
  </SurfaceDialog>;
}
