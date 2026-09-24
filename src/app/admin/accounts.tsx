/** 客户账号管理：初始密码和重置密码仅在提交期间存在页面内存。 */
"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, RequestError } from "../client-request";
type Account = { username: string; disabled: boolean };
/** 单个目标表单保留失败输入，提交成功与列表刷新失败分别反馈。 */
export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]); const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState<string>(); const [username, setUsername] = useState("");
  const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [field, setField] = useState(""); const nameRef = useRef<HTMLInputElement>(null); const passwordRef = useRef<HTMLInputElement>(null);
  /** 刷新只读取账号状态，不自动重复写入。 */
  async function refresh() {
    try { const result = await api<{ accounts: Account[] }>("/api/admin/accounts"); setAccounts(result.accounts); setLoaded(true); }
    catch { setError("账号列表暂未读取，请重新读取；已经完成的账号操作无需重复提交。"); }
  }
  useEffect(() => { let active = true; void api<{ accounts: Account[] }>("/api/admin/accounts").then(r => { if (active) { setAccounts(r.accounts); setLoaded(true); } }).catch(() => { if (active) setError("账号列表暂未读取，请重新读取。"); }); return () => { active = false; }; }, []);
  /** 切换操作目标清空密码，避免把上一个客户的输入提交给另一账号。 */
  function edit(next?: string) { setTarget(next); setUsername(next || ""); setPassword(""); setConfirm(""); setError(""); setNotice(""); setField(""); requestAnimationFrame(() => (next ? passwordRef : nameRef).current?.focus()); }
  /** 仅提交客户操作，角色完全由服务端决定。 */
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setError(""); setNotice(""); setField("");
    if (password !== confirm) { setField("password"); setError("两次密码不一致，请重新核对。"); passwordRef.current?.focus(); return; }
    setBusy(true);
    try {
      const result = await api<{ account: Account }>("/api/admin/accounts", { method: "POST", headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ action: target ? "reset" : "create", username, password }) });
      setNotice(target ? `${result.account.username} 的密码已重置，旧登录会话已撤销。` : `客户 ${result.account.username} 已创建，可以登录网页和客户端。`);
      setPassword(""); setConfirm(""); if (!target) setUsername(""); await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作结果未确认，请先核对账号状态。");
      const code = e instanceof RequestError ? e.problem.code : "";
      if (["ACCOUNT_NAME", "ACCOUNT_EXISTS"].includes(code)) { setField("username"); nameRef.current?.focus(); }
      if (code === "ACCOUNT_PASSWORD") { setField("password"); passwordRef.current?.focus(); }
    } finally { setBusy(false); }
  }
  return <section className="account-workspace" aria-label="客户账号">
    <div><div className="admin-section-heading"><h2>客户账号</h2><button disabled={busy} onClick={() => { setError(""); void refresh(); }}>重新读取</button></div>
      <p>创建客户账号或设置新密码。原密码不可查看，设备和频道配置不受影响。</p>
      {!loaded && !error && <p role="status">正在读取账号…</p>}
      <ul className="account-list">{accounts.map(account => <li key={account.username}><div><strong>{account.username}</strong><span className="setup-state">{account.disabled ? "已禁用" : "客户"}</span></div><button disabled={busy} aria-label={"重置 " + account.username + " 的密码"} onClick={() => edit(account.username)}>重置密码</button></li>)}</ul>
    </div>
    <form className="account-form" onSubmit={submit} aria-busy={busy}><div className="admin-section-heading"><h2>{target ? "重置 " + target + " 的密码" : "创建客户账号"}</h2>{target && <button type="button" disabled={busy} onClick={() => edit()}>返回创建账号</button>}</div>
      <label className="field-group">账号<input ref={nameRef} value={username} onChange={e => setUsername(e.target.value)} readOnly={!!target} disabled={busy} required minLength={2} maxLength={32} pattern="[A-Za-z0-9_]{2,32}" autoComplete="off" autoCapitalize="none" aria-invalid={field === "username"} aria-describedby={field === "username" ? "account-error" : undefined} /></label>
      {!target && <p className="text-muted">2–32 位字母、数字或下划线；大写 U 开头保留给管理员。</p>}
      <label className="field-group">{target ? "新密码" : "初始密码"}<input ref={passwordRef} type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} maxLength={256} autoComplete="new-password" disabled={busy} aria-invalid={field === "password"} aria-describedby={field === "password" ? "account-error" : undefined} /></label>
      <label className="field-group">再次输入密码<input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} maxLength={256} autoComplete="new-password" disabled={busy} /></label>
      {notice && <p role="status">{notice}</p>}{error && <p id="account-error" role="alert">{error}</p>}
      <button className="btn-primary" disabled={busy}>{busy ? "正在保存…" : target ? "保存新密码" : "创建客户账号"}</button>
    </form>
  </section>;
}
