/** 浏览器共享的状态与媒体选择类型，禁止添加服务端 Secret。 */
import type { Problem } from "./problems";
import type { BroadcastDetails } from "./broadcast";
export type Selection = { video: string; music: string; videoAudio: boolean; broadcast?: BroadcastDetails };
export type ObsStatus = {
  problem?: Problem; processKnown?: boolean; ready: boolean; running: boolean; streaming: boolean | null; reconnecting?: boolean;
  durationMs?: number; scene?: string; version?: string; message?: string;
};
export type ControlState = {
  phase: "idle" | "starting" | "live" | "stopping" | "stopped" | "error";
  stage: string; error?: string; channelId?: string; broadcastId?: string; streamId?: string;
  broadcastTitle?: string; streamTitle?: string; broadcastIntent?: boolean; streamIntent?: boolean;
  detailsApplied?: boolean; obsStartRequested?: boolean; selection?: Selection; startedAt?: string; updatedAt: string;
};
/** 最近控制命令的真实受理与执行状态，不等同于直播 lifecycle。 */
export type CommandStatus = { problem?: Problem; id: string; action: string; actor: string; status: "accepted" | "running" | "succeeded" | "failed" | "interrupted" | "queued" | "delivering" | "uncertain" | "expired"; updatedAt: string; message?: string };
export type Dashboard = { problems?: Problem[];
  device?: { agentId: string; name: string; online: boolean; lastSeen: number; observedAt?: number };
  operation?: CommandStatus;
  state: ControlState; busy: boolean; obs: ObsStatus;
  youtube: { problem?: Problem; authorization?: "missing" | "present" | "invalid"; query?: "ready" | "failed"; connected: boolean; channel?: string; channelId?: string; ingest?: string; lifecycle?: string; checkedAt?: string; error?: string };
  media: { problems?: Problem[]; videos: string[]; music: string[]; error?: string };
  configuration: { broadcastDetails?: boolean; missing: string[]; privacy: string; madeForKids: boolean };
};

/** 浏览器可见的实例清单，不包含路径或凭据。 */
export type InstanceDescriptor = { id: string; name: string; agentId?: string; agentName?: string };
