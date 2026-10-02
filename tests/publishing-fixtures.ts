/** 发布回归的合成任务和远端端口；不使用真实凭据或访问 Google。 */
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { defaultPolicy, PRIVACY_VERSION, jobSpecSchema, type MediaAsset } from "@/shared/publishing";
import type { VideoPort, VideoResource } from "@/core/youtube/video-api";
/** 每次生成独立 ID，Profile 明确关闭 AI 和缩略图便于隔离核心上传。 */
export function fixtureJob(asset?: MediaAsset) { return jobSpecSchema.parse({ id: randomUUID(), batchId: randomUUID(), owner: "alice", actor: "alice", revision: 1, desired: "run", asset: asset || { id: "a".repeat(64), version: "b".repeat(64), filename: "movie.mp4", size: 262150, mtimeMs: 1 }, profile: { id: randomUUID(), revision: 1, name: "Synthetic", agentId: "pc", instanceId: "main", channelId: "channel_one", titleTemplate: "{{filenameStem}}", descriptionTemplate: "Description", tags: [], categoryId: "10", playlistIds: [], privacy: "private", scheduled: false, madeForKids: false, thumbnailMode: "none", ai: { enabled: false, language: "English", prompt: "Generate", fallbackTitle: "Fallback", fallbackDescription: "Description" }, schedule: { timezone: "UTC", weekdays: [1, 3, 5, 7], localTime: "20:00", startDate: "2026-10-01", preuploadDays: 28 } }, overrides: {}, index: 1, policy: { ...defaultPolicy, enabled: true, publicVerified: true, chunkBytes: 262144 }, consent: { version: PRIVACY_VERSION, acceptedAt: Date.parse("2026-10-01T00:00:00Z"), ai: false, temporaryPrivateTitle: true } }); }
/** 有状态假端口支持独立失败注入、批量查询和 metadata 回读。 */
export function fixtureApi() {
  const videos = new Map<string, VideoResource>();
  const api = {
    begin: vi.fn(async () => "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic"),
    probe: vi.fn(async () => ({ offset: 0 })),
    chunk: vi.fn<VideoPort["chunk"]>(async (_uri, _file, offset, total, bytes) => { const end = Math.min(total, offset + bytes); if (end === total) { videos.set("video_one", { id: "video_one", snippet: { channelId: "channel_one", title: "marker" }, status: { privacyStatus: "private" }, processingDetails: { processingStatus: "processing" } }); return { offset: end, videoId: "video_one" }; } return { offset: end }; }),
    list: vi.fn(async (ids: string[]) => ids.flatMap(id => videos.has(id) ? [structuredClone(videos.get(id)!)] : [])),
    recover: vi.fn(async () => [] as string[]), thumbnail: vi.fn(async () => {}), playlist: vi.fn(async () => {}),
    finalize: vi.fn<VideoPort["finalize"]>(async (id, job, copy, publishAt) => { videos.set(id, { id, snippet: { channelId: job.profile.channelId, ...copy, categoryId: job.profile.categoryId, tags: job.profile.tags }, status: { privacyStatus: publishAt ? "private" : job.profile.privacy, publishAt, selfDeclaredMadeForKids: job.profile.madeForKids, license: job.profile.license, embeddable: job.profile.embeddable, containsSyntheticMedia: job.profile.containsSyntheticMedia }, processingDetails: { processingStatus: "succeeded" } }); }),
    unschedule: vi.fn(async (id: string) => { const v = videos.get(id); if (v?.status) delete v.status.publishAt; }),
  } satisfies VideoPort;
  return { api, videos };
}
