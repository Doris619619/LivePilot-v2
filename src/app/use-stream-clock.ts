/** 将 OBS 状态同步与页面逐秒计时分开，不增加网络请求或影响直播控制。 */
"use client";
import { useCallback, useEffect, useState } from "react";
import type { Dashboard } from "@/shared/types";
import { readDuration, synchronizeDuration, type DurationAnchor } from "./stream-clock";

/** 每个实例持有独立基准；计时器延迟或标签页恢复时按实际经过时间补齐。 */
export function useStreamClock() {
  const [anchor, setAnchor] = useState<DurationAnchor | null>(null);
  const [now, setNow] = useState(0);
  const clear = useCallback(() => setAnchor(null), []);
  const synchronize = useCallback((data: Dashboard) => {
    const time = performance.now();
    const measured = data.obs.durationMs;
    if ((data.device && !data.device.online) || data.obs.streaming === null ||
        (data.obs.streaming && (!data.obs.ready || measured === undefined)) ||
        (measured !== undefined && (!Number.isFinite(measured) || measured < 0))) {
      setAnchor(null);
    } else {
      setAnchor(previous => synchronizeDuration(previous, {
        durationMs: measured ?? 0,
        running: data.obs.streaming === true && !data.obs.reconnecting,
        observedAt: data.device?.observedAt,
        session: [data.state.broadcastId || "", data.state.startedAt || ""].join(":"),
      }, time));
    }
    setNow(time);
  }, []);

  const ticking = anchor?.running === true;
  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(performance.now());
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [ticking]);

  return { durationMs: readDuration(anchor, now), synchronize, clear };
}
