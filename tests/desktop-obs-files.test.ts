/** 未安装 OBS、安装资源缺失和解压损坏回归；只操作临时目录，不启动真实 OBS。 */
import { mkdtemp, mkdir, writeFile, access, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prepareFiles, newInstance } from "../electron/obs-setup";
import type { DesktopInstance } from "../src/shared/desktop";
const f = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: f.exec }));
vi.mock("../electron/settings", () => ({ environment: () => ({}) }));
vi.mock("../src/core/obs/process", () => ({ ObsProcessManager: class {} }));
let root: string; let obsRoot: string; let instance: DesktopInstance;
/** 合成新电脑没有任何系统 OBS 安装，只提供测试内置压缩包。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ln-obs-files-")); obsRoot = path.join(root, "obs/main");
  instance = { id: "main", name: "Main", exe: path.join(obsRoot, "bin/64bit/obs64.exe"), port: 4455, password: "fixture", managed: true, initialized: false };
  f.exec.mockImplementation((_exe, _args, _opts, done) => done(null, "", ""));
});
/** 临时数据清理严格验证目录根与前缀。 */
afterEach(async () => { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-obs-files-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
/** 仅占位资源，解压边界由 mock 验证。 */
async function bundle() { await mkdir(path.join(root, "vendor")); await writeFile(path.join(root, "vendor/obs.zip"), "fixture"); }
it("explains missing bundled OBS before creating any instance files", async () => {
  await expect(prepareFiles(instance, root)).rejects.toThrow("无需另行安装 OBS");
  await expect(access(obsRoot)).rejects.toThrow(); expect(f.exec).not.toHaveBeenCalled();
});
it("guides missing manual OBS to automatic preparation without extracting or taking over", async () => {
  await expect(prepareFiles({ ...instance, managed: false }, root)).rejects.toThrow("准备第一个 OBS"); expect(f.exec).not.toHaveBeenCalled();
});
it("does not mark a partial extraction as complete and allows the same candidate to retry", async () => {
  await bundle(); await expect(prepareFiles(instance, root)).rejects.toThrow("解压未完成"); await expect(access(path.join(obsRoot, ".extracted"))).rejects.toThrow();
  f.exec.mockImplementation((_exe, _args, _opts, done) => { void mkdir(path.dirname(instance.exe), { recursive: true }).then(() => writeFile(instance.exe, "fixture")).then(() => done(null, "", "")); });
  await prepareFiles(instance, root); expect(await readFile(path.join(obsRoot, ".extracted"), "utf8")).toBe("32.2.2");
  expect(await readFile(path.join(obsRoot, ".livenest-owner"), "utf8")).toBe("main");
});
it("does not overwrite an initialized OBS whose executable has disappeared", async () => {
  await mkdir(obsRoot, { recursive: true }); await writeFile(path.join(obsRoot, ".extracted"), "32.2.2"); await writeFile(path.join(obsRoot, ".livenest-owner"), "main"); await writeFile(path.join(obsRoot, "existing-config.json"), "keep");
  await expect(prepareFiles({ ...instance, initialized: true }, root)).rejects.toThrow("没有覆盖已有 OBS"); expect(f.exec).not.toHaveBeenCalled(); expect(await readFile(path.join(obsRoot, "existing-config.json"), "utf8")).toBe("keep");
});

it("allocates a new name, ID and port without reusing a saved candidate",async()=>{
 const first={...instance,name:"OBS 1",initialized:true};const failed={...instance,id:"obs_failed",name:"OBS 2",port:4456};
 const next=await newInstance({dataRoot:root,encryptionKey:"a".repeat(64),instances:[first,failed]});
 expect(next.name).toBe("OBS 3");expect(next.id).not.toBe(first.id);expect(next.id).not.toBe(failed.id);expect([first.port,failed.port]).not.toContain(next.port);expect(next.password).not.toBe(first.password);expect(next.sourceExe).toBeUndefined();
});
