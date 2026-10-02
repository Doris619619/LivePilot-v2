/** 独立发布账号的绑定入口；不读取或覆盖直播实例的授权。 */
"use client";
import type { PublishingAccount } from "@/shared/publishing";
/** 只有用户点击后才发起此发布账号的授权；清理中的账号不能重新使用。 */
export default function ChannelBinding({ account, busy, disabled, connect }: { account: PublishingAccount; busy: boolean; disabled: boolean; connect(): void }) {
  const status = account.status === "connected" ? "已连接" : account.status === "cleanup_pending" ? "等待设备清理" : account.status === "deleted" ? "已删除" : "未连接";
  return <section className="publishing-channel-binding" aria-label={"发布账号 " + account.name}>
    <div><strong>{account.channel || account.name}</strong><span>{status}</span></div>
    <button type="button" disabled={busy || disabled || ["cleanup_pending", "deleted"].includes(account.status)} onClick={connect}>{account.status === "connected" ? "重新授权" : "连接频道"}</button>
  </section>;
}
