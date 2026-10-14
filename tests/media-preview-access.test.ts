/** Cloud 预览安全边界：真实登录/设备/发布账号存储，模拟有界 Agent 邮箱，不调用外部服务。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { accessStore, emptyAccess, digest, logout, SESSION_COOKIE } from "@/server/access";
import { createPairing, pairAgent, openSession, heartbeatAgent, agentStore, revokeAgent } from "@/cloud/agents";
import { createPublishingAccount, claimPublishingAccount, beginPublishingAccountCleanup } from "@/cloud/publishing-accounts";
import { openPreview, updatePreview, readPreview } from "@/server/media-preview";
import type { PreviewCommand, PreviewSelection } from "@/shared/media-preview";
const relay = vi.hoisted(() => ({ calls: [] as PreviewCommand[] }));
vi.mock("@/cloud/preview-relay", () => ({ requestPreview: vi.fn(async (command: PreviewCommand) => { relay.calls.push(command); return command.action === "bytes" ? { bytes: new Uint8Array(command.count!).map((_, i) => command.offset! + i), json: false } : { json: true, bytes: Buffer.from(JSON.stringify({ data: { expires: command.expires, busy: false, files: { video: { name: "video.mp4", size: 10, mime: "video/mp4", version: "a".repeat(64) } } } })) }; }) }));
let root: string; let selection: PreviewSelection; let accountId: string; let token: string;
/** 会话凭据仅在测试内存，数据根是本测试创建的独立目录。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "preview-access-"));
  vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ACCESS_DIR", path.join(root, "access")); vi.stubEnv("LIVEPILOT_MODE", "cloud");
  token = "b".repeat(64); const state = emptyAccess(); state.users.push({ username: "alice", salt: "unused", hash: "unused", revision: "1", disabled: false }); state.sessions[digest(token)] = { username: "alice", revision: "1", expires: Date.now() + 3600_000 }; await accessStore().write("access.json", state);
  const pair = await createPairing("device_a", "Device", "alice"); await pairAgent("device_a", pair.code, "c".repeat(64), undefined, "alice"); const session = await openSession("device_a", randomUUID(), [{ id: "main", name: "Main" }]); await heartbeatAgent("device_a", session.session, []);
  await agentStore("device_a").write("capabilities.json", ["publishing-accounts-v1", "media-preview-v1"]);
  const account = await createPublishingAccount({ username: "alice", role: "customer" }, "device_a", "main", "Account"); accountId = account.id;
  await claimPublishingAccount("device_a", accountId, "main", "channel_a", "Test", false, Date.now()); await claimPublishingAccount("device_a", accountId, "main", "channel_a", "Test", true, Date.now());
  selection = { agentId: "device_a", instanceId: "main", accountId, channelId: "channel_a", source: { kind: "package", packageId: "d".repeat(64), version: "e".repeat(64) } }; relay.calls.length = 0;
});
/** 删除本测试的磁盘存储，内存会话将由过期策略回收。 */
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("preview-access-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 模拟同源浏览器，每次请求都携带可撤销的登录 Cookie。 */
function request(range?: string, cookie = token) { return new Request("http://127.0.0.1:3010/api/media-preview", { headers: { cookie: SESSION_COOKIE + "=" + cookie, ...(range ? { Range: range } : {}) } }); }
it("returns exact Range bytes and rejects invalid ranges or closed sessions", async () => {
  const session = await openPreview(request(), selection); const response = await readPreview(request("bytes=3-6"), session.id, "video");
  expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe("bytes 3-6/10"); expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([3, 4, 5, 6]);
  expect((await readPreview(request("bytes=20-"), session.id, "video")).status).toBe(416);
  await updatePreview(request(), session.id, "close"); await expect(readPreview(request(), session.id, "video")).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
});
it("rejects device/instance/account/channel substitutions before sending any Agent command", async () => {
  for (const change of [{ agentId: "device_b" }, { instanceId: "other" }, { accountId: randomUUID() }, { channelId: "different" }]) await expect(openPreview(request(), { ...selection, ...change })).rejects.toThrow();
  expect(relay.calls).toEqual([]);
});
it("revokes read access immediately after logout, account cleanup, or device revoke", async () => {
  const session = await openPreview(request(), selection); await logout(request()); await expect(readPreview(request(), session.id, "video")).rejects.toMatchObject({ status: 401 });
  const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!; state.sessions[digest(token)] = { username: "alice", revision: "1", expires: Date.now() + 60_000 }; await accessStore().write("access.json", state);
  await beginPublishingAccountCleanup("device_a", accountId, "alice"); await expect(readPreview(request(), session.id, "video")).rejects.toMatchObject({ code: "CLEANUP" });
  await revokeAgent("device_a"); await expect(readPreview(request(), session.id, "video")).rejects.toThrow();
});
it("binds the URL to the original login and enforces expiry and old-Agent upgrade hints", async () => {
  const session = await openPreview(request(), selection); const state = (await accessStore().read<ReturnType<typeof emptyAccess>>("access.json"))!; const other = "f".repeat(64); state.sessions[digest(other)] = { username: "alice", revision: "1", expires: Date.now() + 3600_000 }; await accessStore().write("access.json", state);
  await expect(readPreview(request(undefined, other), session.id, "video")).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
  await agentStore("device_a").write("capabilities.json", []); await expect(openPreview(request(), selection)).rejects.toMatchObject({ code: "AGENT_VERSION" });
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000); await expect(readPreview(request(), session.id, "video")).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
});
