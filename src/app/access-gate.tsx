/* 文件用途：LiveNest 成员访问门禁与身份管理，负责会话检查、登录表单展示及顶部管理员工具栏渲染。 */

"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./client-request";
import { LiveNestLogo, UserIcon, LogOutIcon, EyeIcon, EyeOffIcon, LockIcon, AlertCircleIcon } from "./components/icons";

type User = { username: string };

/**
 * LiveNest 访问门禁组件，验证会话有效性并提供登录与登出交互。
 *
 * @param props 包含子节点页面的组件参数
 * @returns 登录页面或受保护的工作台内容
 */
export default function AccessGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;

    /**
     * 读取当前会话状态，发生网络错误时不假定已登录。
     */
    async function load() {
      try {
        const data = await api<{ user: User }>("/api/session");
        if (active) setUser(data.user);
      } catch {
        if (active) setUser(null);
      }
    }

    /**
     * 收到 API 401 会话失效事件时切换到登录状态。
     */
    function expired() {
      setUser(null);
      setError("登录已失效，请重新登录。直播电脑上的直播任务不受影响并将继续运行。");
    }

    void load();
    window.addEventListener("livepilot-login-required", expired);
    return () => {
      active = false;
      window.removeEventListener("livepilot-login-required", expired);
    };
  }, []);

  /**
   * 提交登录表单，验证凭据并建立同源会话。
   *
   * @param event 表单提交事件
   */
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

  /**
   * 退出当前管理员会话，不中断正在运行的 OBS 直播。
   */
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
      <main className="login-shell">
        <div className="stat-chip">
          <span className="dot on" />
          <span role="status">正在验证 LiveNest 凭据…</span>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-header">
            <LiveNestLogo width={42} height={42} />
            <h1 id="login-title">登录 LiveNest 工作台</h1>
            <p>连接并管理多台 Windows 直播电脑与 OBS 实例</p>
          </div>

          <form onSubmit={submit} className="login-form">
            <div className="form-field">
              <label htmlFor="username" className="form-label">
                <UserIcon /> 管理员账号
              </label>
              <input
                id="username"
                name="username"
                autoComplete="username"
                pattern="[a-z0-9_]{3,32}"
                minLength={3}
                maxLength={32}
                placeholder="输入用户名"
                required
                disabled={busy}
                autoFocus
              />
            </div>

            <div className="form-field">
              <label htmlFor="password" className="form-label">
                <LockIcon /> 登录密码
              </label>
              <div className="password-input-wrap">
                <input
                  id="password"
                  name="password"
                  type={visible ? "text" : "password"}
                  autoComplete="current-password"
                  maxLength={256}
                  placeholder="输入访问密码"
                  required
                  disabled={busy}
                />
                <button
                  type="button"
                  className="password-visibility-btn"
                  onClick={() => setVisible(!visible)}
                  aria-label={visible ? "隐藏密码" : "显示密码"}
                  tabIndex={-1}
                >
                  {visible ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            {error && (
              <div className="alert-banner error" role="alert">
                <AlertCircleIcon />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn-primary-live" disabled={busy} style={{ minHeight: "48px", marginTop: "8px" }}>
              {busy ? "正在验证身份…" : "安全登录 LiveNest"}
            </button>
          </form>

          <p style={{ marginTop: "24px", fontSize: "12px", color: "var(--text-muted)", textAlign: "center" }}>
            如需新增管理员账号，请由系统管理员通过控制台命令分配。
          </p>
        </section>
      </main>
    );
  }

  return (
    <>
      <header className="top-navbar">
        <div className="top-navbar-inner">
          <div className="brand-wrapper">
            <LiveNestLogo />
            <div className="brand-text">
              <span className="brand-title">
                Live<span className="brand-title-nest">Nest</span>
              </span>
              <span className="brand-subtitle">Studio Operations</span>
            </div>
          </div>

          <div className="navbar-user-actions">
            <div className="user-badge">
              <UserIcon />
              <span>
                管理员 <strong>{user.username}</strong>
              </span>
            </div>
            <button
              type="button"
              className="btn-subtle"
              onClick={() => void exitSession()}
              disabled={busy}
              aria-label="退出当前管理会话"
            >
              <LogOutIcon />
              <span>退出</span>
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="app-container" style={{ paddingBottom: 0 }}>
          <div className="alert-banner error" role="alert">
            <AlertCircleIcon />
            <span>{error}</span>
          </div>
        </div>
      )}

      {children}
    </>
  );
}
