/** 桌面配置与云端维护共享契约；公开状态不包含设备凭据。 */
export const DESKTOP_ORIGIN = "https://livenest.duckdns.org";
export type Check = { id: string; label: string; status: "ready" | "missing" | "error" | "pending"; message?: string; action?: "retry" | "help" | "web" };
export type DesktopInstance = { id: string; name: string; managed: boolean; exe: string; port: number; password: string; initialized: boolean };
export type PublicInstance = Omit<DesktopInstance, "password">;
export type DesktopState = {
  version: string; dataRoot: string; paired: boolean; agentId?: string; agentRunning: boolean;
  online: boolean; autoStart: boolean; busy: boolean; message?: string; instances: PublicInstance[];
  checks: Check[]; snapshots: import("./remote").AgentSnapshot[];
  update: { status: string; version?: string; percent?: number; message?: string };
};
export type DesktopAction = "check" | "prepare" | "pair" | "start" | "add" | "rename" | "attach" | "repair" | "directory" | "autostart" | "web" | "update-check" | "update-download" | "update-install";
export type DesktopBridge = { session(): Promise<{ authenticated: boolean }>; login(username: string, password: string): Promise<{ ok: boolean; message?: string }>; logout(): Promise<void>; state(): Promise<DesktopState>; act(action: DesktopAction, input?: Record<string, unknown>): Promise<DesktopState> };
