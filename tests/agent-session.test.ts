/** 能力升级兼容回归：旧 Cloud 可继续连接，认证/网络失败不能被降级掩盖。 */
import { expect, it, vi } from "vitest";
import { AppError } from "@/core/errors";
import { connectSession } from "@/agent/session";
import { PROTOCOL } from "@/shared/remote";
import type { Transport } from "@/agent/transport";
const input = { bootId: "fixture", instances: [{ id: "main", name: "main" }], maintenance: "fixture" };
const legacy = ["publishing-v1", "publishing-v2", "publishing-accounts-v1"];
const preview = [...legacy, "media-preview-v1"];
const consent = [...preview, "publishing-consent-v2"];
const recovery = [...consent, "publishing-recovery-v1"];
const quota = [...consent, "youtube-quota-v1", "youtube-usage-v1"];
const full = [...quota, "publishing-recovery-v1"];
const generations = [full, quota, recovery, consent, preview, legacy];

it.each([0, 1, 2, 3, 4, 5])("negotiates Cloud generation %i while retaining the strongest supported capability set", async generation => {
  const supported = generations[generation], allowed = new Set(supported); const result = { session: "accepted", capabilities: supported };
  /** Cloud 替身只拒绝不认识的能力，认证及真实网络不参与本协议单测。 */
  const post = vi.fn(async (_route: string, body: { capabilities: string[] }) => { if (body.capabilities.some(capability => !allowed.has(capability))) throw new AppError("CLOUD_REQUEST", "unsupported capability", 400); return result; });
  expect(await connectSession({ post } as unknown as Transport, input)).toEqual(result);
  expect(post.mock.calls.map(([route, body]) => [route, body])).toEqual(generations.slice(0, generation + 1).map(capabilities => ["/api/agent/session", { protocol: PROTOCOL, ...input, capabilities }]));
});
const failures = [new AppError("AGENT_AUTH", "fixture", 401), new AppError("FORBIDDEN", "fixture", 403), new AppError("CLOUD_REQUEST", "fixture", 503), new AppError("CLOUD_NETWORK", "fixture", 503)];
it.each(failures)("does not downgrade an initial $code/$status failure", async failure => {
  const post = vi.fn().mockRejectedValue(failure);
  await expect(connectSession({ post } as unknown as Transport, input)).rejects.toBe(failure);
  expect(post).toHaveBeenCalledOnce();
});
it.each(failures)("stops negotiation immediately if a later generation returns $code/$status", async failure => {
  const post = vi.fn().mockRejectedValueOnce(new AppError("CLOUD_REQUEST", "unsupported capability", 400)).mockRejectedValue(failure);
  await expect(connectSession({ post } as unknown as Transport, input)).rejects.toBe(failure);
  expect(post).toHaveBeenCalledTimes(2); expect(post.mock.calls[1][1]).toEqual({ protocol: PROTOCOL, ...input, capabilities: quota });
});
it("propagates the final protocol rejection after the six known generations", async () => {
  const failure = new AppError("CLOUD_REQUEST", "unsupported capability", 400); const post = vi.fn().mockRejectedValue(failure);
  await expect(connectSession({ post } as unknown as Transport, input)).rejects.toBe(failure);
  expect(post.mock.calls.map(call => call[1].capabilities)).toEqual(generations);
});
it("does not treat an untrusted error with an HTTP-shaped status as a protocol rejection", async () => {
  const failure = Object.assign(new Error("synthetic transport failure"), { status: 400 }); const post = vi.fn().mockRejectedValue(failure);
  await expect(connectSession({ post } as unknown as Transport, input)).rejects.toBe(failure); expect(post).toHaveBeenCalledOnce();
});
