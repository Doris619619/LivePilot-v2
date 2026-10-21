/** 频道迁移的版本确认、失败保留和旧客户端恢复；全部使用临时合成 Cloud 数据。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPairing, openSession, pairAgent, revokeAgent } from "@/cloud/agents";
import { claimChannel } from "@/cloud/bindings";
import { cloudStore } from "@/cloud/store";
import { Store } from "@/core/storage";
let root: string;
const a = { agentId: "pc_a", instanceId: "main" }, b = { agentId: "pc_b", instanceId: "main" };
/** 创建配对身份和独立目录，不接入真实 Agent。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ln-channel-migration-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  for (const id of [a.agentId, b.agentId]) { const pair = await createPairing(id, id); await pairAgent(id, pair.code, "b".repeat(64)); await openSession(id, randomUUID(), [{ id: "main", name: "Main" }, { id: "second", name: "Second" }]); }
});
/** 清理仅限本次已解析的临时目录。 */
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-channel-migration-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
it("keeps X during Y reservation and releases only this target after matching confirmation", async () => {
  await claimChannel(a, "X", true); await claimChannel({ ...a, instanceId: "second" }, "Other", true);
  const y = await claimChannel(a, "Y"); await expect(claimChannel(b, "X", true)).rejects.toMatchObject({ code: "CHANNEL_IN_USE" });
  await claimChannel(a, "Y", true, y.claimId); await claimChannel(b, "X", true);
  expect(await cloudStore().read("bindings.json")).toEqual(expect.arrayContaining([{ ...a, channelId: "Y", confirmed: true }, { ...a, instanceId: "second", channelId: "Other", confirmed: true }, { ...b, channelId: "X", confirmed: true }]));
});
it("rejects late confirmations after a newer reservation or successful migration", async () => {
  const x = await claimChannel(a, "X"); const y = await claimChannel(a, "Y");
  await expect(claimChannel(a, "X", true, x.claimId)).rejects.toMatchObject({ code: "CHANNEL_STALE" });
  await claimChannel(a, "Y", true, y.claimId); await expect(claimChannel(a, "X", true)).rejects.toMatchObject({ code: "CHANNEL_STALE" });
  expect(await cloudStore().read("bindings.json")).toEqual([{ ...a, channelId: "Y", confirmed: true }]);
});
it("recovers lost confirmation with the saved channel while old startup registration cannot cancel a pending change", async () => {
  await claimChannel(a, "X", true); await claimChannel(a, "Y"); await claimChannel(a, "X", true);
  await expect(claimChannel(b, "X")).rejects.toMatchObject({ code: "CHANNEL_IN_USE" });
  await claimChannel(a, "Y", true); await claimChannel(b, "X");
});
it("never releases X if reservation persistence or local save has not completed", async () => {
  await claimChannel(a, "X", true); const write = Store.prototype.write;
  const spy = vi.spyOn(Store.prototype, "write").mockImplementation(async function (this: Store, name, value) { if (name === "channel-claims.json") throw new Error("synthetic disk failure"); return write.call(this, name, value); });
  await expect(claimChannel(a, "Y")).rejects.toThrow("synthetic disk failure"); spy.mockRestore();
  await claimChannel(a, "Y"); // No successful local-save confirmation follows.
  await expect(claimChannel(b, "X")).rejects.toMatchObject({ code: "CHANNEL_IN_USE" });
});
it("retries confirmation safely after binding write failure without accepting stale X", async () => {
  await claimChannel(a, "X", true); const y = await claimChannel(a, "Y"); const write = Store.prototype.write;
  const spy = vi.spyOn(Store.prototype, "write").mockImplementation(async function (this: Store, name, value) { if (name === "bindings.json") throw new Error("synthetic disk failure"); return write.call(this, name, value); });
  await expect(claimChannel(a, "Y", true, y.claimId)).rejects.toThrow("synthetic disk failure"); spy.mockRestore();
  await expect(claimChannel(a, "X", true)).rejects.toMatchObject({ code: "CHANNEL_STALE" });
  await claimChannel(a, "Y", true, y.claimId); await claimChannel(b, "X", true);
});
it("lets a saved current channel reconcile legacy duplicate rows once and fences later stale replies", async () => {
  await cloudStore().write("bindings.json", [{ ...a, channelId: "X", confirmed: true }, { ...a, channelId: "Y", confirmed: true }]);
  await claimChannel(a, "Y", true); await claimChannel(b, "X", true);
  await expect(claimChannel(a, "X", true)).rejects.toMatchObject({ code: "CHANNEL_IN_USE" });
});
it("removes claim fences when a device is explicitly revoked", async () => {
  await claimChannel(a, "X", true); await revokeAgent(a.agentId);
  expect(await cloudStore().read("channel-claims.json")).toEqual([]);
  await expect(claimChannel(a, "X", true)).rejects.toMatchObject({ status: 404 }); await claimChannel(b, "X", true);
});
