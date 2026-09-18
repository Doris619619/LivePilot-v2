/** 页面计时基准：使用浏览器单调时钟推进，OBS 快照负责校准与停播重置。 */
export type DurationSample = { durationMs: number; running: boolean; observedAt?: number; session: string };
export type DurationAnchor = DurationSample & { baseMs: number; receivedAt: number };
const MAX_EXTRAPOLATION_MS = 20_000;

/** 最多推算 20 秒；长时间无新快照时显示未知，停止状态保持服务端时长。 */
export function readDuration(anchor: DurationAnchor | null, now: number): number | null {
  if (!anchor) return null;
  if (!anchor.running) return anchor.baseMs;
  const elapsed = Math.max(0, now - anchor.receivedAt);
  return elapsed >= MAX_EXTRAPOLATION_MS ? null : anchor.baseMs + elapsed;
}

/** 重复或迟到的 Agent 快照不重置计时；新场次或 OBS 时长归零则采用新基准。 */
export function synchronizeDuration(previous: DurationAnchor | null, sample: DurationSample, now: number): DurationAnchor {
  const sameSession = previous?.session === sample.session;
  if (previous && sameSession && previous.observedAt !== undefined && sample.observedAt !== undefined && sample.observedAt <= previous.observedAt) return previous;
  const continuing = previous && sameSession && previous.running && sample.running && sample.durationMs >= previous.durationMs;
  const baseMs = continuing ? Math.max(sample.durationMs, readDuration(previous, now) ?? sample.durationMs) : sample.durationMs;
  return { ...sample, baseMs, receivedAt: now };
}
