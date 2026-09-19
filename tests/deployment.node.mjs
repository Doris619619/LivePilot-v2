/** 隔离验证部署初始化不会覆盖旧密钥、接受模板注入或误配设备；不访问真实云端。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { parseEnv } from "node:util";
import { cloudValues, agentValues, createEnv, envText, domainName, originDomain } from "../scripts/deployment/config.mjs";
import { render, serviceUnit } from "../scripts/deployment/render.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 每项测试独立配置目录，始终清理，绝不读取用户 .data。 */
async function fixture(fn) { const dir = await mkdtemp(path.join(os.tmpdir(), "livepilot-deploy-")); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
/** 运行真实 CLI 来覆盖参数处理、退出码及生成文件，不 mock 文件系统。 */
function setup(dir, args) { return spawnSync(process.execPath, [path.join(root, "scripts/setup-deployment.mjs"), ...args], { cwd: dir, encoding: "utf8" }); }
test("部署域名拒绝 Nginx/路径/凭据注入", () => {
  for (const value of ["203.0.113.10", "live.example.com;", "a\nserver", "*.example.com", "example.com/path", "-a.example.com", "https://live.example.com"]) assert.throws(() => domainName(value));
  for (const value of ["http://live.example.com", "https://live.example.com/", "https://user@live.example.com", "https://live.example.com:8443"]) assert.throws(() => originDomain(value));
  assert.equal(originDomain("https://live.example.com"), "live.example.com");
  assert.throws(() => serviceUnit("/usr/bin/node\nUser=root"));
});
test("dotenv 保留密码特殊字符及 Windows 路径", () => {
  const values = { KEY: "a#b$c'xyz", PATH_VALUE: "D:\\video files\\movie", DOUBLE: 'a"b' };
  assert.deepEqual(parseEnv(envText(values)), values);
  assert.throws(() => envText({ KEY: "a\nb" }));
});
test("已有配置永不覆盖，云端密钥每个部署独立生成", async () => fixture(async dir => {
  const file = path.join(dir, ".env.cloud"); const a = cloudValues("live.example.com");
  assert.equal(await createEnv(file, a), true); assert.equal(await createEnv(file, cloudValues("other.example.com")), false);
  assert.equal(parseEnv(await readFile(file, "utf8")).LIVEPILOT_ENCRYPTION_KEY, a.LIVEPILOT_ENCRYPTION_KEY);
  assert.notEqual(a.LIVEPILOT_ENCRYPTION_KEY, cloudValues("live.example.com").LIVEPILOT_ENCRYPTION_KEY);
}));
test("旧本机转换保留密钥、数据、实例以及代理仅在显式选择时加入", () => {
  const old = { LIVEPILOT_ENCRYPTION_KEY: "a".repeat(64), LIVEPILOT_DATA_ROOT: "D:/old-data", LIVEPILOT_INSTANCES: "main,obs_a", GOOGLE_CLIENT_SECRET: "private" };
  const next = agentValues("live.example.com", "studio_a", old, "http://127.0.0.1:7890");
  for (const [key, value] of Object.entries(old)) assert.equal(next[key], value);
  assert.equal(next.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.throws(() => agentValues("live.example.com", "../bad"));
  assert.throws(() => agentValues("live.example.com", "valid", {}, "http://user:pass@proxy:80"));
});
test("真实 cloud CLI 生成配置与 Google 清单，重复运行保持原数据", async () => fixture(async dir => {
  const first = setup(dir, ["cloud", "--domain", "live.example.com"]); assert.equal(first.status, 0, first.stderr);
  const before = await readFile(path.join(dir, ".env.cloud"), "utf8");
  assert.equal(setup(dir, ["cloud", "--domain", "other.example.com"]).status, 0);
  assert.equal(await readFile(path.join(dir, ".env.cloud"), "utf8"), before);
  const oauth = JSON.parse(await readFile(path.join(dir, ".data/setup/google-oauth.json"), "utf8"));
  assert.equal(oauth.authorizedRedirectUri, "https://live.example.com/api/youtube/callback");
  const out = path.join(dir, "rendered"); await render(path.join(dir, ".env.cloud"), out, "/usr/bin/node", "/usr/bin/certbot");
  const nginx = await readFile(path.join(out, "nginx-https.conf"), "utf8");
  assert.ok(nginx.includes("server_name live.example.com;")); assert.ok(!nginx.includes(parseEnv(before).LIVEPILOT_ENCRYPTION_KEY));
  assert.match(nginx, /location \^~ \/downloads\/ \{/);
  assert.match(nginx, /alias \/var\/www\/livenest-downloads\/;/);
  assert.match(nginx, /autoindex off;/); assert.match(nginx, /disable_symlinks on;/);
  assert.match(nginx, /limit_except GET \{ deny all; \}/);
  assert.ok(!nginx.includes("alias /var/lib/livepilot"));
  const cli = spawnSync(process.execPath, [path.join(root, "scripts/deployment/render.mjs"), "--env", path.join(dir, ".env.cloud"), "--out", out], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout.trim(), "live.example.com");
}));
test("已配对设备或旧数据不能被新初始化重新分配身份", async () => fixture(async dir => {
  await writeFile(path.join(dir, "old.env"), envText({ LIVEPILOT_ENCRYPTION_KEY: "a".repeat(64) }));
  await mkdir(path.join(dir, ".data/agent"), { recursive: true });
  await writeFile(path.join(dir, ".data/agent/identity.json"), "{}");
  const result = setup(dir, ["agent", "--domain", "live.example.com", "--id", "studio_a", "--from", "old.env"]);
  assert.equal(result.status, 1); assert.match(result.stderr, /已配对/);
  await assert.rejects(readFile(path.join(dir, ".env.agent")));
}));
test("缺失旧密钥拒绝迁移且不落盘半成品", async () => fixture(async dir => {
  await writeFile(path.join(dir, "old.env"), "LIVEPILOT_INSTANCES=main\n");
  const result = setup(dir, ["agent", "--domain", "live.example.com", "--id", "studio_a", "--from", "old.env"]);
  assert.equal(result.status, 1); await assert.rejects(readFile(path.join(dir, ".env.agent")));
}));

/** 用本机代理接收真实子进程 fetch，验证配置在网络栈初始化之前加载。 */
test("手动/计划任务共用启动器，env 内代理实际接管子进程网络", async () => fixture(async dir => {
  const sockets = new Set(); let requests = 0;
  const proxy = createServer((req, res) => { requests++; res.end("proxy-ok"); });
  proxy.on("connect", (req, socket) => {
    assert.equal(req.url, "agent-probe.invalid:80");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => { requests++; socket.end("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nproxy-ok"); });
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await mkdir(path.join(dir, "scripts")); await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "scripts/agent-launch.mjs"), await readFile(path.join(root, "scripts/agent-launch.mjs")));
    await writeFile(path.join(dir, "dist/agent.cjs"), `if (process.argv[2] !== 'run') process.exit(2); fetch('http://agent-probe.invalid/probe').then(r => r.text()).then(t => { if(t !== 'proxy-ok') process.exit(3); console.log('PROXY_VERIFIED'); }).catch(() => process.exit(4));`);
    const file = path.join(dir, "agent settings.env");
    await createEnv(file, { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "" });
    const env = { ...process.env, LIVEPILOT_ENV_FILE: file };
    for (const key of Object.keys(env)) if (/proxy|node_options/i.test(key)) delete env[key];
    const result = await promisify(execFile)(process.execPath, [path.join(dir, "scripts/agent-launch.mjs"), "run"], { env, timeout: 15000 });
    assert.match(result.stdout, /PROXY_VERIFIED/); assert.equal(requests, 1);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); }
}));
