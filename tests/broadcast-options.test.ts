/** 完整配置规则回归：配置包和撤销保留本场内容；账号默认值隔离、修订冲突与同源校验。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { applyBroadcastOptions, broadcastOptionsSnapshot, broadcastOptionsSignature } from "@/shared/broadcast-options";
import { defaultBroadcast } from "@/shared/broadcast";
import { GET, POST } from "@/app/api/broadcast-defaults/route";
import { authenticate } from "@/server/access";
vi.mock("@/server/access", async original => ({ ...await original<typeof import("@/server/access")>(), authenticate: vi.fn() }));
let root: string;
const origin = "http://127.0.0.1:3010";
/** 每个测试只操作独立临时目录和合成身份。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "broadcast-options-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ORIGIN", origin); vi.mocked(authenticate).mockResolvedValue({ username: "alice", role: "customer" }); });
/** 仅删除已核对的测试目录，保留全部用户配置。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("broadcast-options-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 为真实路由构造同源请求，不连接任何直播平台。 */
function request(body?: unknown, from = origin) { return new Request(origin + "/api/broadcast-defaults", { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:3010", origin: from, "x-livepilot": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }

it("applies legacy profile rules while preserving current media, copy and cover, including undo", () => {
  const current = { video: "current.mp4", music: "current.mp3", videoAudio: false, broadcast: { ...defaultBroadcast(), title: "Current", description: "Edited", playlistIds: ["PL_current"], thumbnail: { id: "a", name: "current.jpg" } } };
  const preset = { video: "old.mp4", music: "old.mp3", videoAudio: true, broadcast: { ...defaultBroadcast(), title: "Old", privacy: "private" as const, madeForKids: true, playlistIds: ["PL_one_12345"] } };
  const applied = applyBroadcastOptions(current, preset);
  expect(applied).toEqual({ ...current, videoAudio: true, broadcast: { ...current.broadcast, privacy: "private", madeForKids: true } });
  const afterEdit = { ...applied, broadcast: { ...applied.broadcast!, title: "Edited after apply" } };
  expect(applyBroadcastOptions(afterEdit, current).broadcast).toEqual({ ...current.broadcast, title: "Edited after apply" });
  const saved = broadcastOptionsSnapshot(applied);
  expect(saved.broadcast.playlistIds).toEqual([]); expect(saved.video).toBe(""); expect(saved.broadcast.title).toBe(""); expect(saved.broadcast.thumbnail).toBeUndefined();
  expect(broadcastOptionsSignature(applied)).toBe(broadcastOptionsSignature(afterEdit));
});

it("persists defaults by authenticated account and rejects stale overwrites", async () => {
  const initial = await (await GET(request())).json();
  expect(initial).toEqual({ revision: 0, value: { privacy: "public", madeForKids: false, videoAudio: false } });
  const changed = { revision: 0, value: { privacy: "private", madeForKids: true, videoAudio: true } };
  expect((await POST(request(changed))).status).toBe(200);
  expect((await POST(request(changed))).status).toBe(200);
  expect((await POST(request(initial))).status).toBe(409);
  expect((await (await GET(request())).json()).value).toEqual(changed.value);
  vi.mocked(authenticate).mockResolvedValue({ username: "bob", role: "customer" });
  expect(await (await GET(request())).json()).toEqual(initial);
  expect((await POST(request(changed, "https://attacker.invalid"))).status).toBe(403);
  expect((await POST(request({ ...changed, value: { ...changed.value, password: "unexpected" } }))).status).toBe(400);
});
