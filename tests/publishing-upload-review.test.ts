/** 上传预检回归：已完成可主动再次发布，未知结果仍阻止建立新的上传，不执行真实上传。 */
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

it("offers published materials for explicit republishing even after overview removal or a changed file version", () => {
  const { old, pkg, review } = fixture();
  expect(review().blockers).toEqual([]);
  expect(review().repeats).toEqual([{ packageId: pkg.id, name: "001", version: pkg.version, jobIds: [old.spec.id], label: "已发布", videoId: "v1" }]);
  pkg.version = "c".repeat(64);
  expect(review().replacements).toEqual([]); expect(review().repeats[0].version).toBe(pkg.version);
  old.observed!.state = "completed"; expect(review().repeats[0].label).toBe("已完成");
});

it("does not block explicitly excluded packages or packages with no previous task", () => {
  const { review } = fixture();
  expect(review([], false)).toEqual({ blockers: [], replacements: [], repeats: [] });
  expect(review(undefined, true)).toEqual({ blockers: [], replacements: [], repeats: [] });
});

it("matches the same device and channel across different authorization accounts and instances", () => {
  const { spec, old, review } = fixture();
  old.spec = { ...old.spec, profile: { ...spec.profile, instanceId: "other", accountId: "00000000-0000-4000-8000-000000000005" } };
  expect(review().repeats).toHaveLength(1);
  old.spec.profile.channelId = "another_channel"; expect(review().repeats).toHaveLength(0);
  old.spec.profile.channelId = spec.profile.channelId; old.spec.profile.agentId = "another_device"; expect(review().repeats).toHaveLength(0);
});

it("allows a confirmed never-uploaded cancellation without demanding a new version", () => {
  const { old, review } = fixture(); old.observed!.state = "cancelled"; old.hadUpload = false;
  expect(review()).toEqual({ blockers: [], replacements: [], repeats: [] });
});

it("requires an explicitly confirmed replacement for a changed version after uploaded cancellation", () => {
  const { old, pkg, review } = fixture(); old.observed!.state = "cancelled";
  expect(review().blockers[0].reason).toBe("unchanged");
  pkg.version = "c".repeat(64);
  expect(review()).toEqual({ blockers: [], replacements: [old.spec.id], repeats: [] });
});

it("does not treat a stale cancellation or unknown upload result as safe for replacement", () => {
  const { old, pkg, review } = fixture(); old.spec.desired = "cancel"; old.spec.revision++; old.observed!.state = "cancelled"; pkg.version = "c".repeat(64);
  expect(review().blockers[0].reason).toBe("cancelling"); expect(review().replacements).toEqual([]);
  old.observed!.state = "needs_attention"; old.observed!.revision = old.spec.revision;
  expect(review().blockers[0].reason).toBe("cancelling"); expect(review().replacements).toEqual([]);
});

it("retains uploaded evidence when API metadata expires and blocks uncertain history even alongside a published result", () => {
  const { old, review } = fixture(); const cancelled = structuredClone(old); cancelled.spec.id = "00000000-0000-4000-8000-000000000006"; cancelled.observed!.state = "cancelled"; delete cancelled.observed!.videoId;
  expect(review([cancelled]).blockers[0].reason).toBe("unchanged");
  expect(review([cancelled, old]).blockers[0].reason).toBe("unchanged");
  expect(review([cancelled, old]).repeats).toEqual([]);
});

it("requires every earlier completed upload to be included in deliberate third-time publishing", () => {
  const { old, review } = fixture(); const second = structuredClone(old); second.spec.id = "00000000-0000-4000-8000-000000000007"; second.observed!.id = second.spec.id;
  expect(review([second, old]).repeats[0].jobIds).toEqual([old.spec.id, second.spec.id].sort());
  expect(review([second, old]).blockers).toEqual([]);
});

it("does not offer stale, authorization-invalid or in-progress uploads as repeat candidates", () => {
  const { old, review } = fixture(); old.spec.revision++;
  expect(review().repeats).toEqual([]); expect(review().blockers).toHaveLength(1);
  old.observed!.revision = old.spec.revision; old.observed!.authorizationInvalid = true;
  expect(review().repeats).toEqual([]);
  old.observed!.authorizationInvalid = false;
  for (const state of ["uploading", "processing", "finalizing", "scheduled", "needs_attention"] as const) {
    old.observed!.state = state; expect(review().repeats).toEqual([]); expect(review().blockers).toHaveLength(1);
  }
});

it("does not confuse a private scheduled completed report with a published result or authorize another owner", () => {
  const { old, pkg, review } = fixture(); old.spec.profile.privacy = "public"; old.spec.profile.scheduled = true; old.observed!.state = "completed"; old.observed!.observedPrivacy = "private";
  expect(review().repeats).toEqual([]); expect(review().blockers).toHaveLength(1);
  old.observed!.state = "published";
  expect(publishingUploadReview(old.spec.profile, [pkg], [{ packageId: pkg.id, excluded: false }], [old], "other").repeats).toEqual([]);
});
