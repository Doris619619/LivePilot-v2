/** 系统代理回归：独立 Node 沿用 HTTPS 网络路径，保留显式代理与本机直连边界。 */
import { afterEach, expect, it, vi } from "vitest";
import { agentEnvironment } from "../electron/agent-network";
afterEach(() => vi.useRealTimers());
it("inherits the system HTTP proxy before Node starts and preserves loopback bypass", async () => {
  const source = { NODE_ENV: "test" as const, NO_PROXY: "example.invalid", NODE_OPTIONS: "unsafe", livepilot_token: "secret", PATH: "fixture" };
  const resolve = vi.fn().mockResolvedValue("PROXY proxy.example.invalid:18342; DIRECT");
  const env = await agentEnvironment(source, "https://controller.invalid", resolve);
  expect(resolve).toHaveBeenCalledWith("https://controller.invalid");
  expect(env.HTTPS_PROXY).toBe("http://proxy.example.invalid:18342"); expect(env.https_proxy).toBe(env.HTTPS_PROXY);
  expect(env.NO_PROXY).toBe("example.invalid,localhost,127.0.0.1,::1,[::1]"); expect(env.no_proxy).toBe(env.NO_PROXY);
  expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.livepilot_token).toBeUndefined(); expect(env.PATH).toBe("fixture");
  expect(source.NO_PROXY).toBe("example.invalid"); expect(source.NODE_OPTIONS).toBe("unsafe");
});
it("preserves explicit proxies and Node lowercase precedence without resolving system settings", async () => {
  const resolve = vi.fn();
  const env = await agentEnvironment({ NODE_ENV: "test", HTTPS_PROXY: "http://upper.invalid:80", https_proxy: "http://lower.invalid:80", HTTP_PROXY: "http://http.invalid:80", NO_PROXY: "upper.invalid", no_proxy: "lower.invalid" }, "https://controller.invalid", resolve);
  expect(resolve).not.toHaveBeenCalled(); expect(env.https_proxy).toBe("http://lower.invalid:80"); expect(env.HTTPS_PROXY).toBe(env.https_proxy); expect(env.HTTP_PROXY).toBe("http://http.invalid:80"); expect(env.no_proxy).toContain("lower.invalid,"); expect(env.no_proxy).not.toContain("upper.invalid");
});
it("recognizes Windows mixed-case proxy variables without overriding them with the system proxy", async () => {
  const resolve = vi.fn(); const env = await agentEnvironment({ NODE_ENV: "test", Https_Proxy: "http://explicit.invalid:19876", No_Proxy: "internal.invalid" }, "https://controller.invalid", resolve);
  expect(resolve).not.toHaveBeenCalled(); expect(env.HTTPS_PROXY).toBe("http://explicit.invalid:19876"); expect(env.Https_Proxy).toBeUndefined(); expect(env.no_proxy).toContain("internal.invalid,");
});
it("supports HTTPS proxies and preserves DIRECT without inventing a local proxy", async () => {
  expect((await agentEnvironment({ NODE_ENV: "test" }, "https://controller.invalid", async () => "HTTPS proxy.invalid:443")).HTTPS_PROXY).toBe("https://proxy.invalid");
  expect((await agentEnvironment({ NODE_ENV: "test" }, "https://controller.invalid", async () => "DIRECT; PROXY fallback.invalid:80")).HTTPS_PROXY).toBeUndefined();
});
it.each(["SOCKS5 127.0.0.1:1080; DIRECT", "", "PROXY user:secret@proxy.invalid:80", "PROXY proxy.invalid:bad", "PROXY proxy.invalid:80/path"])("fails clearly instead of guessing for unsupported or invalid system routes", async route => {
  await expect(agentEnvironment({ NODE_ENV: "test" }, "https://controller.invalid", async () => route)).rejects.toThrow(/系统代理/);
  await expect(agentEnvironment({ NODE_ENV: "test" }, "https://controller.invalid", async () => route)).rejects.not.toThrow("secret");
});
it("bounds resolution time and sanitizes resolver failures", async () => {
  await expect(agentEnvironment({ NODE_ENV: "test" }, "https://controller.invalid", async () => { throw new Error("proxy-password"); })).rejects.toThrow("无法读取系统代理");
  vi.useFakeTimers(); const pending = agentEnvironment({ NODE_ENV: "test" }, "https://controller.invalid", () => new Promise(() => {}));
  const rejected = expect(pending).rejects.toThrow("无法读取系统代理"); await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(vi.getTimerCount()).toBe(0);
});
