/** 真实操作系统 spawn 失败回归；资源目录故意为空，不启动 Agent 或访问网络。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AgentHost } from "../electron/agent-host";
vi.mock("../electron/settings", () => ({ environment: () => ({}) }));
it("allows retry after native ENOENT without keeping a phantom child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ln-agent-native-"));
  try {
    const host = new AgentHost();
    const settings = { dataRoot: root, instances: [], paired: true, encryptionKey: "a".repeat(64), identity: { agentId: "fixture", token: "b".repeat(64), origin: "https://example.invalid" } };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(host.start(settings, path.join(root, "missing"), async () => {})).rejects.toThrow("启动");
      expect(host.child).toBeUndefined(); await expect(host.ready()).rejects.toThrow();
    }
  } finally {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-agent-native-")) throw new Error("Unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
