/** AI 互动 UI 回归用合成状态和模拟 HTTP，验证直播时独立操作、旧 Agent、过期状态和聊天文本转义。 */
import { Children, createElement, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LiveChatPanel from "@/app/components/live-chat-panel";
import LiveChatSettings from "@/app/components/live-chat-settings";
import { ApiSettingsProvider } from "@/app/components/api-settings";
import InstanceConsole from "@/app/instance-console";
import { api } from "@/app/client-request";
import { defaultLiveChatConfig, type LiveChatConfig, type LiveChatStatus } from "@/shared/live-chat";
import type { Dashboard, InstanceDescriptor } from "@/shared/types";

const consoleModel = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/app/use-instance", () => ({ useInstance: () => consoleModel.value }));
vi.mock("@/app/client-request", () => ({ api: vi.fn() }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState), useEffect: vi.fn(actual.useEffect) };
});

const instance: InstanceDescriptor = { id: "LIVE", name: "直播频道", agentId: "agent-one", agentName: "直播电脑" };

/** 合成状态只包含公开字段，不提供真实频道、聊天连接或密钥。 */
function fixture(next: Partial<LiveChatStatus> = {}): LiveChatStatus {
  return { config: { ...defaultLiveChatConfig }, configured: true, state: "running", message: "正在回复新留言", sent: 12, skipped: 3, queued: 2, recent: [], updatedAt: 100, ...next };
}

/** 静态渲染真实面板，允许覆盖支持能力和设备新鲜度。 */
function render(status = fixture(), extra: Partial<Parameters<typeof LiveChatPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(LiveChatPanel, { instance, status, supported: true, stale: false, onRefresh: () => {}, ...extra }));
}

/** 每例恢复真实 React 状态钩子，交互例再显式模拟组件内存。 */
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  vi.mocked(useState).mockImplementation(actual.useState);
  vi.mocked(useEffect).mockImplementation(actual.useEffect);
});

/** 不保留跨例浏览器存储或 HTTP stub。 */
afterEach(() => { vi.unstubAllGlobals(); });

/** 抽取真实 React 树中的原生控件，不用复制组件的请求逻辑。 */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...Children.toArray(node.props.children as ReactNode).flatMap(elements)];
}

/** 模拟一次浏览器已挂载的组件状态，并记录独立配置保存及刷新。 */
function mounted(input: { saved?: LiveChatStatus; working?: string; stale?: boolean } = {}) {
  vi.mocked(useEffect).mockImplementation(() => {});
  const values: unknown[] = [input.saved, input.working || "", "", ""];
  const setters = values.map(() => vi.fn()); let index = 0;
  vi.mocked(useState).mockImplementation(((initial?: unknown) => {
    const at = index++; return [at < values.length ? values[at] : initial, setters[at] || vi.fn()];
  }) as typeof useState);
  const refresh = vi.fn();
  const tree = LiveChatPanel({ instance, status: fixture(), supported: true, stale: input.stale || false, onRefresh: refresh });
  return { controls: elements(tree), setters, refresh };
}

/** 实际设置组件从合成已读取状态开始，验证迁移后的保存协议及草稿清理。 */
function mountedSettings(input: { draft?: LiveChatConfig; interval?: string; saving?: boolean } = {}) {
  vi.mocked(useEffect).mockImplementation(() => {});
  const values: unknown[] = [fixture(), input.interval ? { ...(input.draft || defaultLiveChatConfig), intervalSeconds: Number(input.interval) } : input.draft, false, 0, input.saving || false, "", ""];
  const setters = values.map(() => vi.fn()); let index = 0;
  vi.mocked(useState).mockImplementation(((initial?: unknown) => { const at = index++; return at < values.length ? [values[at], setters[at]] : [initial, vi.fn()]; }) as typeof useState);
  const onSaving = vi.fn(); const dispatchEvent = vi.fn(); vi.stubGlobal("window", { dispatchEvent });
  const tree = LiveChatSettings({ instance, offline: false, onSaving });
  return { tree, controls: elements(tree), setters, onSaving, dispatchEvent };
}

