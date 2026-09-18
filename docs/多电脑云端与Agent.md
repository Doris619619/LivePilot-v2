<!-- 文件用途：说明多电脑身份、任务语义、素材中转及云端/Agent 的部署和恢复。 -->
# 多电脑云端与 Agent

云端网页 → HTTPS 出站 Agent → 本机多个 Portable OBS → YouTube。云端管理成员、设备和投递记录；完整开停播、频道令牌、素材和执行结果归直播电脑。不同设备可同时拥有 `main`，身份始终为 `agentId + instanceId`。

新电脑的逐步操作与 OBS 实机标注见根目录 [配置.md](../配置.md)；本文主要解释部署、设备身份及恢复语义。

## 模式与运行边界

- `LIVEPILOT_MODE=local` 保留原有单机服务；`cloud` 使用设备目录及远程任务，不读取 Windows OBS 配置。Agent 是独立 Node 程序（22.23+ 的 22 系列或 24+），运行时不需要 Next.js。
- 当前每台设备登记最多 64 个实例；能力及实际上限仍取决于 CPU、GPU 和上传带宽。实例 ID 清单首次上线后保持稳定；改变清单须显式迁移或注册新设备，避免把旧任务交给不同实例。
- 成员依旧共享所有设备的控制权限，没有公开注册。设备管理仅通过云端 CLI。
- 云端只开放 HTTP 证书续期、HTTPS 和受限 SSH；直播电脑不开放入站端口，OBS WebSocket 仍是 `ws://127.0.0.1:端口`。
- Agent 与云端断线时已接收任务继续执行，但直播电脑断电、退出登录、OBS 退出或断开 YouTube 网络不在保证范围内。

## 可复用的部署入口

新维护者请先阅读[从零部署](从零部署.md)：包含 DNS 更新、Google 回调清单、Linux 安装器、Windows 初始化和诊断命令。以下说明协议及手动运维边界。

## 云端准备

1. 使用 Linux 构建产物：`npm ci && npm run verify`。不要复制 Windows 的 node_modules。将发行目录放到 `/opt/livepilot/releases/<commit>`，用 `/opt/livepilot/current` 指向已验证版本。
2. 参考 `config/cloud.env.example` 创建 `/etc/livepilot/cloud.env`，由 root:livepilot 持有，权限 640。生成独立 32 字节随机加密密钥，配置 `LIVEPILOT_MODE=cloud`、固定 origin 和持久数据根目录。密钥不得随发布替换。
3. 安装 `deploy/livepilot.service` 并启用，Next 只监听 127.0.0.1:3010。服务用户须能写入数据目录。`/api/health` 仅证明 HTTP 进程可用，不代表设备或直播健康。
4. 在相同配置环境执行 `npm run member -- create <用户名>`，交互输入密码；不创建通用默认密码。管理员命令使用 `LIVEPILOT_ENV_FILE=/etc/livepilot/cloud.env` 指定云端配置。
5. `npm run agent:admin -- pair studio_a 日本直播电脑` 生成十分钟一次性配对码；`list` 查看在线情况；`revoke studio_a` 撤销通信。撤销不会停止离线设备已执行的直播，也不会释放频道归属。

### 先用 IP 部署

没有域名时，网页可使用 `https://公网IP`。Certbot 5.4+ 支持 IP 证书，申请命令：

```sh
/opt/certbot/bin/certbot certonly --webroot -w /var/www/livepilot-acme --preferred-profile shortlived --ip-address <公网IP>
```

必须先让 80 端口的 `/.well-known/acme-challenge/` 指向该 webroot，签发成功后替换 `deploy/nginx-ip.conf.template` 的 `CONTROLLER_IP`，启用 443。IP 证书有效期短，必须安装仓库内续期 service/timer，并检查续期 dry-run。不得要求用户忽略证书错误。

Google 的网页 OAuth 回调不支持普通公网 IP。IP 网站上连接频道会给出明确提示，其他已授权功能正常使用。新频道先在目标直播电脑使用原 `local` 模式及已登记的 loopback 回调完成授权，然后停止本地服务、恢复 `.env.agent` 的云端 origin 并启动 Agent。已有频道令牌和原加密密钥不搬到云端。配置域名及 Google 回调后，云端网页授权事务会转交对应 Agent 完成。

公网 IP 变化会影响网址、证书和 Agent 配置；使用实例当前 IP 时避免停止后重新启动导致地址变化，重启操作与停止/启动不同。增加付费资源前先确认费用。

