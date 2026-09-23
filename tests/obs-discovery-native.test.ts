/** 在真实 Windows PowerShell 中验证扫描路径的 Unicode 环境输入和 JSON 输出。 */
import { expect, it } from "vitest";
import { queryObsWindows } from "../electron/obs-discovery";
it.skipIf(process.platform !== "win32")("preserves Chinese OBS paths through the Windows process bridge", async () => {
  const exe = "D:\\直播工具\\客户一号\\bin\\64bit\\obs64.exe";
  const result = await queryObsWindows("@{paths=@($env:LN_SCAN_EXE)}|ConvertTo-Json -Compress", { LN_SCAN_EXE: exe });
  expect(result.paths).toEqual([exe]);
}, 20000);
