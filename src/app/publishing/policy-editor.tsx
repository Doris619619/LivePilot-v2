/** 管理员策略编辑：预算与带宽优先，协议参数折叠；验收开关不能冒充真实测试。 */
"use client";
import { useState } from "react";
import type { PublishingPolicy } from "@/shared/publishing";
export type PublishingQuota = { day: string; uploads: number; units: number; reserved: { uploads: number; units: number } };
type Props = { initial: PublishingPolicy; quota?: PublishingQuota; busy: boolean; save(policy: PublishingPolicy): Promise<void> };
const limits = [
  ["uploadsPerDay", "每日上传次数", 1, 10000, 1], ["otherUnitsPerDay", "每日 API 预算", 1, 10000000, 1],
  ["concurrency", "整机上传并发", 1, 4, 1], ["uploadMbps", "上传带宽 · Mbps", 0.1, 10000, 0.1],
  ["liveUploadMbps", "直播时带宽 · Mbps", 0.1, 10000, 0.1],
] as const;
const advanced = [
  ["publishLeadSeconds", "排期提前量 · 秒", 1, 86400, 1], ["chunkBytes", "上传块 · bytes", 262144, 33554432, 262144],
  ["pollBatchSize", "状态查询批大小", 1, 50, 1], ["processingPollSeconds", "处理核对间隔 · 秒", 10, 3600, 1],
  ["scheduledPollSeconds", "远期核对间隔 · 秒", 10, 86400, 1], ["tickSeconds", "调度间隔 · 秒", 5, 3600, 1],
] as const;
/** 表单保留完整策略，但默认只展示运营需要的选项。 */
export default function PolicyEditor({ initial, quota, busy, save }: Props) {
  const [value, setValue] = useState(initial);
  /** 数字范围与共享协议一致，避免界面接收后端一定拒绝的值。 */
  function fields(options: typeof limits | typeof advanced) {
    return options.map(([key, label, min, max, step]) => <label key={key}>{label}<input type="number" required min={min} max={max} step={step} value={value[key]} onChange={e => setValue({ ...value, [key]: Number(e.target.value) })} /></label>);
  }
  return <form className="publishing-form" onSubmit={e => { e.preventDefault(); void save(value); }}>
    <label className="publishing-check"><input type="checkbox" checked={value.enabled} onChange={e => setValue({ ...value, enabled: e.target.checked })} />开启视频发布</label>
    <dl className="publishing-summary publishing-quota">
      <div><dt>今日上传</dt><dd>{quota?.uploads || 0} / {value.uploadsPerDay}</dd></div>
      <div><dt>API 已用</dt><dd>{quota?.units || 0} / {value.otherUnitsPerDay}</dd></div>
      <div><dt>已预留</dt><dd>{quota?.reserved.uploads || 0} 次 · {quota?.reserved.units || 0} units</dd></div>
    </dl>
    <p className="publishing-hint">产品预算，按 API Project 共享；不代表 YouTube 官方限制。</p>
    <div className="publishing-fields">{fields(limits)}</div>
    <details className="publishing-details"><summary>高级运行参数</summary>
      <label>项目配额组<input required value={value.projectKey} onChange={e => setValue({ ...value, projectKey: e.target.value })} /></label>
      <div className="publishing-fields">{fields(advanced)}</div>
      <p className="publishing-hint">配额日：{quota?.day || "尚无请求"}。调整策略不会改变已确认的发布时间。</p>
    </details>
    <fieldset><legend>服务与验收</legend>
      <label>隐私联系地址<input required value={value.privacyContact} onChange={e => setValue({ ...value, privacyContact: e.target.value })} placeholder="邮箱或支持页面" /></label>
      <label>真实 API 验收记录<textarea rows={3} value={value.verificationNote} onChange={e => setValue({ ...value, verificationNote: e.target.value })} placeholder="项目、测试视频、自动公开及 Unicode 边界证据" /></label>
      <label className="publishing-check"><input type="checkbox" checked={value.publicVerified} onChange={e => setValue({ ...value, publicVerified: e.target.checked })} />已完成真实 API 验收，允许自动公开</label>
    </fieldset>
    <button className="btn-primary" disabled={busy}>{busy ? "保存中…" : "保存策略"}</button>
  </form>;
}