## Windows 直播电脑接入

1. 每台机器准备 Node 22.23+ 或 24+、独立 Portable OBS、LIVE / VIDEO / MUSIC 及本机 WebSocket 密码。使用 `npm ci && npm run agent:build` 构建 Agent。
2. 新电脑运行 `npm run setup:agent -- --domain <真实域名> --id <设备ID>`，生成 `.env.agent` 和独立随机密钥，再填入本机参数，详见[配置第 6 步](../配置.md#step-6)。已有机器从旧配置保留原 `LIVEPILOT_DATA_ROOT`、加密密钥、实例 ID、OBS 路径/端口、媒体目录和 Google 客户端配置；仅添加云端 origin 和设备 ID。不要生成新密钥覆盖原授权。
3. 在直播停止后备份配置和数据，停止旧 LivePilot 本地服务。Agent 和本地服务通过 `host.lock` 互斥；不能改成不同数据目录绕过该限制去控制相同 OBS。
4. `npm run agent:pair`，输入云端一次性配对码。设备私钥式随机凭据保存在本机 `.data/agent/identity.json`；不要分享或复制给其他电脑。相同数据目录不得重复配对到别的设备。
5. `npm run agent:start`，确认网页出现正确电脑及 OBS。首次接入会登记已有频道；频道属于其他设备时停止接收新任务，不能绕过冲突。
6. 验证后在 PowerShell 执行 `scripts/install-agent-task.ps1`，设置当前用户登录后启动。脚本不立即开播；Windows 用户需要保持登录，锁屏与注销不同。第一版不支持在 Session 0 服务中启动 OBS。

## 指令、掉线和恢复

- Agent 使用 20 秒 HTTPS 长轮询，独立 5 秒心跳，超过 20 秒未通信或状态过期则显示 Unknown。旧状态不是“OBS 已停止”。
- HTTP 202 表示云端落盘；Agent 的 accepted 表示本机执行日志已落盘。网页显示等待接收、执行中和真实结果；不把返回 202 当成功。
- 已知离线设备拒绝新任务。未送达命令 60 秒过期；已投递但回执丢失为待核对，继续占住该实例，重连查询本机日志，不能自动创建第二条命令。
- Agent 重启后将旧进程的未完成任务标为 interrupted；保留 OBS/YouTube 实际状态。用户核对后显式重试或结束，系统不会自动重放不确定任务。
- 控制任务和 OAuth 在同一实例互斥，不同实例并行。上传任务不占用控制队列。
- `npm run recover:lock -- main host` 和其他原恢复命令先验证旧 PID 已退出，只删除明确的锁。Agent 配置文件可通过 `LIVEPILOT_ENV_FILE` 指定；不要删除 control.json、youtube.enc 或 Agent 日志来“修复”。
- 云端文件锁异常退出后须按锁内 PID 核对，保留所有任务及频道归属。云端只能运行一个应用进程，不使用 PM2 cluster 或多个容器副本。
- 频道先在云端永久占用，再在本机加密保存、最后确认。网络中断可以恢复原归属；离线/撤销不会自动释放。第一版不提供网页跨设备转移频道，需停播并人工确认原设备不再使用后再迁移。

## 素材与容量

上传到用户选择的在线设备，保留原 8 MiB 分片、指纹和发布前校验。云端默认全局两个在途分片，上限 16 MiB 文件数据；Agent 落盘确认后才增加进度。网络响应丢失时，浏览器查询目标设备已确认偏移并重传，不拼接不同文件。

中转分片成功后清理；异常分片保留最多十分钟，在下次申请容量时回收。占满时请求等待最多 45 秒后提示稍后继续，不无限占用内存或磁盘。Agent 完成校验前素材不可用于直播；取消只清理该上传临时内容，不删除已发布素材。

账户会话、任务及审计元数据也会随使用增长，部署运维应监测数据目录磁盘。云端不保存整部媒体，但中转使用 Lightsail 流量额度。

## 发布与回退

先在隔离环境验证两台 Agent、同名实例、断线续传和重启恢复，再在停止直播的窗口切换 Agent。云端发行版本可切换 current 链接并重启服务；不还原旧任务/频道数据库覆盖较新状态。Agent 回退前必须停止新进程、核对实际直播、保留全部本机状态，再使用兼容的本地版本。

真实验收还需要两台 Windows、独立频道和可播放素材。模拟和空 OBS 配置证明协议及故障行为，不能代替真实频道授权、画面/音频、跨网络吞吐及长期直播验收。
