/** 验证轮询间的逐秒时钟、重复快照、后台恢复与真实停播/重启边界。 */
import { expect, it } from "vitest";
import { readDuration, synchronizeDuration, type DurationSample } from "@/app/stream-clock";
const sample: DurationSample = { durationMs: 60_000, running: true, observedAt: 100, session: "broadcast-a" };
it("advances through a five-second polling gap and catches up after delayed ticks", () => {
  const anchor = synchronizeDuration(null, sample, 1000);
  expect([2000, 3000, 4000, 6000].map(now => readDuration(anchor, now))).toEqual([61000, 62000, 63000, 65000]);
  expect(readDuration(anchor, 12500)).toBe(71500);
});
it("does not move backward on duplicate snapshots or small delivery delays", () => {
  const anchor = synchronizeDuration(null, sample, 1000);
  const duplicate = synchronizeDuration(anchor, sample, 6000);
  expect(readDuration(duplicate, 6000)).toBe(65000);
  const next = synchronizeDuration(duplicate, { ...sample, durationMs: 64000, observedAt: 200 }, 6500);
  expect(readDuration(next, 6500)).toBe(65500);
  expect(readDuration(next, 7500)).toBe(66500);
  expect(synchronizeDuration(next, sample, 8000)).toEqual(next);
});
it("stops extrapolation when snapshots are stale even if duplicate responses keep arriving", () => {
  let anchor = synchronizeDuration(null, sample, 1000);
  anchor = synchronizeDuration(anchor, sample, 18000);
  expect(readDuration(anchor, 21000)).toBeNull();
  expect(readDuration(synchronizeDuration(anchor, { ...sample, durationMs: 100000, observedAt: 300 }, 41000), 41000)).toBe(100000);
});
it("freezes stopped and reconnecting samples and resets when OBS or the broadcast restarts", () => {
  const anchor = synchronizeDuration(null, sample, 1000);
  const stopped = synchronizeDuration(anchor, { ...sample, running: false, durationMs: 65000, observedAt: 200 }, 6000);
  expect(readDuration(stopped, 16000)).toBe(65000);
  expect(readDuration(synchronizeDuration(anchor, { ...sample, durationMs: 500, observedAt: 300 }, 8000), 9000)).toBe(1500);
  expect(readDuration(synchronizeDuration(anchor, { ...sample, session: "broadcast-b", durationMs: 1000 }, 8000), 9000)).toBe(2000);
});
it("keeps local instances independent without Agent timestamps and never uses a wall clock", () => {
  const local = synchronizeDuration(null, { ...sample, observedAt: undefined }, 1000);
  const other = synchronizeDuration(null, { ...sample, durationMs: 10000 }, 3000);
  expect(readDuration(local, 4000)).toBe(63000);
  expect(readDuration(other, 4000)).toBe(11000);
  expect(readDuration(local, 500)).toBe(60000);
  expect(readDuration(null, 4000)).toBeNull();
});
