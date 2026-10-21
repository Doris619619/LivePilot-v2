/** 管理员显示口径回归：PT 日期、已知参数与预测不冒充 Google 实际扣额。 */
import { expect, it } from "vitest";
import { eventCostLabel, exhaustionLabel, pacificToday, usageQuery } from "@/app/admin/youtube-usage-model";
import { defaultYouTubePolicy, type YouTubeUsageSummary } from "@/shared/youtube-usage";
const summary: YouTubeUsageSummary = { project: "fixture", day: "2026-10-20", costVersion: "fixture", policy: defaultYouTubePolicy, policyRevision: 0, baseline: { known: true, units: 0, uploads: 0 }, usedUnits: 10, uploads: 0, reservedUnits: 0, remainingUnits: 8990, byPurpose: {}, byMethod: {}, coverage: { protected: 0, total: 0, devices: [] }, totals: { attempts: 0, failures: 0, cacheHits: 0, blocked: 0 }, ranking: [], minutes: [], incomplete: false, droppedEvents: 0 };
it("uses the Pacific quota day on both sides of reset and DST", () => {
  expect(pacificToday(Date.parse("2026-10-20T06:59:59Z"))).toBe("2026-10-19");
  expect(pacificToday(Date.parse("2026-10-20T07:00:00Z"))).toBe("2026-10-20");
  expect(pacificToday(Date.parse("2026-12-20T07:59:59Z"))).toBe("2026-12-19");
  expect(pacificToday(Date.parse("2026-12-20T08:00:00Z"))).toBe("2026-12-20");
});
it("preserves shared filters and omits the empty cursor for exports", () => {
  expect(usageQuery({ day: "2026-10-20", agentId: "device_a", method: "channels.list", cursor: undefined, outcome: "" })).toBe("day=2026-10-20&agentId=device_a&method=channels.list");
});
it("marks unknown baselines and absent consumption without invented estimates", () => {
  expect(exhaustionLabel({ ...summary, baseline: { ...summary.baseline, known: false } })).toBe("基线未知");
  expect(exhaustionLabel(summary)).toBe("暂无持续消耗");
  expect(exhaustionLabel({ ...summary, remainingUnits: 0 })).toBe("预算已用完");
});
it("derives an explicitly approximate prediction from recent recorded usage", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  expect(exhaustionLabel({ ...summary, remainingUnits: 30, minutes: [{ minute: now - 60_000, attempts: 30, units: 30 }] }, now)).toBe("约 2 分钟");
});
it("does not present finishing or separate quota buckets as unverified general units", () => {
  expect(eventCostLabel({ kind: "finish", method: "channels.list", estimatedUnits: null })).toBe("—");
  expect(eventCostLabel({ kind: "start", method: "channels.list", estimatedUnits: 1 })).toBe("1");
  expect(eventCostLabel({ kind: "start", method: "videos.insert", estimatedUnits: null })).toBe("上传桶 1 次");
  expect(eventCostLabel({ kind: "start", method: "search.list", estimatedUnits: null })).toBe("搜索桶 1 次");
  expect(eventCostLabel({ kind: "start", method: "videos.upload.chunk", estimatedUnits: null })).toBe("独立成本未核实");
});
