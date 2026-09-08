/** 多实例配置、授权归属和浏览器前置条件的回归测试；不连接真实 OBS / YouTube。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as configs from "@/server/config";
import { Store, seal, unseal } from "@/server/storage";
import { YouTubeAuth } from "@/server/youtube/auth";
import { saveChannelBinding } from "@/server/youtube/bindings";
import { startBlocker } from "@/shared/readiness";
import type { Dashboard } from "@/shared/types";
let directory: string;
/** 将所有授权存储重定向到唯一临时目录，避免接触真实账号。 */
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "livepilot-instances-"));
  vi.stubEnv("LIVEPILOT_INSTANCES", "main,obs_a,studio_c");
  vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "c".repeat(64));
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
  const original = configs.config;
  vi.spyOn(configs, "config").mockImplementation((id = "main") => ({ ...original(id), dataDir: id === "main" ? directory : path.join(directory, "instances", id) }));
});
/** 只删除本测试创建且位于系统临时目录的内容。 */
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("livepilot-instances-")) throw new Error("Unsafe cleanup");
  await rm(directory, { recursive: true, force: true });
});
/** 构造不包含真实凭据的 Google JSON 响应。 */
function reply(data: unknown) { return new Response(JSON.stringify(data), { status: 200 }); }

/** 第三个实例证明配置和存储没有二实例上限。 */
it("supports three instances, preserves legacy main, and does not inherit its OBS secrets", () => {
  vi.stubEnv("LIVEPILOT_OBS_EXE", "D:\\obs-b\\bin\\64bit\\obs64.exe");
  vi.stubEnv("LIVEPILOT_OBS_WS_PASSWORD", "main-secret");
  expect(configs.instanceIds()).toEqual(["main", "obs_a", "studio_c"]);
  expect(configs.config().obsPassword).toBe("main-secret");
  expect(configs.config("obs_a").obsPassword).toBe("");
  expect(configs.config("studio_c").dataDir).toBe(path.join(directory, "instances", "studio_c"));
  expect(configs.missingConfig("obs_a")).toContain("LIVEPILOT_INSTANCE_OBS_A_OBS_WS_PASSWORD");
  expect(JSON.stringify(configs.instanceDescriptors())).not.toContain("main-secret");
});
/** 输入 ID 无法越界到磁盘路径或绕过注册清单。 */
it.each(["../main", "main,../x", "main,main", "obs_a", "main,con", "main,OBS_A"])("rejects unsafe registry %s", value => {
  vi.stubEnv("LIVEPILOT_INSTANCES", value);
  expect(() => configs.instanceIds()).toThrow();
});
/** 两个面板必须连接不同端口，即使 OBS 尚未启动也提前拒绝。 */
it("rejects duplicate ports", () => {
  vi.stubEnv("LIVEPILOT_OBS_WS_URL", "ws://127.0.0.1:4456");
  vi.stubEnv("LIVEPILOT_INSTANCE_OBS_A_OBS_WS_URL", "ws://127.0.0.1:4456");
  expect(() => configs.validateInstances()).toThrow("同一");
});
/** Windows 路径忽略大小写并规范化，避免同一 exe 出现两次。 */
it("rejects duplicate Windows paths with different spelling", () => {
  vi.stubEnv("LIVEPILOT_OBS_EXE", "D:\\OBS\\bin\\obs64.exe");
  vi.stubEnv("LIVEPILOT_INSTANCE_OBS_A_OBS_EXE", "d:/obs/bin/../bin/OBS64.EXE");
  expect(() => configs.validateInstances()).toThrow("同一");
});
/** 未配置好的第二实例不能污染主实例的缺项列表。 */
it("keeps missing configuration scoped and rejects unknown IDs", () => {
  vi.stubEnv("LIVEPILOT_OBS_EXE", "D:/obs/obs64.exe");
  vi.stubEnv("LIVEPILOT_OBS_WS_PASSWORD", "secret");
  vi.stubEnv("LIVEPILOT_MEDIA_ROOT", "D:/media");
  expect(configs.missingConfig("main")).toEqual([]);
  expect(configs.missingConfig("obs_a").length).toBeGreaterThan(0);
  expect(() => configs.requireInstance("unknown")).toThrow("实例不存在");
});
/** 已有主实例授权原地读取，第二和第三个实例保持未连接。 */
it("preserves main credentials without copying them to other instances", async () => {
  await new Store(directory).write("youtube.enc", seal({ channelId: "legacy" }));
  const main = new YouTubeAuth(new Store(configs.config().dataDir), "main");
  expect((await main.tokens())?.channelId).toBe("legacy");
  for (const id of ["obs_a", "studio_c"]) expect(await new YouTubeAuth(new Store(configs.config(id).dataDir), id).tokens()).toBeNull();
});
/** 两个 OAuth 事务可同时存在；错误实例不能消费另一个实例的 Cookie。 */
it("isolates OAuth transactions and rejects a callback to the wrong instance", async () => {
  const a = new YouTubeAuth(new Store(configs.config("obs_a").dataDir), "obs_a");
  const b = new YouTubeAuth(new Store(configs.config("studio_c").dataDir), "studio_c");
  const [txA, txB] = await Promise.all([a.begin(), b.begin()]);
  const stateA = new URL(txA.url).searchParams.get("state")!;
  const stateB = new URL(txB.url).searchParams.get("state")!;
  expect(stateA).toMatch(/^obs_a\./); expect(stateB).toMatch(/^studio_c\./);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(b.finish(txA.cookie, stateA, "code")).rejects.toThrow("已过期");
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(reply({ access_token: "a", refresh_token: "r" })).mockResolvedValueOnce(reply({ items: [{ id: "channel-a", snippet: { title: "A" } }] }));
  await a.finish(txA.cookie, stateA, "code");
  expect((await a.tokens())?.channelId).toBe("channel-a");
  expect(await b.tokens()).toBeNull();
});
/** 防止用户误把同一个频道连接到两个 OBS，且不破坏已保存的频道。 */
it("rejects duplicate channel binding without overwriting either instance", async () => {
  await saveChannelBinding("main", { channelId: "channel-one" });
  await saveChannelBinding("obs_a", { channelId: "channel-two" });
  await expect(saveChannelBinding("obs_a", { channelId: "channel-one" })).rejects.toThrow("另一个 OBS");
  const value = await new Store(configs.config("obs_a").dataDir).read<string>("youtube.enc");
  expect(unseal(value!)).toEqual({ channelId: "channel-two" });
  await saveChannelBinding("studio_c", { channelId: "channel-three" });
});
/** 同时绑定同一频道时最多一次成功，不能出现两个拥有者。 */
it("serializes competing OAuth bindings across instances", async () => {
  const results = await Promise.allSettled([saveChannelBinding("obs_a", { channelId: "same" }), saveChannelBinding("studio_c", { channelId: "same" })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
});
/** 旧授权的慢刷新返回时必须保留刚完成的新频道授权。 */
it("does not let an old refresh overwrite a newer authorization", async () => {
  const storage = new Store(configs.config("obs_a").dataDir);
  await storage.write("youtube.enc", seal({ channelId: "old", channel: "Old", accessToken: "old", refreshToken: "old-refresh", expiresAt: 0 }));
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const auth = new YouTubeAuth(storage, "obs_a");
  const refresh = auth.access();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await storage.write("youtube.enc", seal({ channelId: "new", channel: "New", accessToken: "new", refreshToken: "new-refresh", expiresAt: Date.now() + 3600_000 }));
  release(reply({ access_token: "stale-result" }));
  expect((await refresh).channelId).toBe("new");
  expect((await auth.tokens())?.accessToken).toBe("new");
});
/** Offline 可以由 Start 自动启动；不可用的媒体必须明确阻止开播。 */
it("explains missing media but permits automatic OBS launch", () => {
  const data: Dashboard = { state: { phase: "idle", stage: "等待开始", updatedAt: new Date().toISOString() }, busy: false, configuration: { missing: [], privacy: "unlisted", madeForKids: false }, youtube: { connected: true }, media: { videos: ["v.mp4"], music: ["m.mp3"] }, obs: { ready: false, running: false, streaming: false } };
  const selection = { video: "v.mp4", music: "m.mp3", videoAudio: false };
  expect(startBlocker(data, selection, false, false, false)).toBe("");
  expect(startBlocker(data, { ...selection, video: "missing.mp4" }, false, false, false)).toContain("视频");
  expect(startBlocker(data, selection, false, true, false)).toContain("过期");
});

/** 不同成员不能在同一浏览器里接管之前发起的 OAuth 事务。 */
it("binds OAuth transactions to the initiating member", async () => {
  const auth = new YouTubeAuth(new Store(configs.config().dataDir), "main");
  const tx = await auth.begin("alice");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(auth.finish(tx.cookie, new URL(tx.url).searchParams.get("state")!, "code", undefined, "bob")).rejects.toThrow("授权校验失败");
  expect(fetcher).not.toHaveBeenCalled();
});
