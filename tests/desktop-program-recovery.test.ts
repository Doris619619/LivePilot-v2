/** 程序恢复只补缺文件且要求全 OBS 关闭；目录均为测试临时数据。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertAllObsClosed, copyMissingProgram } from "../electron/obs-program-recovery";
const ports = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../electron/obs-discovery", () => ({ queryObsWindows: ports.query }));
let root: string;
/** 此测试不运行 Windows 命令和 OBS。 */
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "ln-program-repair-")); ports.query.mockReset(); });
/** 清理范围只允许本例生成的直接临时子目录。 */
afterEach(async () => { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ln-program-repair-")) throw new Error("Unsafe cleanup"); await rm(root, { recursive: true, force: true }); });
it("restores a missing executable while preserving an existing binary byte for byte", async () => {
  const source = path.join(root, "source"), target = path.join(root, "target"); await mkdir(source); await mkdir(target);
  await writeFile(path.join(source, "obs64.exe"), "restored"); await writeFile(path.join(source, "obs.dll"), "bundled"); await writeFile(path.join(target, "obs.dll"), "original");
  await copyMissingProgram(source, target);
  expect(await readFile(path.join(target, "obs64.exe"), "utf8")).toBe("restored"); expect(await readFile(path.join(target, "obs.dll"), "utf8")).toBe("original");
});
it("requires a confirmed zero process count rather than treating an unknown result as closed", async () => {
  for (const count of [1, null, "0"]) { ports.query.mockResolvedValueOnce(count); await expect(assertAllObsClosed()).rejects.toMatchObject({ code: "OBS_MAINTENANCE" }); }
  ports.query.mockResolvedValueOnce(0); await expect(assertAllObsClosed()).resolves.toBeUndefined();
});
