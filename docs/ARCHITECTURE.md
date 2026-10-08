<!-- 文件用途：记录本机多实例的边界、配置契约、存储隔离与未来控制接口。 -->
# 本地核心与多电脑控制架构

当前多电脑实现见 [多电脑云端与 Agent](多电脑云端与Agent.md)：完整 `Control`、OBS/YouTube、媒体及持久日志已提取到 `src/core`；独立 `src/agent` 在 Windows 执行；云端只维护设备身份、任务派发与快照。下面的本机数据契约继续适用于 local 模式及每个 Agent。

LivePilot 是控制平面。当前支持一台 Windows 上配置任意数量的 Portable OBS，每个实例连接不同的 YouTube Channel。实际并发能力取决于编码器、显存、CPU、内存及上行带宽；代码不写死为两个实例。

```text
Browser
  ├─ instance main 面板 ──┐
  ├─ instance obs_a 面板 ─┼─ Next.js Node Server
  └─ instance ... 面板 ──┘    └─ Map<instanceId, Service>
                                 ├─ Control + 独立 control.json / control.lock
                                 ├─ LocalObsRuntime
                                 │   ├─ ObsProcessManager → 指定 exe / PID / 端口
                                 │   └─ ObsController → 该实例 WebSocket v5
                                 ├─ Media Library → 本机媒体根目录
                                 ├─ LiveChatRunner → 本实例 YouTube 聊天 / DeepSeek 环境配置
                                 └─ YouTubeAuth / YouTubeApi → 所属频道

媒体：每个 OBS ── RTMPS ──→ YouTube
```

AI 观众互动由每个 Agent 或 local 服务的进程启动，配置写入使用独立短事务，不占开停播锁；浏览器关闭后仍运行。Cloud 只向有效 Agent 会话交付部署环境 Key，模型和 YouTube 聊天调用均在 Agent，公开快照只含配置就绪标记和受限聊天状态。协议、恢复及升级边界见 [直播 AI 观众互动](直播AI观众互动.md)。

## 配置与身份

- `LIVEPILOT_INSTANCES` 是稳定 ID 清单，必须包含 `main`。只允许小写字母开头、其后字母数字下划线，最长 32 位；禁止 Windows 保留名、重复和路径字符。
- 每个新增实例的配置前缀为 `LIVEPILOT_INSTANCE_<大写ID>_`，支持 NAME、OBS_EXE、OBS_WS_URL、OBS_WS_PASSWORD、可选 MEDIA_ROOT。
- main 兼容旧 `LIVEPILOT_OBS_*`。新增实例绝不继承主实例 OBS 路径、密码、端口；媒体根目录可共享。
- 禁止相同 Windows 规范化 exe 路径或相同 WebSocket 端口。进程控制进一步用 Win32_Process 读取 exe 真实路径对应进程，并解析原生 netstat -ano -p tcp 的监听 PID，防止连接到其他 OBS。端口解析忽略远端端口及非监听连接，遇到多个归属则拒绝操作；避免用 Get-NetTCPConnection 的网络 CIM 查询阻塞启动。
- 原 `.data/control.json` 和 `.data/youtube.enc` 原地属于 main。其他实例位于 `.data/instances/<id>/`。不可随意更名、删除 ID 或拷贝一个实例的授权目录给另一个实例。
- 变更实例列表、目录或端口前，先结束受影响实例的直播并停止 LivePilot。编辑文件不会自动重新配置正在运行的进程。

## HTTP 与浏览器边界

| 入口 | 契约 |
| --- | --- |
| GET /api/instances | 登录后返回实例 ID / 名称清单，无凭据 |
| GET /api/status?instanceId=obs_a | 单实例状态；省略 ID 时兼容 main |
| POST /api/control | 严格 JSON，显式 instanceId 和 requestId；action 为 start、stop、launch、clear-uncertain；202 仅表示持久化受理 |
| POST /api/youtube/connect | JSON instanceId，返回 Google 授权地址 |
| GET /api/youtube/callback | 共用回调地址，state 与独立 Cookie 定位发起实例 |

local 模式允许异地浏览器访问同一台 Windows；cloud 模式通过出站 HTTPS Agent 控制多台 Windows。成员权限共享，上传落在该 Windows 的媒体库，命令完成与否以 operation 和实际 OBS/YouTube 状态为准。

