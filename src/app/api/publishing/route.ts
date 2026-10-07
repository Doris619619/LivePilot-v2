/** 网页发布入口共用账号、同源和设备权限；仅接受发布业务白名单，不传输视频文件。 */
import { z } from "zod";
import { authenticate } from "@/server/access";
import { guard, failed } from "@/server/http";
import { readJson } from "@/server/request-body";
import { cloudMode } from "@/core/config";
import { AppError } from "@/core/errors";
import { profileSchema, policySchema, itemOverrideSchema, planRuleSchema, planItemSchema } from "@/shared/publishing";
import { idSchema, uuidSchema } from "@/shared/remote";
import { publishingView, publishingAssets, publishingPackages, previewPublishingPlan, updatePublishingPlan, previewPublishingReschedule, confirmPublishingReschedule, confirmPublishingPlan, archivePublishingPlan, removePublishingBatch, acceptPublishingPrivacy, savePublishingProfile, previewPublishingBatch, confirmPublishingBatch, changePublishingJob, savePublishingPolicy, requestPublishingCleanup, createPublishingAccount, connectPublishingAccount, requestPublishingAccountCleanup, publishingAccountPlaylists } from "@/cloud/publishing";
import { oauthCookie } from "@/cloud/oauth";
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("consent"), version: z.string().max(40) }).strict(),
  z.object({ action: z.literal("account-create"), agentId: idSchema, instanceId: idSchema, name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("account-connect"), accountId: uuidSchema }).strict(),
  z.object({ action: z.literal("account-cleanup"), accountId: uuidSchema, confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("account-playlists"), accountId: uuidSchema }).strict(),
  z.object({ action: z.literal("assets"), agentId: idSchema, instanceId: idSchema, accountId: uuidSchema.optional() }).strict(),
  z.object({ action: z.literal("packages"), agentId: idSchema, instanceId: idSchema, accountId: uuidSchema.optional() }).strict(),
  z.object({ action: z.literal("plan-preview"), profileId: uuidSchema, batchId: z.string().regex(/^[a-f0-9]{64}$/), rule: planRuleSchema, items: z.array(planItemSchema).max(10000).optional() }).strict(),
  z.object({ action: z.literal("plan-update"), planId: uuidSchema, revision: z.number().int().positive(), rule: planRuleSchema.optional(), items: z.array(planItemSchema).max(10000) }).strict(),
  z.object({ action: z.literal("plan-reschedule-preview"), planId: uuidSchema, revision: z.number().int().positive(), rule: planRuleSchema, items: z.array(planItemSchema).max(10000).optional() }).strict(),
  z.object({ action: z.literal("plan-reschedule-confirm"), planId: uuidSchema, revision: z.number().int().positive(), previewId: uuidSchema }).strict(),
  z.object({ action: z.literal("plan-confirm"), planId: uuidSchema, revision: z.number().int().positive(), ai: z.boolean(), temporaryPrivateTitle: z.literal(true), replaceJobIds: z.array(uuidSchema).max(1000).default([]) }).strict(),
  z.object({ action: z.literal("plan-archive"), planId: uuidSchema }).strict(),
  z.object({ action: z.literal("batch-remove"), batchId: uuidSchema }).strict(),
  z.object({ action: z.literal("profile"), profile: profileSchema }).strict(),
  z.object({ action: z.literal("preview"), profileId: uuidSchema, assetIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(1000) }).strict(),
  z.object({ action: z.literal("confirm"), batchId: uuidSchema, ai: z.boolean(), temporaryPrivateTitle: z.boolean(), overrides: z.array(itemOverrideSchema).max(1000).default([]) }).strict(),
  z.object({ action: z.literal("job"), id: uuidSchema, operation: z.enum(["pause", "resume", "cancel", "reschedule", "reconcile"]), publishAt: z.string().datetime().optional() }).strict(),
  z.object({ action: z.literal("policy"), policy: policySchema }).strict(),
  z.object({ action: z.literal("cleanup"), agentId: idSchema, instanceId: idSchema, confirmed: z.literal(true) }).strict(),
]);
/** 所有列表为该用户当前所属设备的缓存，不为页面读取调用 YouTube。 */
export async function GET(request: Request) {
  try { guard(request); const user = await authenticate(request); if (!cloudMode()) throw new AppError("MODE", "视频发布请使用 Cloud 控制端和 Windows Agent。", 409); return Response.json(await publishingView(user), { headers: { "Cache-Control": "no-store" } }); } catch (e) { return failed(e); }
}
/** 短编辑请求只持久化意图；长上传始终由 Agent 执行。 */
export async function POST(request: Request) {
  try {
    guard(request, true); const user = await authenticate(request); if (!cloudMode()) throw new AppError("MODE", "视频发布请使用 Cloud 控制端。", 409);
    const value = command.parse(await readJson(request, 2 * 1024 ** 2)); let result: unknown;
    if (value.action === "consent") result = await acceptPublishingPrivacy(user, value.version);
    else if (value.action === "account-create") result = await createPublishingAccount(user, value.agentId, value.instanceId, value.name);
    else if (value.action === "account-connect") { const oauth = await connectPublishingAccount(user, value.accountId); const response = NextResponse.json({ url: oauth.url }); response.cookies.set(oauthCookie(oauth.state), oauth.cookie, { httpOnly: true, sameSite: "lax", secure: true, path: "/api/youtube", maxAge: 600 }); return response; }
    else if (value.action === "account-cleanup") result = await requestPublishingAccountCleanup(user, value.accountId);
    else if (value.action === "account-playlists") result = await publishingAccountPlaylists(user, value.accountId);
    else if (value.action === "assets") result = await publishingAssets(user, value.agentId, value.instanceId, value.accountId);
    else if (value.action === "packages") result = await publishingPackages(user, value.agentId, value.instanceId, value.accountId);
    else if (value.action === "plan-preview") result = await previewPublishingPlan(user, value.profileId, value.batchId, value.rule, value.items);
    else if (value.action === "plan-update") result = await updatePublishingPlan(user, value.planId, value.revision, value.items, value.rule);
    else if (value.action === "plan-reschedule-preview") result = await previewPublishingReschedule(user, value.planId, value.revision, value.rule, value.items);
    else if (value.action === "plan-reschedule-confirm") result = await confirmPublishingReschedule(user, value.planId, value.revision, value.previewId);
    else if (value.action === "plan-confirm") result = await confirmPublishingPlan(user, value.planId, value.revision, value.ai, value.temporaryPrivateTitle, value.replaceJobIds);
    else if (value.action === "plan-archive") result = await archivePublishingPlan(user, value.planId);
    else if (value.action === "batch-remove") result = await removePublishingBatch(user, value.batchId);
    else if (value.action === "profile") result = await savePublishingProfile(user, value.profile);
    else if (value.action === "preview") result = await previewPublishingBatch(user, value.profileId, value.assetIds);
    else if (value.action === "confirm") result = await confirmPublishingBatch(user, value.batchId, value.ai, value.temporaryPrivateTitle, value.overrides);
    else if (value.action === "job") result = await changePublishingJob(user, value.id, value.operation, value.publishAt);
    else if (value.action === "policy") result = await savePublishingPolicy(user, value.policy);
    else result = await requestPublishingCleanup(user, value.agentId, value.instanceId);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return failed(e instanceof z.ZodError ? new AppError("INPUT", e.issues[0]?.message || "发布输入无效。") : e); }
}
