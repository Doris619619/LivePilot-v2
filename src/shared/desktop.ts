/** 桌面配置与云端维护共享契约；公开状态不包含设备凭据。 */
import type { Problem } from "./problems";
export const DESKTOP_ORIGIN = "https://livenest.duckdns.org";
export type Check = { id: string; label: string; status: "ready" | "missing" | "error" | "pending"; message?: string; instanceId?: string; code?: string; checkedAt?: number; action?: "retry" | "help" | "web" | "launch" | "repair" | "firewall" };
export type DesktopInstance = { id: string; name: string; managed: boolean; exe: string; port: number; password: string; initialized: boolean; sourceExe?: string };
export type PublicInstance = Omit<DesktopInstance, "password">;
export type DesktopState = { problems?: Problem[];
  dataLocationReady?: boolean; archivedCandidates?: PublicInstance[]; scan?: ObsScan; dataNotice?: string; version: string; dataRoot: string; paired: boolean; agentId?: string; agentRunning: boolean;
  online: boolean; autoStart: boolean; busy: boolean; message?: string; connectionError?: string; instances: PublicInstance[];
  candidates?: PublicInstance[]; maintenance?: boolean; activity?: DesktopActivity; checks: Check[]; snapshots: import("./remote").AgentSnapshot[];
  update: { problem?: Problem; stage?: "check" | "download" | "install"; automatic?: boolean; status: string; version?: string; percent?: number; message?: string };
};
export type ObsCandidate = { exe: string; version: string; running: boolean; processKnown?: boolean; attached: boolean; error?: string };
export type ObsScan = { running: boolean; canceled: boolean; deep: boolean; results: ObsCandidate[]; drives: string[]; completedDrives: string[]; inaccessible: string[]; visited: number; current?: string; error?: string };
export type DesktopAction = "unpair" | "restore-candidate" | "scan" | "scan-cancel" | "import-obs" | "firewall" | "diagnose-obs" | "check" | "prepare" | "pair" | "start" | "add" | "rename" | "attach" | "repair" | "repair-managed" | "discard" | "directory" | "open-data" | "autostart" | "web" | "update-check" | "update-download" | "update-install" | "update-apply";
export type DesktopResult = { ok: true; state: DesktopState; cancelled?: boolean } | { ok: false; problem: Problem; fields?: Record<string,string> };
export type LocalUpdateState = Pick<DesktopState, "version" | "busy" | "update">;
export type UpdateCommand = "update-check" | "update-download" | "update-install" | "update-apply";
export type LocalUpdateResult = { ok: boolean; state: LocalUpdateState; cancelled?: boolean; problem?: Problem };
export type DesktopBridge = { readState?(): Promise<DesktopResult>; copyProblem?(problem: Problem): Promise<boolean>; session(): Promise<{ authenticated: boolean; username?: string }>; login(username: string, password: string): Promise<{ ok: boolean; message?: string }>; logout(): Promise<void>; state(): Promise<DesktopState>; act(action: DesktopAction, input?: Record<string, unknown>): Promise<DesktopResult>; updateState(): Promise<LocalUpdateState>; update(action: UpdateCommand): Promise<LocalUpdateResult> };

/** 后台操作反馈不含输入或凭据，切换页面和重新登录后仍可恢复。 */
export type DesktopActivity = { problem?: Problem; attemptId?: string; instanceId?: string; action: DesktopAction; step: number; status: "running" | "failed" | "complete" | "cancelled"; stage: string; startedAt: number; message?: string };
/** 将配置操作定位到对应步骤，其他设置保留全局反馈。 */
export function activityStep(action?: DesktopAction) {
  return action === "check" ? 1 : ["diagnose-obs", "restore-candidate", "prepare", "add", "attach", "import-obs", "rename", "repair", "repair-managed", "discard"].includes(action || "") ? 2 : ["pair", "start"].includes(action || "") ? 3 : 0;
}
