/** 删除反馈只使用当前修订和明确设备状态，覆盖离线、维护、恢复、真实异常及完成边界。 */
import { expect, it } from "vitest";
import { publishingRemovalFeedback } from "@/app/publishing/publishing-removal-feedback";
import { publishingOverview } from "@/app/publishing/publishing-overview";
import type { VideoJob } from "@/shared/publishing";
import { fixtureJob } from "./publishing-fixtures";
/** 取消意图高于最近排期报告；合成任务不会访问设备或 YouTube。 */
function waiting(): VideoJob { const spec = fixtureJob(); spec.desired = "cancel"; spec.revision = 2; return { spec, createdAt: 1, delivery: { id: spec.id, revision: 2 }, observed: { id: spec.id, revision: 1, sequence: 1, state: "scheduled", offset: 0, total: spec.asset.size, updatedAt: 1 } }; }
it("names explicit offline devices and replaces the message after online recovery", () => {
  const job = waiting(); const removal = { batchId: job.spec.batchId, requestedAt: 1 };
  expect(publishingRemovalFeedback(removal, [job], [{ id: "pc", online: false }])).toMatchObject({ state: "等待设备上线", message: "设备离线，打开这台电脑的 LiveNest 后会继续删除。", tone: "warning" });
  expect(publishingRemovalFeedback(removal, [job], [{ id: "pc", online: true }])).toMatchObject({ state: "删除待确认" });
});
it("does not turn unknown or missing devices into offline or call delivery allocation dispatched", () => {
  const job = waiting(); const removal = { batchId: job.spec.batchId, requestedAt: 1 };
  for (const devices of [undefined, [], [{ id: "other", online: false }]]) expect(publishingRemovalFeedback(removal, [job], devices)?.message).toBe("删除待确认。未确认前，已排期的视频仍可能公开。");
});
it("shows maintenance and keeps current retry reports distinct from upload delivery", () => {
  const job = waiting(); const removal = { batchId: job.spec.batchId, requestedAt: 1 };
  expect(publishingRemovalFeedback(removal, [job], [{ id: "pc", online: true, maintenance: true }])).toMatchObject({ state: "等待维护结束" });
  job.observed!.revision = 2; job.observed!.state = "retry_wait"; expect(publishingRemovalFeedback(removal, [job], [{ id: "pc", online: true }])).toMatchObject({ state: "取消等待重试" });
  job.observed!.state = "ready"; expect(publishingRemovalFeedback(removal, [job], [{ id: "pc", online: true }])).toMatchObject({ state: "正在取消" });
});
it.each(["failed", "needs_attention"] as const)("preserves current %s reason ahead of connection feedback but ignores its superseded revision", state => {
  const job = waiting(); const removal = { batchId: job.spec.batchId, requestedAt: 1 }; job.observed!.state = state; job.observed!.message = "精确的合成取消原因";
  expect(publishingRemovalFeedback(removal, [job], [{ id: "pc", online: false }])).toMatchObject({ state: "等待设备上线" });
  job.observed!.revision = 2; expect(publishingRemovalFeedback(removal, [job], [{ id: "pc", online: false }])).toMatchObject({ state: "删除需处理", message: "精确的合成取消原因", tone: "error" });
});
it("keeps confirmed completion exact regardless of offline state and does not infer it from cancelled reports alone", () => {
  const job = waiting(); const removal = { batchId: job.spec.batchId, requestedAt: 1 }; job.observed!.revision = 2; job.observed!.state = "cancelled";
  expect(publishingRemovalFeedback(removal, [job], [{ id: "pc", online: false }])?.state).toBe("删除待确认");
  expect(publishingRemovalFeedback({ ...removal, completedAt: 2 }, [job], [{ id: "pc", online: false }])).toEqual({ state: "已移出总览", message: "已移出总览，视频和素材保留。", tone: "success" });
  expect(publishingRemovalFeedback(undefined, [job])).toBeUndefined();
});
it("excludes already public jobs on an unrelated offline device from the remaining cancellation feedback", () => {
  const job = waiting(); const published = waiting(); published.spec.batchId = job.spec.batchId; published.spec.profile.agentId = "other"; published.observed!.revision = 2; published.observed!.state = "published";
  expect(publishingRemovalFeedback({ batchId: job.spec.batchId, requestedAt: 1 }, [job, published], [{ id: "pc", online: true }, { id: "other", online: false }])?.state).toBe("删除待确认");
});
it("feeds the same short feedback to the overview and removes only Cloud-confirmed markers", () => {
  const job = waiting(); const removal = { batchId: job.spec.batchId, requestedAt: 1 }; const devices = [{ id: "pc", online: false }];
  const overview = publishingOverview([], [job], [], 1, [removal], devices); expect(overview[0].batches[0]).toMatchObject({ state: "等待设备上线", removalFeedback: { message: "设备离线，打开这台电脑的 LiveNest 后会继续删除。" } });
  expect(publishingOverview([], [job], [], 1, [{ ...removal, completedAt: 2 }], devices)).toEqual([]);
});
it.each(["invalid-authorization", "public-cancellation", "scheduled-private-completion"])("does not hide unsafe %s evidence or label its terminal result currently cancelling", boundary => {
  const job = waiting(); job.observed!.revision = job.spec.revision;
  if (boundary === "invalid-authorization") { job.observed!.state = "published"; job.observed!.authorizationInvalid = true; }
  else if (boundary === "public-cancellation") { job.observed!.state = "cancelled"; job.observed!.observedPrivacy = "public"; }
  else { job.spec.profile.scheduled = true; job.spec.profile.privacy = "private"; job.observed!.state = "completed"; job.observed!.observedPrivacy = "private"; }
  expect(publishingRemovalFeedback({ batchId: job.spec.batchId, requestedAt: 1 }, [job], [{ id: "pc", online: true }])).toMatchObject({ state: "删除需处理", tone: "error" });
});
