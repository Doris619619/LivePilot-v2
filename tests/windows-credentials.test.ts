/** 用独立 Windows 进程验证凭据可跨进程恢复且篡改失败，不使用真实账号秘密。 */
import { expect, it } from "vitest";
import { protectWindows } from "../electron/windows-credentials";
it.skipIf(process.platform !== "win32")("restores CurrentUser DPAPI data in a separate process", async () => { const input = Buffer.from("synthetic-desktop-credential"); const encrypted = await protectWindows(input, true); expect(encrypted.equals(input)).toBe(false); expect(await protectWindows(encrypted, false)).toEqual(input); }, 30_000);
it.skipIf(process.platform !== "win32")("refuses modified encrypted data", async () => { const encrypted = await protectWindows(Buffer.from("synthetic-test"), true); encrypted[encrypted.length - 1] ^= 1; await expect(protectWindows(encrypted, false)).rejects.toThrow("无法解密"); }, 30_000);
