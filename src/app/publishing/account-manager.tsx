/** 发布账号的集中选择与单账号详情；三种预览布局共享连接、恢复和清理行为。 */
"use client";
import { YouTubeIcon } from "../components/icons";
import type { PublishingAccount } from "@/shared/publishing";
import DataSettings, { type PublishingCleanup } from "./data-settings";
import "./account-manager.css";

export type AccountsLayout = "split" | "grid" | "compact";
type Props = {
  accounts: PublishingAccount[];
  selectedId: string;
  layout: AccountsLayout;
  deviceName: string;
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

/** 账号状态使用同一组公开字段，不根据频道名称或旧快照推测连接成功。 */
function accountState(account: PublishingAccount) {
  if (account.status === "connected") return { label: "已连接", tone: "connected" };
  if (account.status === "needs_reauthorization") return { label: "需要重新授权", tone: "attention" };
  if (account.status === "cleanup_pending") return { label: "清理中", tone: "pending" };
  return { label: "未连接", tone: "unbound" };
}

/** 账号选择使用按钮而非整行伪链接；DOM顺序同时适用于列表、网格和紧凑表格。 */
export default function PublishingAccountManager({ accounts, selectedId, layout, deviceName, busy, accepted, offline, connectionErrors, cleanups, readAt, select, add, connect, publish, remove }: Props) {
  const selected = accounts.find(account => account.id === selectedId) || accounts[0];
  const current = selected && accountState(selected);
  const connected = selected?.status === "connected";
  const cleaning = selected?.status === "cleanup_pending";
  const blocked = busy || !accepted || offline || cleaning;
  const error = selected && connectionErrors[selected.id];
  return <section className={"account-manager account-manager--" + layout} aria-label="发布账号管理" aria-busy={busy}>
    <div className="account-manager-directory">
      <div className="account-manager-toolbar"><h2>账号<span>{accounts.length}</span></h2><button className={accounts.length ? "btn-secondary" : "btn-primary"} disabled={busy || !accepted || offline} onClick={add}>添加账号</button></div>
      {!!accounts.length && <>
        <label className="account-manager-mobile-picker">当前账号<select aria-label="发布账号" value={selected?.id || ""} disabled={busy} onChange={event => select(event.target.value)}>{accounts.map(account => <option key={account.id} value={account.id}>{account.channel || account.name} · {accountState(account).label}</option>)}</select></label>
        {layout === "compact" && <div className="account-manager-table-heading" aria-hidden="true"><span>账号</span><span>连接状态</span><span>添加日期</span></div>}
        <nav className="account-manager-collection" aria-label="选择发布账号">{accounts.map(account => {
          const state = accountState(account);
          return <button className={"account-manager-item " + (account.id === selected?.id ? "is-selected" : "")} key={account.id} aria-label={"选择账号 " + (account.channel || account.name)} aria-pressed={account.id === selected?.id} disabled={busy} onClick={() => select(account.id)}>
            <span className="account-manager-avatar" aria-hidden="true"><YouTubeIcon width="20" height="20" /></span>
            <span className="account-manager-item-name"><strong>{account.channel || account.name}</strong>{account.channel && account.channel !== account.name && <span>{account.name}</span>}</span>
            <span className={"account-manager-state account-manager-state--" + state.tone}><i aria-hidden="true" />{state.label}</span>
            {layout === "compact" && <time className="account-manager-date" dateTime={new Date(account.createdAt).toISOString()}>{new Date(account.createdAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</time>}
          </button>;
        })}</nav>
      </>}
    </div>
    {selected ? <section className="account-manager-detail" key={selected.id} aria-label={"发布账号 " + selected.name}>
      <header className="account-manager-detail-heading"><span className="account-manager-detail-logo" aria-hidden="true"><YouTubeIcon width="28" height="28" /></span><div><h2>{selected.channel || selected.name}</h2><span className={"account-manager-state account-manager-state--" + current!.tone}><i aria-hidden="true" />{current!.label}</span></div></header>
      <div className="account-manager-connection">
        <p>{cleaning ? "等待设备完成清理，请保持 LiveNest 在线。" : connected ? "频道已连接，可以开始准备视频。" : selected.status === "needs_reauthorization" ? "原任务和已排期视频保留，请重新授权原频道。" : "连接 YouTube 频道，开始发布视频。"}</p>
        {!cleaning && <div className="account-manager-primary-actions">{connected ? <><button className="btn-primary" disabled={busy || !accepted} onClick={() => publish(selected.id)}>去发布视频</button><button className="btn-ghost" disabled={blocked} onClick={() => connect(selected.id)}>重新授权</button></> : <button className="btn-primary" disabled={blocked} onClick={() => connect(selected.id)}>{selected.status === "needs_reauthorization" ? "重新授权" : error ? "重试连接频道" : "连接频道"}</button>}</div>}
        {error && <p className="account-manager-error" role="alert">{error}</p>}
      </div>
      <dl className="account-manager-metadata"><div><dt>发布设备</dt><dd>{deviceName}</dd></div>{selected.channel && selected.channel !== selected.name && <div><dt>账号名称</dt><dd>{selected.name}</dd></div>}</dl>
      <details className="account-manager-data"><summary>{selected.status === "unbound" ? "账号数据" : "授权与数据"}</summary><DataSettings account={selected} accountName={selected.channel || selected.name} disabled={cleaning} busy={busy} cleanups={cleanups.filter(cleanup => cleanup.accountId === selected.id)} readAt={readAt} remove={() => remove(selected.id)} /></details>
    </section> : <div className="account-manager-empty"><span className="account-manager-detail-logo" aria-hidden="true"><YouTubeIcon width="28" height="28" /></span><h2>添加你的第一个发布账号</h2><p>每个账号独立连接一个 YouTube 频道。</p></div>}
  </section>;
}
