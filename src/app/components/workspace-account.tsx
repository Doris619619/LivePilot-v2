/** 已登录工作区共用的侧栏账户区；只传递公开身份，设置与会话继续使用原有入口。 */
"use client";
import { useContext } from "react";
import { WorkspaceUserContext } from "./workspace-user-context";
import Link from "next/link";
import { usePathname } from "next/navigation";
import AccountSwitcher from "../account-switcher";
import { ApiSettingsButton } from "./api-settings";

export { WorkspaceUserContext } from "./workspace-user-context";

/** 侧栏底部集中放置设置与头像；未登录或桌面独立界面不显示网页账户。 */
export default function WorkspaceAccount() {
  const user = useContext(WorkspaceUserContext);
  const pathname = usePathname();
  if (!user) return null;
  return <div className="workspace-account" aria-label="账户与设置">
    {user.role === "admin" && pathname !== "/admin" && <Link className="sidebar-link" href="/admin">管理员总览</Link>}
    <ApiSettingsButton className="workspace-settings-trigger"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h6m4 0h6M4 17h10m4 0h2" /><circle cx="12" cy="7" r="2" /><circle cx="16" cy="17" r="2" /></svg><span>设置</span></ApiSettingsButton>
    <AccountSwitcher user={user} placement="sidebar" />
  </div>;
}
