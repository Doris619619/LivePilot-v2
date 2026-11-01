/** 发布账号的集中选择与单账号详情；三种预览布局共享连接、恢复和清理行为。 */
"use client";
import { YouTubeIcon } from "../components/icons";
import { useRef, useState } from "react";
import Image from "next/image";
import type { PublishingAccount } from "@/shared/publishing";
import type { PublishingCleanup } from "./data-settings";
import AccountDeleteDialog from "./account-delete-dialog";
import "./account-manager.css";

export type AccountsLayout = "split" | "grid" | "compact";
type Props = {
  accounts: PublishingAccount[];
  selectedId: string;
  layout: AccountsLayout;
  busy: boolean;
  accepted: boolean;
  offline: boolean;
  connectionErrors: Record<string, string>;
  cleanups: PublishingCleanup[];
  readAt: number;
  select(id: string): void;
  add(): void;
  connect(id: string): void;
  publish(id: string): void;
  remove(id: string): Promise<void>;
};

/** 与工作台保持一致的线性删除图标；名称与目标由外层按钮提供给读屏用户。 */
function TrashIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></svg>;
}

/** 只展示该频道公开头像；缺失或载入失败时回退到平台图标，不代猜真实账号身份。 */
function ChannelAvatar({ account }: { account: PublishingAccount }) {
  const [failed, setFailed] = useState(false);
  return <span className="account-manager-detail-logo" aria-hidden="true">{account.channelAvatarUrl && !failed ? <Image unoptimized src={account.channelAvatarUrl} alt="" width={56} height={56} onError={() => setFailed(true)} /> : <YouTubeIcon width="28" height="28" />}</span>;
}

/** 账号状态使用同一组公开字段，不根据频道名称或旧快照推测连接成功。 */
function accountState(account: PublishingAccount) {
  if (account.status === "connected") return { label: "已连接", tone: "connected" };
  if (account.status === "needs_reauthorization") return { label: "需要重新授权", tone: "attention" };
  if (account.status === "cleanup_pending") return { label: "清理中", tone: "pending" };
  return { label: "未连接", tone: "unbound" };
}