it("keeps chat settings operable while the broadcast console is live and its broadcast form is locked", () => {
  const data: Dashboard = {
    state: { phase: "live", stage: "直播中", broadcastId: "synthetic-broadcast", updatedAt: "2026-01-01T00:00:00Z" }, busy: true,
    obs: { ready: true, running: true, streaming: true }, youtube: { connected: true, channel: "合成频道" }, media: { videos: [], music: [] },
    configuration: { liveChat: true, missing: [], privacy: "public", madeForKids: false }, liveChat: fixture(),
  };
  consoleModel.value = { data, durationMs: 1000, selection: { video: "", music: "", videoAudio: false }, working: "", error: "", stale: false, confirmed: false, setConfirmed: vi.fn(), refresh: vi.fn(), act: vi.fn(), busy: true, live: true, pending: false, locked: true, blocker: "直播中", select: vi.fn() };
  const html = renderToStaticMarkup(createElement(ApiSettingsProvider, null, createElement(InstanceConsole, { instance, onChannelChange: () => {}, onUpload: () => {} })));
  expect(html).toMatch(/<fieldset disabled="" class="broadcast-fields"/);
  expect(html).toMatch(/<button type="button" class="btn-ghost">AI 服务设置<\/button>/);
  expect(html).not.toContain('id="chat-preset-agent-one-LIVE"');
  expect(html.match(/<button type="button" role="switch" aria-checked="true" aria-label="直播频道 AI 自动回复观众"[^>]*>/)?.[0]).not.toContain("disabled");
  expect(html.indexOf("chat-runtime-heading-agent-one-LIVE")).toBeGreaterThan(html.indexOf("开始直播"));
});

it("defaults to enabled, moves persona fields out of runtime and directs missing credentials to account AI settings", () => {
  const html = render(fixture({ configured: false, state: "needs_key", message: "请保存 DeepSeek API Key" }));
  expect(html).toContain('role="switch" aria-checked="true"');
  expect(html).toContain("AI 服务设置"); expect(html).not.toContain("发送间隔（5–60 秒）");
  expect(html).toContain("请在 AI 服务设置中配置账号 Key 并开启观众互动，等待设备同步后刷新。");
  expect(html).not.toContain('type="password"'); expect(html).not.toContain("DeepSeek API Key"); expect(html).not.toContain("保存 Key"); expect(html).not.toContain("检查密钥设置");
  expect(html).not.toContain("每日回复条数无上限");
  const settings = renderToStaticMarkup(mountedSettings().tree);
  expect(settings).toContain("YouTube 共享配额"); expect(settings).toContain("队列最多 100 条");
});

it("shows an upgrade explanation without implying unsupported Agents can send replies", () => {
  const html = render(fixture(), { supported: false, status: undefined });
  expect(html).toContain("请更新这台电脑的 LiveNest 客户端，再刷新互动状态");
  expect(html).not.toContain('role="switch"'); expect(html).not.toContain("互动中");
});

it("does not display an enabled switch before the first interaction status arrives", () => {
  const html = render(fixture(), { status: undefined });
  expect(html).toContain('aria-checked="false"'); expect(html).toContain("状态未读取");
  expect(html).toContain("待读取"); expect(html).not.toContain('switch-btn active');
});

it("marks stale status as unknown, disables changes and labels retained interaction history", () => {
  const html = render(fixture(), { stale: true });
  expect(html).toContain("当前状态未知"); expect(html).toContain("上次记录");
  expect(html).not.toContain(">互动中<");
  expect(html.match(/<button type="button" role="switch"[^>]*>/)?.[0]).toContain("disabled");
  expect(html).toContain("已发送</dt><dd>—</dd>");
});

it("renders multilingual and long chat content as escaped text and bounds visible history to 30", () => {
  const recent = Array.from({ length: 32 }, (_, index) => ({ id: String(index), author: index === 31 ? '<script>alert("name")</script>' : `viewer-${index}`, text: index === 31 ? `你好 مرحبا Hola ${"x".repeat(1000)} <img src=x onerror=alert(1)>` : `message-${index}`, reply: "[AI] @观众 Welcome 欢迎", status: "sent" as const, at: 10 }));
  const html = render(fixture({ recent }));
  expect(html).toContain("你好 مرحبا Hola"); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;img");
  expect(html).not.toContain("<script>"); expect(html).not.toContain("<img src=x");
  expect(html.match(/<li>/g)).toHaveLength(30); expect(html).not.toContain(">message-0<"); expect(html).toContain(">message-2<");
});

it("immediately persists the toggle to only its Agent and instance without issuing a broadcast request", async () => {
  vi.mocked(api).mockResolvedValueOnce(fixture({ config: { ...defaultLiveChatConfig, enabled: false }, state: "disabled", updatedAt: 101 }));
  const { controls, refresh } = mounted();
  const toggle = controls.find(element => element.type === "button" && element.props.role === "switch")!;
  (toggle.props.onClick as () => void)();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  const [url, init] = vi.mocked(api).mock.calls[0];
  expect(url).toBe("/api/live-chat");
  expect(JSON.parse(String(init?.body))).toEqual({ action: "configure", agentId: "agent-one", instanceId: "LIVE", config: { ...defaultLiveChatConfig, enabled: false } });
});

