/* 文件用途：LiveNest 登录鉴权门禁组件，采用现代精简浅色表单卡片与标准管理员顶栏。 */

"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./client-request";
import { LiveNestLogo, UserIcon, LockIcon, LogOutIcon, EyeIcon, EyeOffIcon, AlertCircleIcon } from "./components/icons";

type User = { username: string };

/**
 * LiveNest 登录入口与状态门禁。
 */
export default function AccessGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const data = await api<{ user: User }>("/api/session");
        if (active) setUser(data.user);
      } catch {
        if (active) setUser(null);
      }
    }

    function expired() {
      setUser(null);
      setError("登录已失效，请重新登录。直播电脑上的直播不受影响。");
    }

    void load();
    window.addEventListener("livepilot-login-required", expired);
    return () => {
      active = false;
      window.removeEventListener("livepilot-login-required", expired);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-livepilot": "1" },
        body: JSON.stringify({
          username: data.get("username"),
          password: data.get("password"),
        }),
      });
      setUser(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exitSession() {
    setBusy(true);
    setError("");
    try {
      await api("/api/session", { method: "DELETE", headers: { "x-livepilot": "1" } });
      setUser(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (user === undefined) {
    return (
      <main className="login-wrapper">
        <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>正在连接 LiveNest 服务…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="login-wrapper">
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-head">
            <LiveNestLogo width={28} height={28} />
            <h1 id="login-title">LiveNest 控制台</h1>
            <p>登录以管理 OBS 直播与推流任务</p>
          </div>

          <form onSubmit={submit} className="login-form">
            <div className="field-group">
              <label htmlFor="username" className="field-label">
                账号
              </label>
              <div className="input-field-wrapper">
                <span className="input-icon-prefix">
                  <UserIcon />
                </span>
                <input
                  id="username"
                  name="username"
                  className="input-with-icon"
                  autoComplete="username"
                  pattern="[a-z0-9_]{3,32}"
                  minLength={3}
                  maxLength={32}
                  placeholder="管理员用户名"
                  required
                  disabled={busy}
                  autoFocus
                />
              </div>
            </div>

            <div className="field-group">
              <label htmlFor="password" className="field-label">
                密码
              </label>
              <div className="input-field-wrapper">
                <span className="input-icon-prefix">
                  <LockIcon />
                </span>
                <input
                  id="password"
                  name="password"
                  className="input-with-icon input-with-action"
                  type={visible ? "text" : "password"}
                  autoComplete="current-password"
                  maxLength={256}
                  placeholder="登录密码"
                  required
                  disabled={busy}
                />
                <button
                  type="button"
                  className="pass-toggle-btn"
                  onClick={() => setVisible(!visible)}
                  aria-label={visible ? "隐藏密码" : "显示密码"}
                  tabIndex={-1}
                >
                  {visible ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            {error && (
              <div className="banner error" role="alert">
                <AlertCircleIcon />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn-primary" disabled={busy} style={{ minHeight: "38px", marginTop: "4px" }}>
              {busy ? "验证中…" : "登 录"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <>
      <header className="app-header">
        <div className="header-container">
          <div className="brand-section">
            <LiveNestLogo />
            <span className="brand-name">LiveNest</span>
            <span className="brand-tag">Studio</span>
          </div>

          <div className="header-actions">
            <div className="user-tag">
              <UserIcon />
              <span>{user.username}</span>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void exitSession()}
              disabled={busy}
              aria-label="退出登录"
            >
              <LogOutIcon />
              <span>退出</span>
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="main-wrapper" style={{ paddingBottom: 0 }}>
          <div className="banner error" role="alert">
            <AlertCircleIcon />
            <span>{error}</span>
          </div>
        </div>
      )}

      {children}
    </>
  );
}
