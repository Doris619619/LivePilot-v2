/** 桌面 OBS 启动的公开进度；仅包含阶段与脱敏观测，不包含连接参数。 */
export const OBS_STARTUP_TIMEOUT_MS = 60_000;
export const OBS_STARTUP_SLOW_MS = 30_000;
export const OBS_OBSERVATION_FRESH_MS = 20_000;
export type ObsStartupPhase = "process" | "control" | "verify" | "ready";
export type ObsStartupProgress = {
  phase: ObsStartupPhase;
  deadlineAt: number;
  lastProbeAt?: number;
  observation?: string;
  probeCount: number;
};
export const obsStartupLabels: Record<ObsStartupPhase, string> = {
  process: "正在检查并启动 OBS",
  control: "OBS 已运行，正在连接控制服务",
  verify: "控制服务已回应，正在确认 OBS 状态",
  ready: "OBS 控制已连接",
};