/** 账号选择使用按钮而非整行伪链接；DOM顺序同时适用于列表、网格和紧凑表格。 */
export default function PublishingAccountManager({ accounts, selectedId, layout, busy, accepted, offline, connectionErrors, cleanups, readAt, select, add, connect, publish, remove }: Props) {
  const [deletingId, setDeletingId] = useState<string>();
  const lastSelection = useRef("");
  const selected = accounts.find(account => account.id === selectedId) || accounts[0];
  const deleting = accounts.find(account => account.id === deletingId && !["cleanup_pending", "deleted"].includes(account.status));
  const current = selected && accountState(selected);
  const connected = selected?.status === "connected";
  const cleaning = selected?.status === "cleanup_pending";
  const blocked = busy || !accepted || offline || cleaning;
  const error = selected && connectionErrors[selected.id];
  return <section className={"account-manager account-manager--" + layout} aria-label="发布账号管理" aria-busy={busy}>
    <div className="account-manager-directory">
      <div className="account-manager-toolbar"><h2>账号<span>{accounts.length}</span></h2><button className={accounts.length ? "btn-secondary" : "btn-primary"} disabled={busy || !accepted || offline} onClick={add}>添加账号</button></div>
      {!!accounts.length && <>
        <div className="account-manager-mobile-picker"><label>当前账号<select aria-label="发布账号" value={selected?.id || ""} disabled={busy} onChange={event => select(event.target.value)}>{accounts.map(account => <option key={account.id} value={account.id}>{account.channel || account.name} · {accountState(account).label}</option>)}</select></label><button className="account-manager-delete" aria-label={"删除账号 " + (selected?.channel || selected?.name)} title="删除账号" disabled={busy || cleaning} onClick={() => setDeletingId(selected?.id)}><TrashIcon /></button></div>
        {layout === "compact" && <div className="account-manager-table-heading" aria-hidden="true"><span>账号</span><span>连接状态</span><span className="visually-hidden">操作</span></div>}
        <nav className="account-manager-collection" aria-label="选择发布账号">{accounts.map(account => {
          const state = accountState(account);
          return <div className={"account-manager-row " + (account.id === selected?.id ? "is-selected" : "")} key={account.id}><button className={"account-manager-item " + (account.id === selected?.id ? "is-selected" : "")} aria-label={"选择账号 " + (account.channel || account.name)} aria-pressed={account.id === selected?.id} disabled={busy} onClick={() => select(account.id)} ref={element => {
            // 新增或恢复的选择滚入清单视口；不抢焦点，也不把其他已选账号强行滚回顶部。
            if (element && account.id === selected?.id && lastSelection.current !== account.id && !window.matchMedia("(max-width: 760px)").matches) { lastSelection.current = account.id; element.scrollIntoView({ block: "nearest" }); }
          }}>
            <span className="account-manager-avatar" aria-hidden="true"><YouTubeIcon width="20" height="20" /></span>
            <span className="account-manager-item-name"><strong>{account.channel || account.name}</strong>{account.channel && account.channel !== account.name && <span>{account.name}</span>}</span>
            <span className={"account-manager-state account-manager-state--" + state.tone}><i aria-hidden="true" />{state.label}</span>
          </button><button className="account-manager-delete" aria-label={"删除账号 " + (account.channel || account.name)} title="删除账号" disabled={busy || account.status === "cleanup_pending"} onClick={() => setDeletingId(account.id)}><TrashIcon /></button></div>;
        })}</nav>
      </>}
    </div>
    {selected ? <section className="account-manager-detail" key={selected.id} aria-label={"发布账号 " + selected.name}>
      <header className="account-manager-detail-heading"><ChannelAvatar key={selected.id + ":" + selected.channelAvatarUrl} account={selected} /><div><h2>{selected.channel || selected.name}</h2><span className={"account-manager-state account-manager-state--" + current!.tone}><i aria-hidden="true" />{current!.label}</span></div></header>
      {selected.channelId && <a className="account-manager-channel-link" href={"https://www.youtube.com/channel/" + encodeURIComponent(selected.channelId)} target="_blank" rel="noreferrer">查看频道主页<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3h7v7M21 3l-10 10M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></svg></a>}
      <div className="account-manager-connection">
        {cleaning ? <p>等待设备完成清理，请保持 LiveNest 在线。</p> : selected.status === "needs_reauthorization" && <p>请重新授权原频道。</p>}
        {!cleaning && <div className="account-manager-primary-actions">{connected ? <><button className="btn-primary" disabled={busy || !accepted} onClick={() => publish(selected.id)}>去发布视频</button><button className="btn-ghost" disabled={blocked} onClick={() => connect(selected.id)}>重新授权</button></> : <button className="btn-primary" disabled={blocked} onClick={() => connect(selected.id)}>{selected.status === "needs_reauthorization" ? "重新授权" : error ? "重试连接频道" : "连接频道"}</button>}</div>}
        {error && <p className="account-manager-error" role="alert">{error}</p>}
      </div>
      {cleanups.filter(cleanup => cleanup.accountId === selected.id).map(cleanup => <p key={cleanup.id} className="account-manager-cleanup" role="status">{cleanup.state === "complete" ? "授权撤销与设备清理已确认" : (cleanup.deadline < readAt ? "清理已超期，请上线设备或联系管理员。期限 " : "等待设备清理，期限 ") + new Date(cleanup.deadline).toLocaleString()}</p>)}
    </section> : <div className="account-manager-empty"><span className="account-manager-detail-logo" aria-hidden="true"><YouTubeIcon width="28" height="28" /></span><h2>添加你的第一个发布账号</h2><p>每个账号独立连接一个 YouTube 频道。</p></div>}
    <AccountDeleteDialog account={deleting} busy={busy} onClose={() => setDeletingId(undefined)} remove={remove} />
  </section>;
}