状态接口独立轮询，服务端每实例去重同时读取，YouTube 状态缓存最多 30 秒。浏览器草稿仅保存文件名和原声选择，按 ID 分开；未结束场次优先使用服务端已有选择。状态过期或媒体不在列表时禁用 Start 并显示原因。观看链接由面板自己的 state.broadcastId 生成固定 YouTube watch URL，ID 经过 URL 编码；新标签页使用 noopener/noreferrer，不额外请求 API，也不触发直播控制。没有场次 ID 时不显示入口，结束后保留最近场次链接。没有模拟进度、模拟 LIVE 或模拟时长。

所有业务接口要求成员登录。控制请求要求配置的固定 Host、同源 Origin 和 `X-LivePilot: 1`；公网入口必须使用 HTTPS，只有本机 127.0.0.1 可以使用 HTTP。浏览器不接触绝对媒体路径、OBS 密码、Client Secret、Token 或 Stream Key。原始上游错误与 OAuth 请求 URL 不进入应用日志。应用安全错误由跨模块共享的 WeakSet 登记，开发热更新或路由模块重新加载后仍保留安全说明及 HTTP 状态码；不能仅凭 code/message 字段信任上游异常。

## 并发、授权与恢复

每个 Service 各自拥有 OBS Socket、进程管理器、YouTubeAuth、缓存和 Control。一个实例在等待 ingest 时，其他实例仍可开始或结束。control.lock 防止同一实例跨进程重入。

OAuth 使用 PKCE S256、随机 state、一次性加密磁盘事务与 `livepilot_oauth_<id>` Cookie。回调先校验注册 ID，再校验所属实例事务；只有该实例的控制锁参与授权流程。有未结束场次时必须重新授权原频道。

保存授权时短暂取得全局 `oauth-bindings.lock`，检查频道没有属于其他已配置实例，并原子保存密文。该锁不用于直播操作；竞争失败会明确报错供重试。令牌写入使用每实例 `tokens.lock`；慢刷新返回时检查当前令牌，避免覆盖较新的授权。授权使用同一个本机 AES-256-GCM 密钥加密。

Start 延续既有顺序：频道 → 媒体 → OBS 就绪 → LIVE/VIDEO/MUSIC 校验 → 循环与原声 → 创建/恢复 Broadcast → Stream → bind 并确认 → RTMPS 设置 → StartStream → ingest active → transition live → 再读确认。

Stop：确认频道 → complete 并确认 → StopStream 并确认 inactive。complete 失败时保留推流并提示人工核对 Studio，不假装停止成功。结束直播不关闭 OBS。

创建请求不确定时保存唯一意图标题，重试先检索而非重复创建。错误保存最后真实步骤，没有 Job/Run 系统。锁文件恢复须检查 PID；状态与授权不能随意删除。

## 未来接口与范围

Windows 安装版由 `electron/` 主进程、`desktop/app` 静态页面和内置 Node Agent 组成。Renderer 登录之后仍只可调用白名单 IPC，远程网页从系统浏览器打开；设备配置使用 Windows 用户加密保存。桌面和网页共享 CSS、字体和基础图标。

桌面通过现有 Agent 认证协议连接云端，新增加邀请创建/续期、严格会话认证的 Google 应用配置 bootstrap、维护锁与实例追加。维护与任务入队共用事务锁，直播、未知状态及未完成活动阻止重启；桌面只追加实例与修改显示名，保留旧 ID/频道映射。旧 CLI Agent 协议继续兼容。安装及发布细节见[桌面安装与发布](桌面安装与发布.md)。

`ObsRuntime` 保留 status、ensureReady、validate、setMedia、setStream、startStream、stopStream 控制契约；OBS 仍由 Agent 内的 `LocalObsRuntime` 控制；远程边界是完整直播任务，不把每个 OBS 方法变成远程 RPC。

当前支持多电脑 Agent；云端只中转有界素材上传分片，不转发直播音视频流。尚未实现 Start All / Stop All、批量媒体分发、调度或 FFmpeg Worker。

## 历史来源

本次只从旧仓库复制两份协作 Markdown，替换文档中的项目称谓为 LivePilot v2；没有复制业务代码或修改旧仓库。多实例实现基于新仓库已测试的单实例控制流程，保留其状态恢复与安全边界。

## 部署配置与入口

`scripts/setup-deployment.mjs` 仅初始化私有环境并输出 OAuth 清单；DNS 更新单独使用明确的 --apply。`deploy/install-cloud.sh` 在 Linux 构建、保留密钥、备份配置/数据，安装域名 HTTPS 与 systemd；失败回退程序而不覆盖任务数据。`scripts/agent-launch.mjs` 统一交互与登录任务的环境/代理加载顺序。外部账号审批和 Google 本人同意仍在平台完成，详见[从零部署](从零部署.md)。
