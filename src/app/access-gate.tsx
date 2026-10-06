/* 文件用途：LiveNest 登录门禁、会话反馈与工作台顶栏；账号凭据仅提交到服务端。 */

"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api, setRequestMember } from "./client-request";
import AccountSwitcher, { listenAccountChanges, notifyAccountChange } from "./account-switcher";
import { LiveNestLogo, UserIcon, LockIcon, EyeIcon, EyeOffIcon, AlertCircleIcon } from "./components/icons";

type User = { username: string; role: "admin" | "customer" };

/**
 * LiveNest 登录入口与状态门禁。
 */
export default function AccessGate({ children }: { children: ReactNode }) {
  const pathname = usePathname(); const router = useRouter();
  const [user, setUser] = useState<User | null>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const data = await api<{ user: User }>("/api/session");
        if (active) { setRequestMember(data.user.username); setUser(data.user); }
      } catch (e) {
        if (active) {
          setRequestMember(); setUser(null);
          if ((e as { status?: number }).status !== 401) setError((e as Error).message);
        }
      }
    }

    function expired() {
      setRequestMember(); setUser(null);
      setError("登录已失效，请重新登录。直播电脑上的直播不受影响。");
    }

    void load();
    const stopListening = listenAccountChanges();
    window.addEventListener("livepilot-login-required", expired);
    return () => {
      active = false;
      window.removeEventListener("livepilot-login-required", expired);
      stopListening(); setRequestMember();
    };
  }, []);

  useEffect(() => { if (!user) return; if (pathname === "/" || (pathname === "/admin" && user.role !== "admin")) router.replace((user.role === "admin" ? "/admin" : "/workspace")+window.location.search+window.location.hash); }, [user, pathname, router]);

  /** 提交成员凭据，验证期间禁用重复提交；失败保留表单供修改。 */
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
      setRequestMember(result.user.username); setUser(result.user); notifyAccountChange();
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
        <div className="login-brand"><LiveNestLogo width={28} height={28} /><span>LiveNest</span><span className="login-brand-caption">工作台</span></div>
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-head">
            <div className="login-mark"><LiveNestLogo width={32} height={32} /></div>
            <h1 id="login-title">LiveNest 控制台</h1>
            <p>登录工作台，管理你的设备与直播频道。</p>
          </div>

          <form onSubmit={submit} className="login-form" aria-busy={busy}>
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
                  type="text"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="input-with-icon"
                  autoComplete="username"
                  pattern="[A-Za-z0-9_]{2,32}"
                  minLength={2}
                  maxLength={32}
                  placeholder="输入成员账号"
                  title="2–32 位字母、数字或下划线，区分大小写"
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
                  aria-pressed={visible}
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

            <button type="submit" className="btn-primary login-submit" disabled={busy}>
              {busy ? "验证中…" : "登录"}
            </button>
          </form>
          <p className="login-help"><LockIcon /> 仅限已授权成员访问</p>
          <AccountSwitcher />
        </section>
        <footer className="login-footer"><span>LiveNest Studio</span><Link href="/download">下载 Windows 客户端 ↗</Link></footer>
      </main>
    );
  }

  return (
    <>
      <a className="skip-link" href="#workspace">跳转到工作台</a>
      <header className="app-header">
        <div className="header-container">
          <div className="brand-section">
            <LiveNestLogo />
            <span className="brand-name">LiveNest</span>
            <span className="brand-tag">Studio</span>
          </div>

          <div className="header-actions"><Link href={pathname === "/publishing" ? "/workspace" : "/publishing"}>{pathname === "/publishing" ? "直播工作台" : "视频发布"}</Link>{user.role === "admin" && <Link href="/admin">管理员总览</Link>}
            <AccountSwitcher user={user} />
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
