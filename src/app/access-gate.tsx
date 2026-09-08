/** 独立成员登录入口；会话失效卸载控制面板，直播电脑上的工作继续。 */
"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./client-request";
type User = { username: string };
/** 登录状态仅控制界面，业务接口仍逐次在服务端验证身份。 */
export default function AccessGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [visible, setVisible] = useState(false);
  useEffect(() => {
    let active = true;
    /** 网络错误保留说明，不假定已登录。 */
    async function load() { try { const data = await api<{ user: User }>("/api/session"); if (active) setUser(data.user); } catch { if (active) setUser(null); } }
    /** 收到 API 会话失效事件后切换到登录表单。 */
    function expired() { setUser(null); setError("登录已失效，请重新登录。直播电脑上的直播会继续。"); }
    void load(); window.addEventListener("livepilot-login-required", expired);
    return () => { active = false; window.removeEventListener("livepilot-login-required", expired); };
  }, []);
  /** 使用同源 JSON 提交密码，不写入浏览器存储。 */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const data = new FormData(event.currentTarget); setBusy(true); setError("");
    try { const result = await api<{ user: User }>("/api/session", { method: "POST", headers: { "content-type": "application/json", "x-livepilot": "1" }, body: JSON.stringify({ username: data.get("username"), password: data.get("password") }) }); setUser(result.user); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  /** 退出只撤销登录会话，不发出停播命令。 */
  async function exitSession() {
    setBusy(true); setError("");
    try { await api("/api/session", { method: "DELETE", headers: { "x-livepilot": "1" } }); setUser(null); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (user === undefined) return <main><p role="status">正在检查登录状态…</p></main>;
  if (!user) return <main className="login-shell"><section className="login-panel" aria-labelledby="login-title">
    <p className="eyebrow">LIVEPILOT</p><h1 id="login-title">登录工作台</h1><p className="help">登录后管理直播电脑上的 OBS 与素材。</p>
    <form onSubmit={submit}>
      <label htmlFor="username">账号</label><input id="username" name="username" autoComplete="username" pattern="[a-z0-9_]{3,32}" minLength={3} maxLength={32} required disabled={busy} autoFocus />
      <label htmlFor="password">密码</label><input id="password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" maxLength={256} required disabled={busy} />
      <label className="password-toggle"><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} />显示密码</label>
      {error && <p className="notice error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
    </form><p className="help">账号由工作台管理者提供。</p>
  </section></main>;
  return <><div className="member-bar"><span>{user.username} · 共同管理</span><button onClick={() => void exitSession()} disabled={busy}>退出登录</button>{error && <span role="alert">{error}</span>}</div>{children}</>;
}
