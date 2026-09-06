export type Selection = { video: string; music: string; videoAudio: boolean };
export type ObsStatus = {
  ready: boolean; running: boolean; streaming: boolean | null; reconnecting?: boolean;
  durationMs?: number; scene?: string; version?: string; message?: string;
};
export type ControlState = {
  phase: "idle" | "starting" | "live" | "stopping" | "stopped" | "error";
  stage: string; error?: string; channelId?: string; broadcastId?: string; streamId?: string;
  broadcastTitle?: string; streamTitle?: string; broadcastIntent?: boolean; streamIntent?: boolean;
  obsStartRequested?: boolean; selection?: Selection; startedAt?: string; updatedAt: string;
};
export type Dashboard = {
  state: ControlState; busy: boolean; obs: ObsStatus;
  youtube: { connected: boolean; channel?: string; ingest?: string; lifecycle?: string; checkedAt?: string; error?: string };
  media: { videos: string[]; music: string[]; error?: string };
  configuration: { missing: string[]; privacy: string; madeForKids: boolean };
};
