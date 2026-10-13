/** 网页成员切换：已有会话直接选择，新成员首次验证密码；切换整页载入，隔离旧账号草稿和请求。 */
"use client";
import { useState, type FormEvent } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "./components/ui/primitives";
import { api } from "./client-request";
import "./account-switcher.css";
type User = { username: string; role: "admin" | "customer" };
type Remembered = User & { current: boolean };
const changeKey = "livenest-browser-account-change";
/** 只广播账号变化通知，不将凭据或密码放入浏览器可读存储。 */
export function notifyAccountChange() {
  try { localStorage.setItem(changeKey, Date.now() + ":" + Math.random()); } catch { /* 禁止存储时，服务端仍阻止旧成员页面的控制请求。 */ }
}
/** 其他标签页重新加载，不能让 A 的界面继续展示 B 的身份数据。 */
export function listenAccountChanges() {
  const changed = (event: StorageEvent) => { if (event.key === changeKey) window.location.reload(); };
  /** 存储通知不可用时，服务端拒绝旧身份后仍可自动回到新身份，原操作不重放。 */
  const rejected = () => window.location.reload();
  window.addEventListener("storage", changed); window.addEventListener("livepilot-account-changed", rejected);
  return () => { window.removeEventListener("storage", changed); window.removeEventListener("livepilot-account-changed", rejected); };
}
/** 返回稳定入口；从管理员切到客户时回客户工作台，不延续管理员筛选参数。 */
function destination(user: User) { return window.location.pathname === "/publishing" ? "/publishing" : user.role === "admin" ? "/admin" : "/workspace"; }
/** 点击成员名称读取有效会话，错误保留当前工作台；密码只随首次登录请求发送。 */
export default function AccountSwitcher({ user }: { user?: User }) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<Remembered[]>([]); const [adding, setAdding] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");

  /** 只在打开时读取，过期或重置过密码的成员不会冒充有效登录。 */
  async function read() {
    try { const result = await api<{ accounts: Remembered[] }>("/api/session/accounts"); setAccounts(result.accounts); setError(""); } catch (e) { setError((e as Error).message); }
  }
  /** 服务端已接受切换后通知其他标签页，并清空当前账号的已挂载组件。 */
  async function choose(username: string) {
    if (busy) return; setBusy(true); setError("");
    try { const result = await api<{ user: User }>("/api/session/accounts", { method: "POST", headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ username }) }); notifyAccountChange(); window.location.replace(destination(result.user)); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  /** 新账号必须先验证密码；成功后不把旧账号注销。 */
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; const form = event.currentTarget; const values = new FormData(form); setBusy(true); setError("");
    try { const result = await api<{ user: User }>("/api/session", { method: "POST", headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ username: values.get("username"), password: values.get("password") }) }); form.reset(); notifyAccountChange(); window.location.replace(destination(result.user)); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  /** 只退出当前账号；其他已登录账号仍可从选择器进入。 */
  async function exit() {
    if (busy) return; setBusy(true); setError("");
    try { await api("/api/session", { method: "DELETE", headers: { "x-livepilot": "1", "x-livepilot-user": user?.username || "" } }); notifyAccountChange(); window.location.reload(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (value) void read(); else { setAdding(false); setError(""); } }}>
    <PopoverTrigger asChild><button type="button" className="account-menu-trigger" aria-label="切换登录账号"><span className="account-avatar" aria-hidden="true">{user?.username.slice(0, 1).toUpperCase() || "L"}</span><span>{user?.username || "选择已登录账号"}</span><span aria-hidden="true">⌄</span></button></PopoverTrigger>
    <PopoverContent aria-label="登录账号">
    <div className="account-switcher-panel">
      <span className="account-switcher-caption">登录账号</span>
      <div className="account-switcher-list">{accounts.map(account => <button key={account.username} type="button" disabled={busy || account.current} onClick={() => void choose(account.username)}><span><strong>{account.username}</strong><small>{account.role === "admin" ? "管理员" : "客户"}</small></span><span>{account.current ? "当前" : "切换"}</span></button>)}</div>
      {adding ? <form onSubmit={add} aria-label="添加登录账号"><label>账号<input name="username" required autoComplete="username" autoCapitalize="none" pattern="[A-Za-z0-9_]{2,32}" maxLength={32} disabled={busy} /></label><label>密码<input name="password" type="password" required autoComplete="current-password" maxLength={256} disabled={busy} /></label><div className="account-switcher-form-actions"><button type="submit" className="btn-primary" disabled={busy}>{busy ? "登录中…" : "登录并切换"}</button><button type="button" disabled={busy} onClick={() => { setAdding(false); setError(""); }}>返回</button></div></form> : <button type="button" className="account-switcher-add" disabled={busy} onClick={() => setAdding(true)}>＋ 添加登录账号</button>}
      {error && <p role="alert" className="account-switcher-error">{error}</p>}
      {user && !adding && <button type="button" className="account-switcher-exit" disabled={busy} onClick={() => void exit()}>退出当前账号</button>}
    </div>
    </PopoverContent>
  </Popover>;
}
