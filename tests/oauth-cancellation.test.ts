/** 明确取消、同实例多标签和旧租约兼容的真实 Cloud 事务测试，不交换 Google 凭据。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { agentStore, createPairing, pairAgent, openSession, heartbeatAgent } from "@/cloud/agents";
import { beginMaintenance } from "@/cloud/maintenance";
import { beginRemoteOAuth, finishRemoteOAuth } from "@/cloud/oauth";
import { cloudStore } from "@/cloud/store";
import { enqueue, pollTasks, reportTasks } from "@/cloud/tasks";
import { initialState } from "@/core/control";
import { seal } from "@/core/storage";
import type { AgentSnapshot } from "@/shared/remote";
let root: string, session: string;
const target = { agentId: "pc", instanceId: "main" };
/** 建立可维护的在线合成设备。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ln-oauth-cancel-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("LIVEPILOT_ORIGIN", "https://synthetic.invalid");
  const pair = await createPairing("pc", "Synthetic"); await pairAgent("pc", pair.code, "b".repeat(64)); session = (await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }])).session;
  const snapshot: AgentSnapshot = { instance: { id: "main", name: "Main" }, observedAt: Date.now(), dashboard: { state: initialState(), busy: false, obs: { ready: true, running: true, streaming: false }, youtube: { connected: false }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "unlisted", madeForKids: false } } };
  await heartbeatAgent("pc", session, [snapshot]);
});
/** 清理仅限本次临时目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-oauth-cancel-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 使用真实队列 begin/回执并保存与浏览器 Cookie 绑定的合成 Cloud 事务。 */
async function begun(withIdentity = true) {
  const task = await enqueue(target, "tester", { kind: "oauth-begin" }); await pollTasks("pc");
  const cookie = randomUUID().replaceAll("-", "").repeat(2), state = randomUUID().replaceAll("-", "").repeat(2), agentCookie = randomUUID().replaceAll("-", "").repeat(2);
  await reportTasks("pc", [{ id: task.id, status: "succeeded", result: { cookie: agentCookie, url: "https://accounts.google.com/synthetic" } }]);
  await cloudStore().write("oauth-" + state + ".json", seal({ target, ...(withIdentity ? { activityId: task.id } : {}), actor: "tester", browserHash: createHash("sha256").update(cookie).digest("hex"), state: "synthetic", cookie: agentCookie, expires: Date.now() + 600000, used: false }));
  return { task, cookie, state, agentCookie };
}
it("releases an explicitly cancelled transaction immediately and rejects a repeated callback", async () => {
  const tx = await begun(); await finishRemoteOAuth(tx.state, tx.cookie, "tester", "", undefined, true);
  expect((await agentStore("pc").read<{ activities: object }>("maintenance.json"))?.activities).toEqual({});
  expect(await cloudStore().read("oauth-" + tx.state + ".json")).toBeNull();
  await expect(finishRemoteOAuth(tx.state, tx.cookie, "tester", "", undefined, true)).rejects.toMatchObject({ code: "OAUTH" });
  await expect(beginMaintenance("pc", "d".repeat(64))).resolves.toEqual({ token: "d".repeat(64) });
});
it("cancels offline without dispatching any device task", async () => {
  const tx = await begun(); const beat = (await agentStore("pc").read<{ at: number }>("heartbeat.json"))!; await agentStore("pc").write("heartbeat.json", { ...beat, at: 0 });
  await finishRemoteOAuth(tx.state, tx.cookie, "tester", "", undefined, true);
  expect((await agentStore("pc").read<{ records: unknown[] }>("tasks.json"))?.records).toHaveLength(1);
  expect((await agentStore("pc").read<{ activities: object }>("maintenance.json"))?.activities).toEqual({});
});
it("keeps a newer tab protected when an older tab cancels or successfully completes", async () => {
  const old = await begun(); const next = await begun(); await finishRemoteOAuth(old.state, old.cookie, "tester", "", undefined, true);
  expect(Object.keys((await agentStore("pc").read<{ activities: object }>("maintenance.json"))!.activities)).toEqual(["oauth:main:" + next.task.id]);
  await expect(beginMaintenance("pc", "d".repeat(64))).rejects.toMatchObject({ code: "BUSY" });
  await finishRemoteOAuth(next.state, next.cookie, "tester", "", undefined, true);
  await expect(beginMaintenance("pc", "d".repeat(64))).resolves.toEqual({ token: "d".repeat(64) });
});
it("correlates a successful finish by its original Cookie rather than clearing all tabs", async () => {
  const old = await begun(), next = await begun(); const finish = await enqueue(target, "tester", { kind: "oauth-finish", cookie: old.agentCookie, state: "synthetic", code: "synthetic" }); await pollTasks("pc"); await reportTasks("pc", [{ id: finish.id, status: "succeeded", result: { ok: true } }]);
  expect(Object.keys((await agentStore("pc").read<{ activities: object }>("maintenance.json"))!.activities)).toEqual(["oauth:main:" + next.task.id]);
});
it("does not clear a newer legacy lease for an old callback and clears it for its matching latest callback", async () => {
  const old = await begun(false), next = await begun(false); await agentStore("pc").write("maintenance.json", { activities: { "oauth:main": Date.now() + 600000 } });
  await finishRemoteOAuth(old.state, old.cookie, "tester", "", undefined, true);
  expect(Object.keys((await agentStore("pc").read<{ activities: object }>("maintenance.json"))!.activities)).toEqual(["oauth:main"]);
  await finishRemoteOAuth(next.state, next.cookie, "tester", "", undefined, true);
  expect((await agentStore("pc").read<{ activities: object }>("maintenance.json"))?.activities).toEqual({});
});
it("retains protection for a tab closed without a callback or with invalid browser credentials", async () => {
  const tx = await begun(); await expect(finishRemoteOAuth(tx.state, "e".repeat(64), "tester", "", undefined, true)).rejects.toMatchObject({ code: "OAUTH" });
  await expect(beginMaintenance("pc", "d".repeat(64))).rejects.toMatchObject({ code: "BUSY" });
  expect(Object.keys((await agentStore("pc").read<{ activities: object }>("maintenance.json"))!.activities)).toHaveLength(1);
});
it("persists the real begin RPC identity and cancels its exact activity through the public OAuth flow", async () => {
  const pending = beginRemoteOAuth(target, "tester"); let beginId = "";
  await vi.waitFor(async () => { const queue = await agentStore("pc").read<{ records: { id: string; kind: string }[] }>("tasks.json"); beginId = queue?.records.find(record => record.kind === "oauth-begin")?.id || ""; expect(beginId).not.toBe(""); });
  await pollTasks("pc"); await reportTasks("pc", [{ id: beginId, status: "succeeded", result: { cookie: "f".repeat(64), url: "https://accounts.google.com/synthetic?state=synthetic&redirect_uri=" + encodeURIComponent("https://synthetic.invalid/api/youtube/callback") } }]);
  const oauth = await pending; expect(Object.keys((await agentStore("pc").read<{ activities: object }>("maintenance.json"))!.activities)).toEqual(["oauth:main:" + beginId]);
  await finishRemoteOAuth(oauth.state, oauth.cookie, "tester", "", undefined, true); await expect(beginMaintenance("pc", "d".repeat(64))).resolves.toEqual({ token: "d".repeat(64) });
});
