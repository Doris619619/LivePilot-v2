/** 账号配置包真实文件/API 回归；没有设备或频道也可管理，不触发外部调用。 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { authenticate } from "@/server/access";
import { GET, POST } from "@/app/api/publishing-templates/route";
import { publishingStore } from "@/cloud/publishing";
import { fixtureJob } from "./publishing-fixtures";
import { publishingTemplate, bindPublishingTemplate } from "@/shared/publishing-template";
vi.mock("@/server/access", async original => ({ ...await original<typeof import("@/server/access")>(), authenticate: vi.fn() }));
let root: string;
const origin = "http://127.0.0.1:3010";
/** 隔离临时根目录，始终只使用合成账号。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "publishing-templates-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ORIGIN", origin); vi.mocked(authenticate).mockResolvedValue({ username: "alice", role: "customer" }); });
/** 核对测试目录后清理，不接触开发配置。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("publishing-templates-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 路由验收保留同源检查，调用者不能通过 body 指定配置所有者。 */
function request(body?: unknown, from = origin) { return new Request(origin + "/api/publishing-templates", { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:3010", origin: from, "x-livepilot": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }

it("saves without an agent/account, handles revisions and rejects binding fields", async () => {
  const template = publishingTemplate(fixtureJob().profile);
  expect((await POST(request(template))).status).toBe(200);
  expect((await POST(request(template))).status).toBe(200);
  expect((await POST(request({ ...template, titleTemplate: "Competing" }))).status).toBe(409);
  expect((await POST(request({ ...template, revision: 2, titleTemplate: "Updated" }))).status).toBe(200);
  for (const extra of [{ agentId: "pc" }, { channelId: "channel_one" }, { playlistIds: ["PL_one"] }, { owner: "bob" }, { thumbnailFilename: "cover.jpg" }]) expect((await POST(request({ ...template, ...extra }))).status).toBe(400);
  expect((await POST(request(template, "https://invalid.example"))).status).toBe(403);
  for (const role of ["customer", "admin"] as const) { vi.mocked(authenticate).mockResolvedValue({ username: "bob", role }); expect((await (await GET(request())).json()).profiles).toEqual([]); }
});

it("imports only owned legacy profiles once, preserves originals and snapshots, and disambiguates names", async () => {
  const profile = { ...fixtureJob().profile, playlistIds: ["PL_original"], thumbnailMode: "fixed" as const, thumbnailFilename: "old.jpg" };
  const legacy = { profiles: [{ owner: "alice", value: profile }, { owner: "alice", value: { ...profile, id: randomUUID(), channelId: "channel_two" } }, { owner: "bob", value: { ...profile, id: randomUUID() } }], jobs: [fixtureJob()], plans: [{ profile }] };
  await publishingStore().write("state.json", legacy);
  const first = (await (await GET(request())).json()).profiles;
  expect(first).toHaveLength(2); expect(new Set(first.map((item: { name: string }) => item.name)).size).toBe(2);
  for (const template of first) { expect(template).not.toHaveProperty("channelId"); expect(template).not.toHaveProperty("playlistIds"); expect(template).not.toHaveProperty("thumbnailFilename"); }
  const edited = { ...first[0], revision: first[0].revision + 1, titleTemplate: "Account version" };
  expect((await POST(request(edited))).status).toBe(200);
  expect((await (await GET(request())).json()).profiles.find((item: { id: string }) => item.id === profile.id).titleTemplate).toBe("Account version");
  expect(await publishingStore().read("state.json")).toEqual(legacy);
});

it("requires device-specific fixed artwork only when binding an execution snapshot", () => {
  const template = { ...publishingTemplate(fixtureJob().profile), thumbnailMode: "fixed" as const };
  const use = { agentId: "second_pc", instanceId: "second", accountId: randomUUID(), channelId: "second_channel", playlistIds: ["PL_selected"], templateRevision: template.revision };
  expect(() => bindPublishingTemplate(template, use)).toThrow();
  expect(bindPublishingTemplate(template, { ...use, thumbnailFilename: "new.jpg" })).toMatchObject({ agentId: "second_pc", instanceId: "second", channelId: "second_channel", playlistIds: ["PL_selected"], thumbnailFilename: "new.jpg" });
});

it("keeps old copy data but does not apply shared title or description to new videos", () => {
  const template = publishingTemplate(fixtureJob().profile);
  template.titleTemplate = "Old shared title"; template.descriptionTemplate = "Old shared description";
  template.ai.enabled = true; template.ai.language = "Old language";
  template.ai.fallbackTitle = "Old fallback"; template.ai.fallbackDescription = "Old description";
  const original = structuredClone(template);
  const bound = bindPublishingTemplate(template, { agentId: "pc", instanceId: "main", accountId: randomUUID(), channelId: "channel_one", playlistIds: [], templateRevision: template.revision });
  expect(bound.ai.enabled).toBe(false); expect(bound.ai.language).toBe("English");
  expect(bound.titleTemplate).toBe("{{packageName}}"); expect(bound.descriptionTemplate).toBe("");
  expect(bound.ai.fallbackTitle).toBe("{{packageName}}"); expect(bound.ai.fallbackDescription).toBe("");
  expect(template).toEqual(original);
});
