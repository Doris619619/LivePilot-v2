/** 验证真实聊天能力门禁，旧版与过期快照不得获得新任务，设备身份始终显式定位。 */
import { beforeEach, expect, it, vi } from "vitest";
import { requireLiveChat } from "@/server/remote";
import { requireTarget, snapshotFor } from "@/cloud/agents";
import type { AgentSnapshot } from "@/shared/remote";
vi.mock("@/cloud/agents", () => ({ requireTarget: vi.fn(), snapshotFor: vi.fn(), listAgents: vi.fn(), problemsFor: vi.fn() }));
const now = 1_791_460_800_000;
const destination = { agentId: "first-computer", instanceId: "second-instance" };
/** 合成快照只具备真实协议允许的公开状态，无身份令牌或直播请求。 */
function snapshot(supported: boolean, observedAt = now): AgentSnapshot {
  return { instance: { id: destination.instanceId, name: "Fixture OBS" }, observedAt, dashboard: { state: { phase: "live", stage: "fixture", updatedAt: "fixture" }, busy: true, obs: { ready: true, running: true, streaming: true }, youtube: { connected: true }, media: { videos: [], music: [] }, configuration: { liveChat: supported, missing: [], privacy: "private", madeForKids: false } } };
}
/** 门禁只读取设备和快照；冻结业务时钟检查过期与未来心跳边界。 */
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(Date, "now").mockReturnValue(now); vi.mocked(snapshotFor).mockResolvedValue(snapshot(true)); });
it("allows fresh upgraded live devices even while the broadcast control is busy", async () => {
  await expect(requireLiveChat(destination)).resolves.toBeUndefined();
  expect(requireTarget).toHaveBeenCalledWith(destination.agentId, destination.instanceId, true);
  expect(snapshotFor).toHaveBeenCalledWith(destination.agentId, destination.instanceId);
});
it("rejects legacy Agent capability before a new chat task can be delivered", async () => {
  vi.mocked(snapshotFor).mockResolvedValue(snapshot(false));
  await expect(requireLiveChat(destination)).rejects.toMatchObject({ code: "CONFIG", status: 409 });
});
it.each([now - 20_000, now + 5_001])("rejects a stale or future snapshot at %s", async observedAt => {
  vi.mocked(snapshotFor).mockResolvedValue(snapshot(true, observedAt));
  await expect(requireLiveChat(destination)).rejects.toMatchObject({ code: "AGENT_STALE", status: 409 });
});
