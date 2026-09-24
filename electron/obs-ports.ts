/** OBS 端口选择同时核对 Windows 实际监听表与双栈绑定，不改变占用端口的进程。 */
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { AppError } from "../src/core/errors";

/** 只提取本地 TCP 监听端口；IPv4、IPv6 和通配地址均视为占用。 */
export function listeningPorts(output: string) {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0] !== "TCP" || !["LISTENING", "LISTEN"].includes(fields[3])) continue;
    const port = Number(fields[1].slice(fields[1].lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return ports;
}

/** 监听双栈通配地址；仅系统不支持 IPv6 时退回 IPv4，不能把占用错误当作不支持。 */
function canBind(port: number, host = "::"): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (host === "::" && ["EAFNOSUPPORT", "EPROTONOSUPPORT", "EADDRNOTAVAIL"].includes(error.code || "")) void canBind(port, "0.0.0.0").then(resolve);
      else resolve(false);
    });
    server.listen({ host, port, exclusive: true, ipv6Only: false }, () => server.close(error => resolve(!error)));
  });
}

/** Windows 允许部分地址复用，因此先排除所有监听端口；启动前仍由实例启动器复查归属。 */
export async function freePort(excluded: number[], start = 4455): Promise<number> {
  const occupied = process.platform === "win32" ? await new Promise<Set<number>>((resolve, reject) => {
    execFile("netstat.exe", ["-ano"], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new AppError("OBS_CONFIG", "无法核对已占用的 OBS 端口，请稍后重新检查；未创建新实例。"));
      else resolve(listeningPorts(stdout));
    });
  }) : new Set<number>();
  for (let port = Math.max(1024, start); port < Math.min(start + 200, 65536); port++) {
    if (!excluded.includes(port) && !occupied.has(port) && await canBind(port)) return port;
  }
  throw new AppError("OBS_CONFIG", "没有找到空闲 OBS 端口，请处理端口占用后重试。");
}
