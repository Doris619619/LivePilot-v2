/** 双栈端口分配回归，使用短生命周期本机监听，不启动 OBS 或结束已有程序。 */
import { createServer, type AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { freePort, listeningPorts } from "../electron/obs-ports";

it("recognizes IPv6 and wildcard listeners without confusing remote connections", () => {
  expect([...listeningPorts("TCP [::]:4455 [::]:0 LISTENING 123\nTCP 0.0.0.0:4456 0.0.0.0:0 LISTENING 124\nTCP 127.0.0.1:50000 127.0.0.1:4457 ESTABLISHED 125")]).toEqual([4455, 4456]);
});
for (const host of ["0.0.0.0", "::"]) it("skips an actual " + host + " listener and saved ports", async context => {
  const server = createServer();
  try {
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host, port: 0, ipv6Only: host === "::" }, resolve); }); }
    catch (error) { if (host === "::" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code || "")) return context.skip(); throw error; }
    const port = (server.address() as AddressInfo).port;
    const available = await freePort([port + 1], port);
    expect(available).toBeGreaterThan(port + 1); expect(server.listening).toBe(true);
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
});
