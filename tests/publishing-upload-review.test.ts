/** 上传预检回归：匹配 Cloud 的历史范围、取消修订及版本规则，不执行真实上传。 */
import { expect, it } from "vitest";
import type { ContentPackage, VideoJob } from "@/shared/publishing";
import { publishingUploadReview } from "@/app/publishing/publishing-upload-review";
import { fixtureJob } from "./publishing-fixtures";

/** 保留同一包身份，可独立构造旧版本或不同设备与账号的历史。 */
function fixture() {
  const spec = fixtureJob();
  const pkg: ContentPackage = { id: "a".repeat(64), batchName: "我的第一批次", name: "001", version: "b".repeat(64), sourceVideo: spec.asset, validationState: "valid", issues: [] };
  spec.contentPackage = { ...pkg };
  const old: VideoJob = { spec, createdAt: 1, hadUpload: true, observed: { id: spec.id, revision: spec.revision, sequence: 1, state: "published", videoId: "v1", offset: spec.asset.size, total: spec.asset.size, updatedAt: 1 } };
  const review = (jobs = [old], excluded = false) => publishingUploadReview(spec.profile, [pkg], [{ packageId: pkg.id, excluded }], jobs);
  return { spec, pkg, old, review };
}

it("keeps published history blocking after overview removal and even a changed file version", () => {
  const { old, pkg, review } = fixture();
  expect(review().blockers).toEqual([{ packageId: pkg.id, name: "001", reason: "published", label: "已在此频道公开", videoId: "v1" }]);
  pkg.version = "c".repeat(64);
  expect(review().replacements).toEqual([]); expect(review().blockers).toHaveLength(1);
  old.observed!.state = "completed"; expect(review().blockers[0].reason).toBe("uploaded");
});

it("does not block explicitly excluded packages or packages with no previous task", () => {
  const { review } = fixture();
  expect(review([], false)).toEqual({ blockers: [], replacements: [] });
  expect(review(undefined, true)).toEqual({ blockers: [], replacements: [] });
});

it("matches the same device and channel across different authorization accounts and instances", () => {
  const { spec, old, review } = fixture();
  old.spec = { ...old.spec, profile: { ...spec.profile, instanceId: "other", accountId: "00000000-0000-4000-8000-000000000005" } };
  expect(review().blockers).toHaveLength(1);
  old.spec.profile.channelId = "another_channel"; expect(review().blockers).toHaveLength(0);
  old.spec.profile.channelId = spec.profile.channelId; old.spec.profile.agentId = "another_device"; expect(review().blockers).toHaveLength(0);
});

it("allows a confirmed never-uploaded cancellation without demanding a new version", () => {
  const { old, review } = fixture(); old.observed!.state = "cancelled"; old.hadUpload = false;
  expect(review()).toEqual({ blockers: [], replacements: [] });
});

it("requires an explicitly confirmed replacement for a changed version after uploaded cancellation", () => {
  const { old, pkg, review } = fixture(); old.observed!.state = "cancelled";
  expect(review().blockers[0].reason).toBe("unchanged");
  pkg.version = "c".repeat(64);
  expect(review()).toEqual({ blockers: [], replacements: [old.spec.id] });
});

it("does not treat a stale cancellation or unknown upload result as safe for replacement", () => {
  const { old, pkg, review } = fixture(); old.spec.desired = "cancel"; old.spec.revision++; old.observed!.state = "cancelled"; pkg.version = "c".repeat(64);
  expect(review().blockers[0].reason).toBe("cancelling"); expect(review().replacements).toEqual([]);
  old.observed!.state = "needs_attention"; old.observed!.revision = old.spec.revision;
  expect(review().blockers[0].reason).toBe("cancelling"); expect(review().replacements).toEqual([]);
});

it("retains uploaded evidence when API metadata expires and prioritizes published over other history", () => {
  const { old, review } = fixture(); const cancelled = structuredClone(old); cancelled.spec.id = "00000000-0000-4000-8000-000000000006"; cancelled.observed!.state = "cancelled"; delete cancelled.observed!.videoId;
  expect(review([cancelled]).blockers[0].reason).toBe("unchanged");
  expect(review([cancelled, old]).blockers[0].reason).toBe("published");
});
