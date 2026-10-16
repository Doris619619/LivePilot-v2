/** 直播配置接口集成：真实文件事务、设备归属和频道隔离；会话为合成用户，不连接任何上游。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { authenticate, type Member } from "@/server/access";
import { cloudStore } from "@/cloud/store";
import { agentStore } from "@/cloud/agents";
import { GET, POST } from "@/app/api/broadcast-profiles/route";
import { defaultBroadcast } from "@/shared/broadcast";
import { broadcastProfileSignature } from "@/shared/broadcast-profiles";
import { Store } from "@/core/storage";
import { broadcastOptionsSnapshot } from "@/shared/broadcast-options";
import { AppError } from "@/core/errors";
vi.mock("@/server/access", async original => ({ ...await original<typeof import("@/server/access")>(), authenticate: vi.fn() }));
const origin = "http://127.0.0.1:3010";
let root: string;
const target = { agentId: "pc", instanceId: "main", channelId: "channel_one" };
const selection = { video: "rain.mp4", music: "lofi.mp3", videoAudio: false, broadcast: { ...defaultBroadcast(), title: "Night", description: "Quiet", playlistIds: ["PL_one_12345"], thumbnail: { id: randomUUID(), name: "cover.png" } } };

/** 每个用例只写新建的临时目录，并注入真实权限检查所需的合成设备和心跳。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "live-profiles-"));
  vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ORIGIN", origin); vi.stubEnv("LIVEPILOT_INSTANCES", "main");
  login("alice");
  await cloudStore().write("agents.json", { agents: [{ id: "pc", name: "Synthetic", owner: "alice", revoked: false, instances: [{ id: "main", name: "Main" }, { id: "second", name: "Second" }] }] });
  await agentStore("pc").write("heartbeat.json", { at: Date.now(), snapshots: ["main", "second"].map(id => ({ instance: { id }, dashboard: { youtube: { channelId: "channel_one", connected: true } } })) });
});
/** 清理仅针对本测试创建并核对过的临时目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("live-profiles-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 切换合成身份，不绕过目标设备鉴权。 */
function login(username: string, role: Member["role"] = "customer") { vi.mocked(authenticate).mockResolvedValue({ username, role }); }
/** 请求携带真实同源保护头；可显式替换以验证跨站拒绝。 */
function request(body?: unknown, query = target, from = origin) {
  return new Request(origin + "/api/broadcast-profiles?" + new URLSearchParams(query), { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:3010", origin: from, "x-livepilot": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
/** 创建一个可复用快照，允许调用方覆盖修订与名称来测试竞争和输入边界。 */
function save(extra = {}) { return { action: "save", target, id: randomUUID(), revision: 0, name: "Night", selection: structuredClone(selection), ...extra }; }

it("persists multiple snapshots, reopens them, updates by revision and deletes without touching media", async () => {
  const a = save(), b = save({ name: "Morning" });
  expect((await POST(request(a))).status).toBe(200); expect((await POST(request(b))).status).toBe(200);
  let profiles = (await (await GET(request())).json()).profiles;
  expect(profiles).toHaveLength(2); expect(profiles[0].selection).toEqual(broadcastOptionsSnapshot(selection));
  const update = { ...a, revision: 1, name: "Late Night", selection: { ...selection, broadcast: { ...selection.broadcast, privacy: "private" } } };
  expect((await POST(request(update))).status).toBe(200);
  expect((await POST(request(update))).status).toBe(200); // 响应丢失的原样重试
  profiles = (await (await GET(request())).json()).profiles; expect(profiles[0]).toMatchObject({ revision: 2, name: "Late Night" });
  expect((await POST(request({ action: "delete", target, id: a.id, revision: 1 }))).status).toBe(409);
  expect((await POST(request({ action: "delete", target, id: a.id, revision: 2 }))).status).toBe(200);
  expect((await (await GET(request())).json()).profiles.map((p: { name: string }) => p.name)).toEqual(["Morning"]);
  expect(await agentStore("pc").read("tasks.json")).toBeNull();
});

it("rejects unauthenticated and cross-origin operations before storage", async () => {
  expect((await POST(request(save(), target, "https://attacker.invalid"))).status).toBe(403);
  vi.mocked(authenticate).mockRejectedValue(new AppError("AUTH", "请登录", 401));
  expect((await GET(request())).status).toBe(401); expect((await POST(request(save()))).status).toBe(401);
});

it("shares within one login account, independent of device/channel, and isolates other customers and admins", async () => {
  const a = save(); await POST(request(a));
  login("bob"); expect((await (await GET(request())).json()).profiles).toEqual([]);
  expect((await POST(request(a))).status).toBe(200);
  login("admin", "admin"); expect((await (await GET(request())).json()).profiles).toEqual([]);
  login("alice");
  expect((await (await GET(request(undefined, { ...target, instanceId: "second", channelId: "another_channel" }))).json()).profiles).toHaveLength(1);
  await cloudStore().write("agents.json", { agents: [] });
  expect((await (await GET(request(undefined, {} as typeof target))).json()).profiles).toHaveLength(1);
  expect((await POST(request({ ...a, target: undefined, revision: 1, name: "Account rename" }))).status).toBe(200);
  const auditDir = path.join(root, "access", "audit");
  const events = await Promise.all((await readdir(auditDir)).map(file => readFile(path.join(auditDir, file), "utf8")));
  expect(events.join("")).not.toContain("lofi.mp3");
});

it("copies legacy rules without changing source files, and never resurrects deleted imports", async () => {
  const key = createHash("sha256").update(JSON.stringify(["alice", "pc", "main", "channel_one"])).digest("hex");
  const source = new Store(path.join(cloudStore().dir, "broadcast-profiles", key));
  const old = [{ id: randomUUID(), revision: 3, name: "Old", selection, updatedAt: 1 }];
  await source.write("profiles.json", old);
  const first = await (await GET(request(undefined, {} as typeof target))).json();
  expect(first.profiles).toHaveLength(1); expect(first.profiles[0].selection.broadcast.playlistIds).toEqual([]);
  expect(await source.read("profiles.json")).toEqual(old);
  expect((await POST(request({ action: "delete", id: old[0].id, revision: 3 }))).status).toBe(200);
  expect((await (await GET(request())).json()).profiles).toEqual([]);
  login("bob"); expect((await (await GET(request())).json()).profiles).toEqual([]);
});

it("rejects conflicting edits, duplicate names and unknown revisions without overwriting", async () => {
  const a = save(); await POST(request(a));
  expect((await POST(request(save({ name: "night" })))).status).toBe(409);
  const changes = ["A", "B"].map(name => POST(request({ ...a, revision: 1, name })));
  expect((await Promise.all(changes)).map(response => response.status).sort()).toEqual([200, 409]);
  expect((await POST(request(save({ revision: 9 })))).status).toBe(409);
});

it("allows incomplete reusable templates but rejects secrets, paths and invalid byte limits", async () => {
  expect((await POST(request(save({ selection: { ...selection, video: "", music: "", broadcast: defaultBroadcast() } })))).status).toBe(200);
  for (const changed of [{ ...selection, token: "secret" }, { ...selection, video: "../other.mp4" }, { ...selection, broadcast: { ...selection.broadcast, description: "雨".repeat(1667) } }]) {
    expect((await POST(request(save({ name: "Other", selection: changed })))).status).toBe(400);
  }
  expect((await POST(request(save({ name: " " })))).status).toBe(400);
  expect(broadcastProfileSignature(selection)).toBe(broadcastProfileSignature(structuredClone(selection)));
});