it("refreshes public status using only its Agent and instance", async () => {
  vi.mocked(api).mockResolvedValueOnce(fixture({ updatedAt: 102 }));
  const { controls, refresh } = mounted();
  const button = controls.find(element => element.type === "button" && element.props.children === "刷新互动状态")!;
  (button.props.onClick as () => void)();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  const [url, init] = vi.mocked(api).mock.calls[0];
  expect(url).toBe("/api/live-chat"); expect(JSON.parse(String(init?.body))).toEqual({ action: "read", agentId: "agent-one", instanceId: "LIVE" });
});

it("retains the channel authorization entrance without offering credential configuration", () => {
  const html = render(fixture({ state: "needs_attention", recoveryAction: "authorize", message: "频道授权失效，请重新连接频道。" }));
  expect(html).toContain("检查频道授权"); expect(html).not.toContain('type="password"');
  expect(html).not.toContain("检查密钥设置"); expect(html).not.toContain("保存 Key");
});

it("saves the persona and interval together and clears only the successfully saved draft", async () => {
  const config = { ...defaultLiveChatConfig, preset: "playful" as const, customPrompt: "跟随观众语言，回答简短自然。", intervalSeconds: 10 };
  vi.mocked(api).mockResolvedValueOnce(fixture({ config, updatedAt: 102 }));
  const { controls, setters, onSaving, dispatchEvent } = mountedSettings({ draft: { ...config, intervalSeconds: 5 }, interval: "10" });
  const form = controls.find(element => element.type === "form")!;
  (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: () => {} });
  await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledOnce());
  expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toMatchObject({ action: "configure", config });
  expect(setters[1]).toHaveBeenCalledWith(undefined);
  expect(onSaving).toHaveBeenLastCalledWith(false);
  expect(dispatchEvent.mock.calls[0][0].detail).toMatchObject({ target: "agent-one:LIVE", status: { config } });
});

it("turns off with the latest saved preferences instead of resetting them to defaults", async () => {
  const config = { ...defaultLiveChatConfig, preset: "playful" as const, intervalSeconds: 10 };
  vi.mocked(api).mockResolvedValueOnce(fixture({ config: { ...defaultLiveChatConfig, enabled: false }, updatedAt: 102 }));
  const { controls, refresh } = mounted({ saved: fixture({ config, updatedAt: 102 }) });
  (controls.find(element => element.props.role === "switch")!.props.onClick as () => void)();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body)).config).toEqual({ ...config, enabled: false });
});

it("offers all personas in settings and refuses an invalid interval without writing", () => {
  const { tree, controls } = mountedSettings({ interval: "2" });
  const html = renderToStaticMarkup(tree);
  for (const label of ["电台搭子", "俏皮捧场王", "深夜守夜人", "猫猫值班员", "自定义", "发送间隔（秒）"]) expect(html).toContain(label);
  (controls.find(element => element.type === "form")!.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: () => {} });
  expect(api).not.toHaveBeenCalled();
});

it("shows saving feedback and disables its own controls during configuration submission", () => {
  const { controls } = mounted({ working: "configure" });
  const html = renderToStaticMarkup(createElement("div", null, ...controls.filter(element => element.type === "input" || element.type === "button")));
  expect(html).toContain("保存中…");
  expect(controls.find(element => element.props.role === "switch")!.props.disabled).toBe(true);
});

it("refreshes only the dashboard when stale, without issuing a command to an outdated Agent", async () => {
  const { controls, refresh } = mounted({ stale: true });
  const button = controls.find(element => element.type === "button" && element.props.children === "刷新设备状态")!;
  (button.props.onClick as () => void)();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(api).not.toHaveBeenCalled();
});


it("keeps recovery guidance before the settings entrance and never redirects AI failures to OAuth", () => {
  for (const recoveryAction of ["contact_admin", "check_storage", undefined] as const) {
    const html = render(fixture({ state: "needs_attention", recoveryAction, message: "合成故障：需要处理" }));
    expect(html).not.toContain("检查频道授权");
    expect(html.indexOf("合成故障：需要处理")).toBeLessThan(html.indexOf(">AI 服务设置</button>"));
    expect(html).toContain('aria-expanded="false" aria-controls="chat-records-agent-one-LIVE"');
    expect(html).toContain('id="chat-records-agent-one-LIVE" hidden=""');
    expect(html.indexOf("合成故障：需要处理")).toBeLessThan(html.indexOf('id="chat-records-agent-one-LIVE"'));
  }
});
