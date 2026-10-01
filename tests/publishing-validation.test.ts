/** 元数据、时区、AI 兜底和政策的离线回归，Unicode 真实 API 校准另行验收。 */
import { expect, it, vi, afterEach } from "vitest";
import { videoTitleSchema, videoDescriptionSchema, videoTagsSchema, titleCharacters, tagCharacters } from "@/shared/video-metadata";
import { scheduleSlots, effectivePublishAt, quotaDay } from "@/core/publishing/schedule";
import { defaultPolicy, jobSpecSchema, policySchema } from "@/shared/publishing";
import { publishingMetadata, expandTemplate } from "@/core/publishing/metadata";
import { Store } from "@/core/storage";
import { fixtureJob } from "./publishing-fixtures";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(["x", "中", "🌙"])("allows 100 code points and rejects 101 (%s)", char => { expect(videoTitleSchema.safeParse(char.repeat(100)).success).toBe(true); expect(videoTitleSchema.safeParse(char.repeat(101)).success).toBe(false); });
it.each([["🇨🇳", 2], ["👩‍💻", 3], ["é", 2]])("counts constituent code points of %s", (text, count) => { expect(titleCharacters(String(text))).toBe(count); });
it("rejects isolated surrogates, empty titles and angle brackets without truncation", () => { for (const v of ["\ud800", " ", "<bad>"]) expect(videoTitleSchema.safeParse(v).success).toBe(false); });
it("uses 5000 UTF-8 bytes for description", () => { expect(videoDescriptionSchema.safeParse("🌙".repeat(1250)).success).toBe(true); expect(videoDescriptionSchema.safeParse("🌙".repeat(1250) + "a").success).toBe(false); expect(videoDescriptionSchema.safeParse("中".repeat(1667)).success).toBe(false); });
it("counts commas and quoted space-containing tags without an artificial 100-tag cap", () => { expect(tagCharacters(["lofi beats", "jazz"])).toBe(17); expect(videoTagsSchema.safeParse(Array(200).fill("a")).success).toBe(true); expect(videoTagsSchema.safeParse(["a".repeat(501)]).success).toBe(false); });
it("skips the DST gap and chooses the first overlapping occurrence", () => {
  const schedule = { ...fixtureJob().profile.schedule, timezone: "America/New_York", weekdays: [7], localTime: "02:30", startDate: "2026-03-08" };
  const gap = scheduleSlots(schedule, 1, Date.parse("2026-03-01T00:00:00Z")); expect(gap.skipped).toHaveLength(1); expect(gap.slots[0].publishAt).toBe("2026-03-15T06:30:00Z");
  const overlap = scheduleSlots({ ...schedule, localTime: "01:30", startDate: "2026-11-01" }, 1, Date.parse("2026-10-01T00:00:00Z")); expect(overlap.slots[0]).toMatchObject({ publishAt: "2026-11-01T05:30:00Z", overlapping: true });
});
it("moves only a late job and uses Pacific quota reset dates", () => { const now = Date.parse("2026-10-01T06:59:00Z"); expect(quotaDay(now)).toBe("2026-09-30"); expect(quotaDay(now + 60000)).toBe("2026-10-01"); expect(effectivePublishAt("2026-09-01T00:00:00Z", 600, now)).toBe("2026-10-01T07:09:00.000Z"); });
it("keeps configurable product defaults and requires explicit AI consent", () => { expect(defaultPolicy).toMatchObject({ enabled: false, publicVerified: false, uploadsPerDay: 20, uploadMbps: 20, liveUploadMbps: 5, publishLeadSeconds: 600 }); expect(policySchema.parse({ chunkBytes: 262144 }).chunkBytes).toBe(262144); expect(policySchema.safeParse({ chunkBytes: 999999 }).success).toBe(false); const job = fixtureJob(); job.profile.ai.enabled = true; expect(jobSpecSchema.safeParse(job).success).toBe(false); });
it("supports explicit manual copy and rejects unknown template expressions", async () => { const job = fixtureJob(); job.overrides = { title: "🌙".repeat(100), description: "Manual" }; expect(await publishingMetadata(new Store("unused"), job)).toMatchObject({ source: "override", copy: job.overrides }); expect(() => expandTemplate("{{secret}}", job)).toThrow("不支持"); });
it("falls back without SMTP or AI credentials and refuses an invalid fallback", async () => { vi.stubEnv("DEEPSEEK_API_KEY", ""); const storage = { read: async () => null } as unknown as Store; const job = fixtureJob(); job.profile.ai.enabled = true; job.consent.ai = true; const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); expect(await publishingMetadata(storage, job)).toMatchObject({ source: "fallback", copy: { title: "Fallback", description: "Description" } }); expect(fetcher).not.toHaveBeenCalled(); job.profile.ai.fallbackTitle = "x".repeat(101); await expect(publishingMetadata(storage, job)).rejects.toMatchObject({ code: "METADATA" }); });
