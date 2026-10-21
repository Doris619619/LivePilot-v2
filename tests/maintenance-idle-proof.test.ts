/** 坏OBS凭据的有限本机空闲证明：浏览器无权提交，未知频道和其他实例仍保持维护保护。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPairing, pairAgent, openSession, heartbeatAgent } from "@/cloud/agents";
import { beginMaintenance } from "@/cloud/maintenance";
import { POST } from "@/app/api/agent/[...path]/route";
import { initialState } from "@/core/control";
import { agentStore } from "@/cloud/agents";
import { enqueue } from "@/cloud/tasks";
import type { AgentSnapshot } from "@/shared/remote";
let root: string, session: string;
const token = "d".repeat(64);
/** 主目标仅OBS未知；第二目标已有权威空闲快照。 */
function snapshots(): AgentSnapshot[] { return ["main", "second"].map(id => ({ instance: { id, name: id }, observedAt: Date.now(), dashboard: { state: initialState(), busy: false, obs: { ready: id !== "main", running: true, streaming: id === "main" ? null : false }, youtube: { connected: true }, media: { videos: [], music: [] }, configuration: { missing: [], privacy: "unlisted", madeForKids: false } } })); }
/** 生成与本设备匹配的新鲜只读检查声明；真实产品由桌面内部实查生成。 */
function proof() { return { instanceId: "main", observedAt: Date.now(), basis: "obs-status" as const }; }
/** 使用真实云端注册与设备心跳，未访问本机OBS。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "ln-idle-proof-")); vi.stubEnv("LIVEPILOT_DATA_ROOT", root); vi.stubEnv("LIVEPILOT_ENCRYPTION_KEY", "a".repeat(64)); vi.stubEnv("LIVEPILOT_MODE", "cloud"); vi.stubEnv("LIVEPILOT_ORIGIN", "https://synthetic.invalid"); const pair = await createPairing("pc", "Synthetic"); await pairAgent("pc", pair.code, "b".repeat(64)); session = (await openSession("pc", randomUUID(), [{ id: "main", name: "Main" }, { id: "second", name: "Second" }])).session; await heartbeatAgent("pc", session, snapshots()); });
/** 仅清理本轮测试根目录。 */
afterEach(async () => { vi.unstubAllEnvs(); if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-idle-proof-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
it("allows a fresh authenticated local OBS check to replace only its unknown control state", async () => { await expect(beginMaintenance("pc", token)).rejects.toMatchObject({ code: "BUSY" }); await expect(beginMaintenance("pc", token, proof())).resolves.toEqual({ token }); });
it("allows stopped historical broadcasts only with explicit terminal YouTube evidence", async () => { const current = snapshots(); current[0].dashboard.state.phase = "stopped"; current[0].dashboard.state.broadcastId = "historical"; current[0].dashboard.youtube.lifecycle = "complete"; await heartbeatAgent("pc", session, current); await expect(beginMaintenance("pc", token, proof())).resolves.toEqual({ token }); });
it.each(["old", "future", "wrong-target", "invalid-basis"])("rejects %s proofs", async mode => { const p = proof(); if (mode === "old") p.observedAt -= 21000; if (mode === "future") p.observedAt += 10000; if (mode === "wrong-target") p.instanceId = "missing"; if (mode === "invalid-basis") Object.assign(p, { basis: "browser-assertion" }); await expect(beginMaintenance("pc", token, p)).rejects.toMatchObject({ code: "MAINTENANCE_PROOF" }); });
it.each(["live", "starting", "intent", "platform-unknown", "platform-live", "streaming", "other-unknown"])("does not bypass %s", async mode => { const current = snapshots(), d = current[0].dashboard; if (mode === "live") d.state.phase = "live"; if (mode === "starting") d.state.phase = "starting"; if (mode === "intent") d.state.broadcastIntent = true; if (mode === "platform-unknown") { d.state.phase = "stopped"; d.state.broadcastId = "unknown"; d.youtube.error = "频道读取暂不可用"; } if (mode === "platform-live") { d.state.phase = "stopped"; d.state.broadcastId = "active"; d.youtube.lifecycle = "live"; } if (mode === "streaming") d.obs.streaming = true; if (mode === "other-unknown") current[1].dashboard.obs.streaming = null; await heartbeatAgent("pc", session, current); await expect(beginMaintenance("pc", token, proof())).rejects.toMatchObject({ code: "BUSY" }); });
it("refuses proof submitted without Agent credentials or from a browser Origin", async () => { const body = JSON.stringify({ token, verifiedIdle: proof() }); const send = (headers: Record<string, string>) => POST(new Request("https://synthetic.invalid/api/agent/maintenance-begin", { method: "POST", headers: { host: "synthetic.invalid", "content-type": "application/json", "x-livepilot-agent": "pc", "x-livepilot-session": session, ...headers }, body }), { params: Promise.resolve({ path: ["maintenance-begin"] }) }); expect((await send({})).status).toBe(401); expect((await send({ authorization: "Bearer " + "b".repeat(64), origin: "https://synthetic.invalid" })).status).toBe(403); });
it("never applies one target's proof to another unknown target", async () => { await expect(beginMaintenance("pc", token, { ...proof(), instanceId: "second" })).rejects.toMatchObject({ code: "BUSY" }); });
it.each(["oauth", "upload", "publishing"])("preserves %s work protection even with a fresh proof", async kind => { if (kind === "publishing") await agentStore("pc").write("publishing-runtime.json", { busy: true, at: Date.now() }); else await enqueue({ agentId: "pc", instanceId: "main" }, "tester", kind === "oauth" ? { kind: "oauth-begin" } : { kind: "upload-create", uploadId: randomUUID(), input: { kind: "videos", filename: "fixture.mp4", size: 4, fingerprint: "a".repeat(64) } }); await expect(beginMaintenance("pc", token, proof())).rejects.toMatchObject({ code: "BUSY" }); });
