/** 账号数据与授权撤销入口；全新未连接账号不展示 Google 管理链接，清理仍须等待 Agent 确认。 */
"use client";
import { useState } from "react";
import Link from "next/link";
import type { PublishingAccount } from "@/shared/publishing";
export type PublishingCleanup = { id: string; agentId: string; instanceId: string; accountId?: string; deadline: number; state: string };
/** 历史频道或连接时间保留撤销入口；无账号参数的旧版任务继续使用原授权清理流程。 */
export default function DataSettings({ disabled, busy, cleanups, readAt, accountName, account, remove }: { disabled: boolean; busy: boolean; cleanups: PublishingCleanup[]; readAt: number; accountName?: string; account?: Pick<PublishingAccount, "status" | "channelId" | "connectedAt">; remove(): Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const hasAuthorization = !account || ["connected", "needs_reauthorization"].includes(account.status) || !!account.channelId || !!account.connectedAt;
  return <section className="publishing-data">
    <div className="publishing-section-heading"><h2>{hasAuthorization ? "撤销授权与删除数据" : "账号数据"}</h2>{hasAuthorization && <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">查看或撤销 Google 授权</a>}</div>
    <p className="publishing-hint">{account?.status === "cleanup_pending" ? "此账号正在等待设备完成清理，请保持设备在线。清理完成后如需连接频道，请添加新账号。" : !account ? "此入口用于查看或撤销旧实例已有的 Google 授权。" : hasAuthorization ? "此入口用于管理已有授权，重新连接请使用上方的连接按钮。" : "此发布账号尚未连接频道，请使用上方的“连接频道”。"}</p>
    <p className="publishing-hint">{accountName ? "删除「" + accountName + "」的" + (hasAuthorization ? "发布授权与数据。" : "账号记录与数据。") : "撤销旧实例的授权，并删除保存的 YouTube 数据。"}</p>
    <button className="btn-danger" disabled={busy || disabled} onClick={() => setConfirming(!confirming)}>{hasAuthorization ? "撤销授权与删除数据" : "删除账号与数据"}</button>
    {confirming && <div className="publishing-warning">
      <p>{accountName ? "本地只清理这个发布账号。Google 会撤销该用户对本应用的授权；同一 Google 用户的直播和其他频道也可能需要重新连接。" : "这也会影响当前实例的直播 API 控制。"}已提交的定时视频仍可能公开；本地源文件和 YouTube 视频保留。</p>
      <p>Cloud 先删除发布记录；Agent 离线时等待设备上线完成撤销与清理。</p>
      <div className="publishing-actions"><button className="btn-danger" disabled={busy} onClick={() => { void remove(); setConfirming(false); }}>{hasAuthorization ? "确认撤销与删除" : "确认删除账号与数据"}</button><button disabled={busy} onClick={() => setConfirming(false)}>返回</button></div>
    </div>}
    {cleanups.map(cleanup => <p key={cleanup.id} className="publishing-message" role="status">{cleanup.state === "complete" ? "授权撤销与设备清理已确认" : (cleanup.deadline < readAt ? "清理已超期，请上线设备或联系管理员。期限 " : "等待设备清理，期限 ") + new Date(cleanup.deadline).toLocaleString()}</p>)}
    <div className="publishing-policy-links"><Link href="/privacy">隐私政策</Link><Link href="/terms">服务条款</Link></div>
  </section>;
}
