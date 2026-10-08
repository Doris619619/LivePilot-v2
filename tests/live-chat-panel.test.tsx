/** AI 互动 UI 回归用合成状态和模拟 HTTP，验证直播时独立操作、旧 Agent、过期状态和聊天文本转义。 */
import { Children, createElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LiveChatPanel from "@/app/components/live-chat-panel";
import InstanceConsole from "@/app/instance-console";
import { api } from "@/app/client-request";
import { defaultLiveChatConfig, type LiveChatConfig, type LiveChatStatus } from "@/shared/live-chat";
import type { Dashboard, InstanceDescriptor } from "@/shared/types";

const consoleModel = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/app/use-instance", () => ({ useInstance: () => consoleModel.value }));
vi.mock("@/app/client-request", () => ({ api: vi.fn() }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
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
});

/** 不保留跨例浏览器存储或 HTTP stub。 */
afterEach(() => { vi.unstubAllGlobals(); });

/** 抽取真实 React 树中的原生控件，不用复制组件的请求逻辑。 */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...Children.toArray(node.props.children as ReactNode).flatMap(elements)];
}

/** 模拟一次浏览器已挂载的组件状态，并记录独立配置保存及刷新。 */
function mounted(input: { draft?: Omit<LiveChatConfig, "enabled">; interval?: string; working?: string; stale?: boolean } = {}) {
  const values: unknown[] = [undefined, input.draft, input.interval, input.working || "", "", ""];
  const setters = values.map(() => vi.fn()); let index = 0;
  vi.mocked(useState).mockImplementation(((initial?: unknown) => {
    const at = index++; return [at < values.length ? values[at] : initial, setters[at] || vi.fn()];
  }) as typeof useState);
  const refresh = vi.fn();
  const tree = LiveChatPanel({ instance, status: fixture(), supported: true, stale: input.stale || false, onRefresh: refresh });
  return { controls: elements(tree), setters, refresh };
}

it("keeps chat settings operable while the broadcast console is live and its broadcast form is locked", () => {
  const data: Dashboard = {
    state: { phase: "live", stage: "直播中", broadcastId: "synthetic-broadcast", updatedAt: "2026-01-01T00:00:00Z" }, busy: true,
    obs: { ready: true, running: true, streaming: true }, youtube: { connected: true, channel: "合成频道" }, media: { videos: [], music: [] },
    configuration: { liveChat: true, missing: [], privacy: "public", madeForKids: false }, liveChat: fixture(),
  };
  consoleModel.value = { data, durationMs: 1000, selection: { video: "", music: "", videoAudio: false }, working: "", error: "", stale: false, confirmed: false, setConfirmed: vi.fn(), refresh: vi.fn(), act: vi.fn(), busy: true, live: true, pending: false, locked: true, blocker: "直播中", select: vi.fn() };
  const html = renderToStaticMarkup(createElement(InstanceConsole, { instance, onChannelChange: () => {}, onUpload: () => {} }));
  expect(html).toMatch(/<fieldset disabled="" class="broadcast-fields"/);
  expect(html.match(/<select id="chat-preset-agent-one-LIVE"[^>]*>/)?.[0]).not.toContain("disabled");
  expect(html.match(/<textarea id="chat-prompt-agent-one-LIVE"[^>]*>/)?.[0]).not.toContain("disabled");
  expect(html.match(/<button type="button" role="switch" aria-checked="true" aria-label="直播频道 AI 自动回复观众"[^>]*>/)?.[0]).not.toContain("disabled");
  expect(html.indexOf("AI 观众互动")).toBeGreaterThan(html.indexOf("开始直播"));
});

it("defaults to enabled, exposes four personas and directs missing environment configuration to administrators", () => {
  const html = render(fixture({ configured: false, state: "needs_key", message: "请保存 DeepSeek API Key" }));
  expect(html).toContain('role="switch" aria-checked="true"');
  for (const label of ["友善陪聊", "活泼幽默", "安静温柔", "自定义", "发送间隔（秒）"]) expect(html).toContain(label);
  expect(html).toContain("直播电脑的 DeepSeek 环境配置未就绪，请联系管理员");
  expect(html).not.toContain('type="password"'); expect(html).not.toContain("DeepSeek API Key"); expect(html).not.toContain("保存 Key"); expect(html).not.toContain("检查密钥设置");
  expect(html).toContain("每日回复条数无上限"); expect(html).toContain("项目共享配额");
});

it("shows an upgrade explanation without implying unsupported Agents can send replies", () => {
  const html = render(fixture(), { supported: false, status: undefined });
  expect(html).toContain("请升级 Agent 后刷新状态");
  expect(html).not.toContain('role="switch"'); expect(html).not.toContain("互动中");
});

it("marks stale status as unknown, disables changes and labels retained interaction history", () => {
  const html = render(fixture(), { stale: true });
  expect(html).toContain("当前状态未知"); expect(html).toContain("上次记录");
  expect(html).not.toContain(">互动中<");
  expect(html.match(/<select id="chat-preset-agent-one-LIVE"[^>]*>/)?.[0]).toContain("disabled");
  expect(html.match(/<input id="chat-interval-agent-one-LIVE"[^>]*>/)?.[0]).toContain("disabled");
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
  const html = render(fixture({ state: "needs_attention", message: "频道授权失效，请重新连接频道。" }));
  expect(html).toContain("检查频道授权"); expect(html).not.toContain('type="password"');
  expect(html).not.toContain("检查密钥设置"); expect(html).not.toContain("保存 Key");
});

it("saves the persona and interval together and clears only the successfully saved draft", async () => {
  const config = { ...defaultLiveChatConfig, preset: "playful" as const, customPrompt: "跟随观众语言，回答简短自然。", intervalSeconds: 10 };
  vi.mocked(api).mockResolvedValueOnce(fixture({ config, updatedAt: 102 }));
  const { controls, setters, refresh } = mounted({ draft: { ...config, intervalSeconds: 5 }, interval: "10" });
  const form = controls.find(element => element.type === "form")!;
  (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault: () => {} });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toMatchObject({ action: "configure", config });
  expect(setters[1]).toHaveBeenCalledWith(undefined); expect(setters[2]).toHaveBeenCalledWith(undefined);
});

it("can turn off immediately while retaining an unsaved invalid interval", async () => {
  vi.mocked(api).mockResolvedValueOnce(fixture({ config: { ...defaultLiveChatConfig, enabled: false }, updatedAt: 102 }));
  const { controls, setters, refresh } = mounted({ interval: "2" });
  (controls.find(element => element.props.role === "switch")!.props.onClick as () => void)();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body)).config).toEqual({ ...defaultLiveChatConfig, enabled: false });
  expect(setters[2]).not.toHaveBeenCalled();
});

it("shows saving feedback and disables its own controls during configuration submission", () => {
  const { controls } = mounted({ working: "configure" });
  const html = renderToStaticMarkup(createElement("div", null, ...controls.filter(element => element.type === "input" || element.type === "button")));
  expect(html).toContain("保存中…");
  expect(controls.find(element => element.type === "input" && element.props.type === "number")!.props.disabled).toBe(true);
  expect(controls.find(element => element.props.role === "switch")!.props.disabled).toBe(true);
});

it("refreshes only the dashboard when stale, without issuing a command to an outdated Agent", async () => {
  const { controls, refresh } = mounted({ stale: true });
  const button = controls.find(element => element.type === "button" && element.props.children === "刷新设备状态")!;
  (button.props.onClick as () => void)();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(api).not.toHaveBeenCalled();
});
