/** 使用隔离令牌和模拟 Google 响应验证频道授权及服务失败分类。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as configs from "@/core/config";
import { Store, seal, unseal } from "@/server/storage";
import { YouTubeAuth } from "@/server/youtube/auth";
import { YouTubeApi } from "@/server/youtube/api";
let directory: string;
let storage: Store;
beforeEach(async () => {
  vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "b".repeat(64));
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
  directory = await mkdtemp(path.join(os.tmpdir(), "livepilot-youtube-test-"));
  storage = new Store(directory);
  const original = configs.config();
  vi.spyOn(configs, "config").mockReturnValue({ ...original, dataDir: directory });
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("livepilot-youtube-test-")) throw new Error("Unsafe test cleanup");
  await rm(directory, { recursive: true, force: true });
});
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
it("revokes at Google, removes credentials and leaves user source files untouched", async () => { await storage.write("youtube.enc", seal({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000, channelId: "channel", channel: "Synthetic" })); await storage.write("source-marker.json", { preserve: true }); const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 })); vi.stubGlobal("fetch", fetcher); await new YouTubeAuth(storage).revoke(); expect(await storage.read("youtube.enc")).toBeNull(); expect(await storage.read("youtube-revoke.enc")).toBeNull(); expect(await storage.read("source-marker.json")).toEqual({ preserve: true }); expect(fetcher.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/revoke"); });
it("keeps an encrypted pending revoke when offline and blocks OAuth until retry succeeds", async () => { await storage.write("youtube.enc", seal({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: 0, channelId: "channel", channel: "Synthetic" })); const auth = new YouTubeAuth(storage); const fetcher = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(reply({ error: "invalid_token" }, 400)); vi.stubGlobal("fetch", fetcher); await expect(auth.revoke()).rejects.toMatchObject({ code: "GOOGLE_NETWORK" }); expect(await storage.read("youtube.enc")).toBeNull(); expect(await storage.read("youtube-revoke.enc")).toEqual(expect.any(String)); await expect(auth.begin()).rejects.toMatchObject({ code: "GOOGLE_AUTH" }); await auth.revoke(); expect(await storage.read("youtube-revoke.enc")).toBeNull(); });
it("uses offline OAuth with S256 PKCE and a one-use browser-bound callback", async () => {
  const auth = new YouTubeAuth();
  const tx = await auth.begin();
  const url = new URL(tx.url);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3010/api/youtube/callback");
  expect(tx.url).not.toContain("test-secret");
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ access_token: "access-sentinel", refresh_token: "refresh-sentinel", expires_in: 3600 })).mockResolvedValueOnce(reply({ items: [{ id: "channel", snippet: { title: "Studio" } }] }));
  vi.stubGlobal("fetch", fetcher);
  await auth.finish(tx.cookie, url.searchParams.get("state")!, "code-sentinel");
  expect(fetcher.mock.calls[0][1].body.get("code_verifier")).toBeTruthy();
  const encrypted = await storage.read<string>("youtube.enc");
  expect(encrypted).not.toContain("access-sentinel");
  expect(unseal<{ channelId: string }>(encrypted!).channelId).toBe("channel");
  await expect(auth.finish(tx.cookie, url.searchParams.get("state")!, "code-sentinel")).rejects.toThrow("已过期");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("rejects wrong OAuth state without exchanging the code", async () => {
  const auth = new YouTubeAuth(); const tx = await auth.begin();
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(auth.finish(tx.cookie, "wrong-state", "code")).rejects.toThrow("校验失败");
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not overwrite credentials with a different channel during recovery", async () => {
  const auth = new YouTubeAuth(); const tx = await auth.begin();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ access_token: "token", refresh_token: "refresh" })).mockResolvedValueOnce(reply({ items: [{ id: "other", snippet: { title: "Other" } }] })));
  await expect(auth.finish(tx.cookie, new URL(tx.url).searchParams.get("state")!, "code", "original")).rejects.toThrow("原 Channel");
  expect(await storage.read("youtube.enc")).toBeNull();
});
it("deduplicates token refresh and preserves a refresh token when Google omits it", async () => {
  await storage.write("youtube.enc", seal({ accessToken: "expired", refreshToken: "stable-refresh", expiresAt: 0, channelId: "channel", channel: "Studio" }));
  const fetcher = vi.fn().mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 15)); return reply({ access_token: "new-access", expires_in: 3600 }); });
  vi.stubGlobal("fetch", fetcher);
  const auth = new YouTubeAuth();
  const results = await Promise.all([auth.access(), auth.access(), auth.access()]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(results.every(r => r.accessToken === "new-access" && r.refreshToken === "stable-refresh")).toBe(true);
});
it("creates the broadcast with manual lifecycle transitions and configured privacy", async () => {
  const auth = new YouTubeAuth();
  vi.spyOn(auth, "access").mockResolvedValue({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3600_000, channelId: "channel", channel: "Studio" });
  const fetcher = vi.fn().mockResolvedValue(reply({ id: "broadcast" })); vi.stubGlobal("fetch", fetcher);
  await new YouTubeApi(auth).createBroadcast("My live");
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.status).toEqual({ privacyStatus: "public", selfDeclaredMadeForKids: false });
  expect(body.contentDetails).toMatchObject({ enableAutoStart: false, enableAutoStop: false, monitorStream: { enableMonitorStream: false } });
});
it("never leaks upstream diagnostic text containing credentials", async () => {
  const auth = new YouTubeAuth();
  vi.spyOn(auth, "access").mockResolvedValue({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3600_000, channelId: "channel", channel: "Studio" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ error: { message: "streamKey=secret-should-not-leak", errors: [{ reason: "quotaExceeded" }] } }, 403)));
  await expect(new YouTubeApi(auth).transition("b", "live")).rejects.toThrow("配额");
});

/** 只有服务明确撤销授权才要求重新授权，所有失败保留原令牌。 */
it.each([[503,"invalid_grant","GOOGLE_UNAVAILABLE"],[429,"quota","YOUTUBE_QUOTA"],[400,"invalid_grant","GOOGLE_AUTH"],[401,"invalid_client","GOOGLE_CONFIG"]])("distinguishes refresh HTTP %s / %s",async(status,reason,code)=>{
 const encrypted=seal({accessToken:"expired",refreshToken:"stable-refresh",expiresAt:0,channelId:"channel",channel:"Studio"});await storage.write("youtube.enc",encrypted);
 vi.stubGlobal("fetch",vi.fn(async()=>reply({error:reason},status as number)));
 await expect(new YouTubeAuth().access()).rejects.toMatchObject({code});expect(await storage.read("youtube.enc")).toBe(encrypted);
});
it("consumes a cancelled transaction without token exchange",async()=>{const auth=new YouTubeAuth();const tx=await auth.begin();const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);await auth.finish(tx.cookie,new URL(tx.url).searchParams.get("state")!,"",undefined,undefined,true);expect(fetcher).not.toHaveBeenCalled();await expect(auth.finish(tx.cookie,new URL(tx.url).searchParams.get("state")!,"",undefined,undefined,true)).rejects.toThrow("已过期");});

