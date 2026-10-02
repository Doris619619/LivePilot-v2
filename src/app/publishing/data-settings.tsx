/** 授权删除入口：风险说明只在操作时展开，离线清理须等待 Agent 与 Google 确认。 */
"use client";
import { useState } from "react";
import Link from "next/link";
export type PublishingCleanup = { id: string; agentId: string; instanceId: string; accountId?: string; deadline: number; state: string };
/** 独立账号只清理自身记录；Google同一授权的撤销及已提交视频仍有外部影响。 */
export default function DataSettings({ disabled, busy, cleanups, readAt, accountName, remove }: { disabled: boolean; busy: boolean; cleanups: PublishingCleanup[]; readAt: number; accountName?: string; remove(): Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  return <section className="publishing-data">
    <div className="publishing-section-heading"><h2>YouTube 授权</h2><a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">Google 授权管理</a></div>
    <p className="publishing-hint">{accountName ? "删除「" + accountName + "」的发布授权与数据。" : "撤销旧实例的授权，并删除保存的 YouTube 数据。"}</p>
    <button className="btn-danger" disabled={busy || disabled} onClick={() => setConfirming(!confirming)}>撤销授权与删除数据</button>
    {confirming && <div className="publishing-warning">
      <p>{accountName ? "本地只清理这个发布账号。Google 会撤销该用户对本应用的授权；同一 Google 用户的直播和其他频道也可能需要重新连接。" : "这也会影响当前实例的直播 API 控制。"}已提交的定时视频仍可能公开；本地源文件和 YouTube 视频保留。</p>
      <p>Cloud 先删除发布记录；Agent 离线时等待设备上线完成撤销与清理。</p>
      <div className="publishing-actions"><button className="btn-danger" disabled={busy} onClick={() => { void remove(); setConfirming(false); }}>确认撤销与删除</button><button disabled={busy} onClick={() => setConfirming(false)}>返回</button></div>
    </div>}
    {cleanups.map(cleanup => <p key={cleanup.id} className="publishing-message" role="status">{cleanup.state === "complete" ? "授权撤销与设备清理已确认" : (cleanup.deadline < readAt ? "清理已超期，请上线设备或联系管理员。期限 " : "等待设备清理，期限 ") + new Date(cleanup.deadline).toLocaleString()}</p>)}
    <div className="publishing-policy-links"><Link href="/privacy">隐私政策</Link><Link href="/terms">服务条款</Link></div>
  </section>;
}
