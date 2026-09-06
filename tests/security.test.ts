import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveMedia, scanMedia } from "@/server/media";
import { seal, unseal, Store } from "@/server/storage";
import { guard, failed } from "@/server/http";
import { config } from "@/server/config";
import { YouTubeAuth } from "@/server/youtube/auth";
const dirs: string[] = [];
beforeEach(() => { vi.stubEnv("LIVEPILOT_ORIGIN", "http://127.0.0.1:3010"); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); });
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function folder() {
  const root = await mkdtemp(path.join(os.tmpdir(), "livepilot-media-")); dirs.push(root);
  await mkdir(path.join(root, "videos")); await mkdir(path.join(root, "music"));
  await writeFile(path.join(root, "videos", "学习.mp4"), "video");
  await writeFile(path.join(root, "music", "lofi.mp3"), "music");
  return root;
}
describe("local media containment", () => {
  it("lists only supported files and resolves paths on the server", async () => {
    const root = await folder(); await writeFile(path.join(root, "videos", "secret.txt"), "hidden");
    expect(await scanMedia(root)).toEqual({ videos: ["学习.mp4"], music: ["lofi.mp3"] });
    expect(await resolveMedia(root, "videos", "学习.mp4")).toBe(path.join(root, "videos", "学习.mp4"));
  });
  it.each(["../secret.mp4", "..\\secret.mp4", "C:\\secret.mp4", "/secret.mp4", "%2e%2e%2fsecret.mp4", "test.mp4:secret", "x\u0000.mp4", "..", "secret.txt"])("rejects traversal or invalid input %s", async filename => {
    const root = await folder(); await expect(resolveMedia(root, "videos", filename)).rejects.toThrow("文件名无效");
  });
  it("rejects a media folder junction outside the root", async () => {
    const root = await folder(); const outside = await folder();
    await rm(path.join(root, "videos"), { recursive: true });
    await symlink(path.join(outside, "videos"), path.join(root, "videos"), "junction");
    await expect(resolveMedia(root, "videos", "学习.mp4")).rejects.toThrow("之外");
    expect((await scanMedia(root)).videos).toEqual([]);
  });
});
describe("secrets and local request boundary", () => {
  it("encrypts and authenticates stored credentials", () => {
    const encoded = seal({ token: "SECRET_TOKEN" });
    expect(encoded).not.toContain("SECRET_TOKEN");
    expect(unseal(encoded)).toEqual({ token: "SECRET_TOKEN" });
    const data = Buffer.from(encoded, "base64"); data[25] ^= 1;
    expect(() => unseal(data.toString("base64"))).toThrow("无法解密");
  });
  it("rejects encryption with a missing key", () => {
    vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "");
    expect(() => seal({ token: "secret" })).toThrow("64");
  });
  it("accepts only the local origin with explicit mutation header", () => {
    const headers = { host: "127.0.0.1:3010", origin: "http://127.0.0.1:3010", "x-livepilot": "1" };
    expect(() => guard(new Request("http://127.0.0.1:3010/api/control", { headers }), true)).not.toThrow();
    expect(() => guard(new Request("http://127.0.0.1:3010/api/control", { headers: { ...headers, origin: "https://evil.test" } }), true)).toThrow();
    expect(() => guard(new Request("http://127.0.0.1:3010/api/control", { headers: { host: headers.host, origin: headers.origin } }), true)).toThrow();
    expect(() => guard(new Request("http://127.0.0.1:3010/api/status", { headers: { host: "evil.test" } }))).toThrow();
  });
  it("never returns unknown raw upstream messages", async () => {
    const result = await failed(new Error("streamKey=SECRET password=SECRET")).text();
    expect(result).not.toContain("SECRET");
  });
  it("rejects non-loopback OBS endpoints", () => {
    vi.stubEnv("LIVEPILOT_OBS_WS_URL", "ws://192.168.0.1:4455");
    expect(() => config()).toThrow("127.0.0.1");
  });
  it("writes state atomically and rejects a duplicate disk lock", async () => {
    const root = await folder(); const s = new Store(root);
    await s.write("state.json", { live: true }); expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))).toEqual({ live: true });
    await s.exclusive(async () => { await expect(s.exclusive(async () => {})).rejects.toThrow("control.lock"); });
    await expect(s.exclusive(async () => "ok")).resolves.toBe("ok");
  });
  it("rejects OAuth replay/missing browser transaction before any token request", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const auth = new YouTubeAuth();
    await expect(auth.finish("", "state", "code")).rejects.toThrow("回调无效");
    await expect(auth.finish("a".repeat(64), "state", "code")).rejects.toThrow("已过期");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