/** 新网页的明确选择覆盖环境，所有隐私选项和儿童内容标记原样发送。 */
it.each(["public", "unlisted", "private"] as const)("honors explicit %s broadcast details", async privacy => {
  const auth = new YouTubeAuth();
  vi.spyOn(auth, "access").mockResolvedValue({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3600_000, channelId: "channel", channel: "Studio" });
  const fetcher = vi.fn().mockResolvedValue(reply({ id: "b" })); vi.stubGlobal("fetch", fetcher);
  await new YouTubeApi(auth).createBroadcast("unique recovery title", { title: "观众标题", description: "直播说明", privacy, madeForKids: true, playlistIds: [] });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ snippet: { description: "直播说明" }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: true } });
});
/** 列表已存在时跳过插入；公开标题仅在场次 ID 持久化之后应用。 */
it("applies a public title without changing lifecycle and avoids duplicate playlist insertion", async () => {
  const auth = new YouTubeAuth();
  vi.spyOn(auth, "access").mockResolvedValue({ accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3600_000, channelId: "channel", channel: "Studio" });
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ items: [{ id: "b", snippet: { title: "recovery", scheduledStartTime: "2030-01-01T00:00:00Z" }, status: { lifeCycleStatus: "ready" } }] }))
    .mockResolvedValueOnce(reply({ items: [{ id: "PL_existing_list", snippet: { title: "Music" } }] }))
    .mockResolvedValueOnce(reply({ id: "b" })).mockResolvedValueOnce(reply({ items: [{ id: "entry" }] }));
  vi.stubGlobal("fetch", fetcher);
  await new YouTubeApi(auth).prepareBroadcast("b", { title: "Music live", description: "Description", privacy: "public", madeForKids: false, playlistIds: ["PL_existing_list"] });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ id: "b", snippet: { title: "Music live", description: "Description" } });
  expect(fetcher.mock.calls[2][0]).toContain("part=id%2Csnippet");
  expect(fetcher.mock.calls.some(call => call[0].includes("transition"))).toBe(false);
});
