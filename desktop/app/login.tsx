/** 离线登录页复用网站登录样式；密码仅在提交时交给受限桌面桥接。 */
"use client";
import { useEffect, useState } from "react";
import Help from "./help";
import { LoginUpdate } from "./local-updates";
import { EyeIcon, EyeOffIcon } from "../../src/app/components/icons";
/** 登录后才挂载配置界面；退出会清空表单和页面中的设备状态。 */
export default function Login({ children }: { children: (logout: () => Promise<void>, username: string) => React.ReactNode }) {
  const [help, setHelp] = useState(false);
  const [authenticated, setAuthenticated] = useState(false); const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [visible, setVisible] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { void window.liveNest?.session().then(s => { setAuthenticated(s.authenticated); if(s.username)setUsername(s.username); }); }, []);
  /** 原始 IPC 异常不回显，防止系统细节出现在登录页。 */
  async function submit(e: React.FormEvent) { e.preventDefault(); if (busy) return; setBusy(true); setError(""); try { const result = await window.liveNest?.login(username, password); if (result?.ok) { setPassword(""); setAuthenticated(true); } else { setError(result?.message || "请从安装后的 LiveNest 打开。"); } } catch { setError("登录未完成，请重试。"); } finally { setBusy(false); } }
  /** 后台 Agent 持续运行，界面返回空白登录表单。 */
  async function logout() { await window.liveNest?.logout(); setAuthenticated(false); setUsername(""); setPassword(""); setVisible(false); setError(""); }
  useEffect(() => { if (!authenticated) return; const timer = setInterval(() => { void window.liveNest?.session().then(s => { if (!s.authenticated) { setAuthenticated(false); setError("登录已失效，请重新登录。已有直播继续运行。"); } }); }, 2000); return () => clearInterval(timer); }, [authenticated]);
  if (help) return <main className="main-wrapper"><button onClick={() => setHelp(false)}>返回登录</button><Help /></main>;
  if (authenticated) return children(logout, username);
  return <main className="login-wrapper"><div className="login-brand"><span aria-hidden="true" style={{ color: "var(--accent-primary)" }}>◉</span>LiveNest<span className="login-brand-caption">Studio</span></div><section className="login-card"><div className="login-head"><h1>登录 LiveNest</h1></div><form className="login-form" onSubmit={submit}><label className="field-group"><span className="field-label">账号</span><input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} maxLength={80} required autoFocus /></label><label className="field-group"><span className="field-label">密码</span><span style={{ position: "relative", display: "flex", alignItems: "center" }}><input style={{ width: "100%", paddingRight: 48 }} autoComplete="current-password" type={visible ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} maxLength={256} required /><button className="pass-toggle-btn" type="button" aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}>{visible ? <EyeOffIcon /> : <EyeIcon />}</button></span></label>{error && <div className="banner error" role="alert">{error}</div>}<button className="btn-primary login-submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</button></form><div className="desktop-actions"><button type="button" onClick={() => void window.liveNest?.act("web")}>打开管理员网页端 ↗</button><button type="button" onClick={() => setHelp(true)}>离线帮助</button></div><LoginUpdate /></section></main>;
}
