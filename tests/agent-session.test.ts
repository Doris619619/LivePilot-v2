/** 能力升级兼容回归：旧 Cloud 可继续连接，认证/网络失败不能被降级掩盖。 */
import { expect, it, vi } from "vitest";
import { AppError } from "@/core/errors";
import { connectSession } from "@/agent/session";
import type { Transport } from "@/agent/transport";
const input = { bootId: "fixture", instances: [{ id: "main", name: "main" }], maintenance: "fixture" };

it("retries a rejected new capability list once with the existing capabilities", async () => {
  const post = vi.fn().mockRejectedValueOnce(new AppError("CLOUD_REQUEST", "fixture", 400)).mockResolvedValueOnce({ session: "old", capabilities: ["publishing-v1"] });
  expect(await connectSession({ post } as unknown as Transport, input)).toEqual({ session: "old", capabilities: ["publishing-v1"] });
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[0][1].capabilities).toContain("media-preview-v1");
  expect(post.mock.calls[1][1]).toMatchObject({ ...input, capabilities: ["publishing-v1", "publishing-v2", "publishing-accounts-v1"] });
});
it.each([401, 403, 503])("does not retry handshake failure %s with downgraded capabilities", async status => {
  const failure = new AppError("CLOUD_REQUEST", "fixture", status); const post = vi.fn().mockRejectedValue(failure);
  await expect(connectSession({ post } as unknown as Transport, input)).rejects.toBe(failure);
  expect(post).toHaveBeenCalledOnce();
});
it("advertises preview to upgraded Cloud without fallback", async () => {
  const result = { session: "new", capabilities: ["media-preview-v1"] }; const post = vi.fn().mockResolvedValue(result);
  expect(await connectSession({ post } as unknown as Transport, input)).toEqual(result);
  expect(post).toHaveBeenCalledOnce();
});
