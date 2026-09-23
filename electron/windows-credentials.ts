/** 直接使用 Windows CurrentUser DPAPI，配置不依赖 Chromium 异步保存的 Local State 密钥。 */
import { execFile } from "node:child_process";
import path from "node:path";
/** 敏感字节只走匿名 stdin/stdout；固定脚本和命令行均不含凭据。 */
export function protectWindows(value: Buffer, encrypt: boolean): Promise<Buffer> {
  if (process.platform !== "win32") return Promise.reject(new Error("此版本需要 Windows 用户凭据保护。"));
  const method = encrypt ? "Protect" : "Unprotect";
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[System.Security.Cryptography.ProtectedData]::" + method + "($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))";
  return new Promise((resolve, reject) => {
    const child = execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error || !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout.trim())) { reject(new Error(encrypt ? "Windows 用户凭据保护失败，配置尚未保存。" : "无法解密本机配置，请使用原 Windows 账户；原文件已保留。")); return; }
      resolve(Buffer.from(stdout.trim(), "base64"));
    });
    child.stdin?.on("error", () => { /* execFile 回调统一报告进程错误，不回显数据。 */ }); child.stdin?.end(value.toString("base64"));
  });
}
