/** 桌面配置与云端维护共享契约；公开状态不包含设备凭据。 */
export const DESKTOP_ORIGIN = "https://livenest.duckdns.org";
export type Check = { id: string; label: string; status: "ready" | "missing" | "error" | "pending"; message?: string; action?: "retry" | "help" | "web" };
export type DesktopInstance = { id: string; name: string; managed: boolean; exe: string; port: number; password: string; initialized: boolean };
export type PublicInstance = Omit<DesktopInstance, "password">;
export type DesktopState = {
  version: string; dataRoot: string; paired: boolean; agentId?: string; agentRunning: boolean;
  online: boolean; autoStart: boolean; busy: boolean; message?: string; instances: PublicInstance[];
  activity?: DesktopActivity; checks: Check[]; snapshots: import("./remote").AgentSnapshot[];
  update: { status: string; version?: string; percent?: number; message?: string };
};
export type DesktopAction = "check" | "prepare" | "pair" | "start" | "add" | "rename" | "attach" | "repair" | "directory" | "open-data" | "autostart" | "web" | "update-check" | "update-download" | "update-install";
export type DesktopBridge = { session(): Promise<{ authenticated: boolean }>; login(username: string, password: string): Promise<{ ok: boolean; message?: string }>; logout(): Promise<void>; state(): Promise<DesktopState>; act(action: DesktopAction, input?: Record<string, unknown>): Promise<DesktopState> };

/** 后台操作反馈不含输入或凭据，切换页面和重新登录后仍可恢复。 */
export type DesktopActivity = { action: DesktopAction; step: number; status: "running" | "failed" | "complete"; stage: string; startedAt: number; message?: string };
/** 将配置操作定位到对应步骤，其他设置保留全局反馈。 */
export function activityStep(action?: DesktopAction) {
  return action === "check" ? 1 : ["prepare", "add", "attach", "rename", "repair"].includes(action || "") ? 2 : ["pair", "start"].includes(action || "") ? 3 : 0;
}
