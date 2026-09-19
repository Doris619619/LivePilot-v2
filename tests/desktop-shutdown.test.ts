/** 普通退出回归：离线不取维护锁、不操作 OBS，取消、忙碌和排空失败均保持客户端。 */
import { expect, it, vi } from "vitest";
import { Shutdown } from "../electron/shutdown";
/** 模拟云端永远不可用的本地客户端，退出不得调用 maintenance。 */
function fixture() {
  const target = { busy: false, agent: { stop: vi.fn().mockResolvedValue(undefined) }, maintenance: vi.fn().mockRejectedValue(new Error("offline")) };
  const prompts = { confirm: vi.fn().mockResolvedValue(true), notify: vi.fn().mockResolvedValue(undefined), finish: vi.fn() };
  return { target, prompts, shutdown: new Shutdown(target, prompts) };
}
it("quits offline after local Agent exit without requesting maintenance", async () => {
  const { target, prompts, shutdown } = fixture(); await shutdown.request();
  expect(target.maintenance).not.toHaveBeenCalled(); expect(target.agent.stop).toHaveBeenCalledOnce(); expect(prompts.finish).toHaveBeenCalledOnce();
});
it("does nothing when the user cancels", async () => {
  const { target, prompts, shutdown } = fixture(); prompts.confirm.mockResolvedValue(false); await shutdown.request();
  expect(target.agent.stop).not.toHaveBeenCalled(); expect(prompts.finish).not.toHaveBeenCalled(); expect(target.busy).toBe(false);
});
it("does not interrupt an active configuration", async () => {
  const { target, prompts, shutdown } = fixture(); target.busy = true; await shutdown.request();
  expect(prompts.confirm).not.toHaveBeenCalled(); expect(prompts.notify).toHaveBeenCalled(); expect(target.agent.stop).not.toHaveBeenCalled(); expect(target.busy).toBe(true);
});
it("rechecks configuration state after confirmation", async () => {
  const { target, prompts, shutdown } = fixture(); prompts.confirm.mockImplementation(async () => { target.busy = true; return true; }); await shutdown.request();
  expect(target.agent.stop).not.toHaveBeenCalled(); expect(prompts.finish).not.toHaveBeenCalled(); expect(prompts.notify).toHaveBeenCalled();
});
it("coalesces tray/system requests and waits for actual drain before quitting", async () => {
  const { target, prompts, shutdown } = fixture(); let finish!: () => void;
  target.agent.stop.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = shutdown.request(); const second = shutdown.request(); expect(first).toBe(second);
  await vi.waitFor(() => expect(target.agent.stop).toHaveBeenCalledOnce());
  expect(prompts.confirm).toHaveBeenCalledOnce(); expect(prompts.finish).not.toHaveBeenCalled(); expect(target.busy).toBe(true);
  finish(); await first; expect(prompts.finish).toHaveBeenCalledOnce();
});
it("preserves the app on stop failure and permits a later retry without raw errors", async () => {
  const { target, prompts, shutdown } = fixture(); target.agent.stop.mockRejectedValueOnce(new Error("SECRET_UPSTREAM"));
  await shutdown.request(); expect(prompts.finish).not.toHaveBeenCalled(); expect(target.busy).toBe(false);
  expect(prompts.notify).toHaveBeenCalledWith(expect.stringContaining("尚未确认退出")); expect(JSON.stringify(prompts.notify.mock.calls)).not.toContain("SECRET_UPSTREAM");
  await shutdown.request(); expect(prompts.finish).toHaveBeenCalledOnce(); expect(target.maintenance).not.toHaveBeenCalled();
});
