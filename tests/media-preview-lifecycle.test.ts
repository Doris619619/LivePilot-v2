/** 预览出站通道的退出竞态测试：迟到轮询不得在停止后创建媒体检查。 */
import { expect, it, vi } from "vitest";
import { MediaPreviewConnection } from "@/agent/media-preview";
import type { AgentPreviewSessions } from "@/core/preview/session";
import type { Transport } from "@/agent/transport";

it("discards a poll that returns after shutdown and cannot reconnect", async () => {
  let release!: (response: Response) => void;
  const poll = new Promise<Response>(resolve => { release = resolve; });
  const request = vi.fn().mockReturnValue(poll);
  const sessions = { sweep: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), execute: vi.fn() };
  const connection = new MediaPreviewConnection({ agentId: "fixture", request } as unknown as Transport, sessions as unknown as AgentPreviewSessions);
  connection.connect(true);
  expect(request).toHaveBeenCalledOnce();
  const stopping = connection.stop();
  release(Response.json({ requests: [{ action: "open" }] }));
  await stopping;
  connection.connect(true);
  expect(sessions.execute).not.toHaveBeenCalled();
  expect(sessions.stop).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
});
