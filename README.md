# LivePilot v2

本机 OBS + YouTube 直播控制台 / Control Plane。

**全新独立仓库、独立 Git 历史。** 本机目录为 `D:\Repo\LivePilot-v2`。旧 `Doris619619/LivePilot` 只作为只读历史参考。

## 当前 MVP

- 1 台 Windows、1 个专用 Portable OBS、1 个 YouTube Channel。
- 从本机媒体目录选择一个视频和一段音乐，两者循环播放，可开关视频原声。
- 在网页查看状态、启动 OBS、一键开始真实直播、一键结束。
- 开播默认“不公开列出”，受众默认“非面向儿童”，可通过环境变量显式修改。
- 不实现上传、云存储、多账号、多实例、远程 Agent、FFmpeg Worker、批量任务或调度。

## 架构

```text
Browser (127.0.0.1:3010)
  └─ Next.js Node.js Server
      ├─ Control: 单个互斥控制操作 + control.json
      ├─ LocalObsRuntime
      │   ├─ ObsProcessManager → 指定 Windows Portable OBS
      │   └─ ObsController → OBS WebSocket v5
      ├─ Media Library → MEDIA_ROOT/videos、music
      └─ YouTubeAuth / YouTubeApi → Google / YouTube

媒体流：本机 OBS ── RTMPS ──→ YouTube
```

浏览器只收到文件名、公开频道信息和状态 DTO。绝对路径、OAuth Token、Client Secret、OBS 密码、Stream Key 始终留在服务端。OBS 自身会保存其推流设置，请保护 Portable OBS 目录。

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/app/console.tsx` | 单页控制台；实际状态轮询，无模拟进度 |
| `src/app/api/` | 本机 HTTP 边界、严格输入验证、OAuth 回调 |
| `src/server/control.ts` | Start / Stop 顺序、互斥、持久化与恢复 |
| `src/server/obs/` | ObsInstance、ObsController、ObsRuntime、本机进程 |
| `src/server/media.ts` | 类型白名单、路径/真实路径约束、目录扫描 |
| `src/server/youtube/` | OAuth PKCE、Token 加密/刷新、Live API |
| `src/server/storage.ts` | 原子状态替换、独占锁、AES-256-GCM |
| `src/shared/types.ts` | 不含 Secret 的浏览器数据类型 |
| `tests/` | 生命周期失败路径、媒体越界、请求边界、OBS 控制 |

## 环境和安装

Windows 10/11、Node.js 22+、npm、OBS Studio 28+（内置 WebSocket v5，建议使用当前稳定版本）。不需要 FFmpeg 或 VLC。

```powershell
cd D:\Repo\LivePilot-v2
npm ci
npm run setup:local
```

此命令创建空的本机配置并自动生成 `LIVEPILOT_ENCRYPTION_KEY`，已有 `.env.local` 完整保留。不要将 Secret 发到聊天、截图或提交到 Git。不要从旧仓库直接拷贝 `.env` / `.data`。

编辑 `.env.local`：

| 配置 | 说明 |
| --- | --- |
| `LIVEPILOT_ORIGIN` | 默认 `http://127.0.0.1:3010`，必须使用这个地址访问 |
| `LIVEPILOT_OBS_EXE` | 专用 Portable OBS 的完整 obs64.exe 路径 |
| `LIVEPILOT_OBS_WS_URL` | `ws://127.0.0.1:端口`，端口必须属于指定 exe 进程 |
| `LIVEPILOT_OBS_WS_PASSWORD` | OBS WebSocket 密码，必须启用认证 |
| `LIVEPILOT_MEDIA_ROOT` | 绝对媒体根目录，例 `D:\LiveMedia` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth Web application 客户端 |
| `LIVEPILOT_ENCRYPTION_KEY` | 32 字节密钥的 64 位十六进制表示；稳定保存 |
| `LIVEPILOT_PRIVACY` | `unlisted`（默认）/ `private` / `public` |
| `LIVEPILOT_MADE_FOR_KIDS` | `false`（默认）或 `true`，按实际内容设置 |

路径只在环境配置和服务端使用，不硬编码在应用里。环境变更后重启服务。加密密钥丢失将无法解密既有 OAuth Token；不要在尚有直播时更换。

## 一次性准备 OBS

使用专门供 LivePilot 管理的 Portable OBS。不要使用正在承担其他直播的实例。

1. 首次手动打开此 OBS，完成可能出现的初始化、许可或编码器设置窗口。
2. 在“工具 → WebSocket 服务器设置”启用 WebSocket v5 和认证，设置独立端口与密码，填入 `.env.local`。不要启用敏感协议调试日志。
3. 创建场景 `LIVE`，只添加两个直接的“媒体源”：`VIDEO`、`MUSIC`。名称区分大小写，不使用 VLC 源、组或嵌套场景。
4. 将 VIDEO 在画布上“变换 → 适配屏幕”；保证 MUSIC 不包含视频画面。首次可选择本地测试文件确认布局。以后媒体和循环由 LivePilot 设置。
5. 在“设置 → 音频”禁用所有全局桌面音频和麦克风；应用会检查这一项，避免混入未选声音。
6. 在“设置 → 视频/输出”一次性配置合适的分辨率、帧率、编码器和码率，例如 1080p30 / H.264 / AAC；确保本机与上行带宽支持。当前 MVP 不自动调优编码器。
7. 不要在 OBS 中启用其他自动开播机制，也不要在 LivePilot 操作期间手动切场景、更换 Profile 或推流设置。

LivePilot 使用 `--portable --multi` 启动配置的 exe，工作目录为 exe 所在目录。启动前按完整路径识别进程，并核对 WebSocket 端口所属 PID。发现同一路径多进程或端口冲突会报错，不猜测实例。等待就绪最长约 60 秒；首次 OBS 窗口或密码错误需要人工处理。

当前采用**校验并明确报错**，不自动创建或重构已有场景。每次开始设置循环、原声、音乐取消静音、音量为 100%、关闭音频监听、开启六个输出音轨、启用两个场景项并切至 LIVE。结束直播保留 OBS 进程运行。

## 本地媒体

```text
D:\LiveMedia\
  videos\
    girl-study.mp4
  music\
    lofi-01.mp3
```

只扫描这两个文件夹的直接文件。视频支持 mp4 / mkv / mov / webm / avi / m4v；音乐支持 mp3 / wav / flac / aac / m4a / ogg。实际解码能力取决于 OBS，请首次在 OBS 验证音画。

服务端拒绝绝对路径、斜杠、反斜杠、编码路径、NTFS ADS 和非法扩展名，并用 realpath 核对目录与文件，阻止 junction/symlink 越界。客户端不提供任意文件读取或上传接口。不要在推流期间移动、替换或删除文件；本机文件系统视为受信任。

## Google / YouTube 配置

1. 在 Google Cloud 项目启用 **YouTube Data API v3**。
2. 配置 OAuth consent screen；测试阶段将你自己的 Google 账号加入 Test users。
3. 创建类型为 **Web application** 的 OAuth client。
4. 添加精确 Authorized redirect URI：
   `http://127.0.0.1:3010/api/youtube/callback`
5. 将 Client ID / Client Secret 填入 `.env.local`。
6. 在 YouTube Studio 先启用直播，等待 YouTube 完成频道开通。首次开通可能需要等待；以 YouTube 当前提示为准。
7. 启动 LivePilot，点击“连接 YouTube”，由本人完成 Google 登录和频道授权。
8. 确认 Connected 和频道名称正确。

OAuth 使用一次性浏览器绑定事务、state、S256 PKCE、离线授权，Token 在 `.data/youtube.enc` AES-GCM 加密保存。刷新请求去重。未完成的直播会固定原 Channel，重新授权也只能连接原频道。此 MVP 没有账号列表；正常结束后再授权才可替换单个频道。

不需要你手工提供 Stream Key。服务端创建/复用本项目拥有的 YouTube Stream、读取 ingest Secret 并配置 OBS。不会选取或改写账号中无关的 Stream。新场次使用唯一标题；本项目的 Stream 在后续场次复用。

Google OAuth 处于 Testing 状态时，离线授权可能按 Google 的当前规则过期；界面显示失效后重新授权。退出授权也可在 Google 账号的第三方连接页面撤销。

## 运行

开发：

```powershell
npm run dev
```

日常本机使用建议先构建：

```powershell
npm run build
npm start
```

打开 **http://127.0.0.1:3010**。只运行一个 LivePilot 服务，不同时运行 dev/start。必须在项目根目录启动，以使用同一份 `.data`。这是常驻 Node 服务，不支持 serverless、Vercel 或多副本部署。

缺少配置也可打开页面查看缺项；应用不会自动读取旧项目配置或触发开播。

## Start / Stop

开始直播：

1. 读取确认 YouTube 授权与 Channel，解析合法媒体。
2. 检查/启动指定 OBS，等待 WebSocket ready。
3. 校验 LIVE / VIDEO / MUSIC，配置媒体、循环、原声，并确认两个媒体源已开始播放。
4. 创建或恢复本场 Broadcast，准备/复用 Stream，bind 并读回确认。
5. 仅服务端配置 OBS RTMPS 地址与 Stream Key。
6. OBS StartStream → 等待 YouTube ingest active。
7. YouTube transition live → 再读回 live，并确认 OBS 仍推流。
8. UI 基于实际 OBS / YouTube 状态显示 LIVE。

关闭 monitor stream，直接从 ready 进入 live，不要求用户操作 testing。依据 [YouTube 生命周期文档](https://developers.google.com/youtube/v3/live/life-of-a-broadcast) 和 [transition API](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition)。

结束直播：

1. YouTube transition complete → 读回 complete。
2. OBS StopStream → 读回 stream inactive。
3. 标记 Stopped，OBS 进程保持运行。

YouTube complete 失败时**不会继续停止 OBS 并报告成功**。请在 YouTube Studio 手动结束（尚未开播的待播场次请删除），再点结束直播让 LivePilot 读回核对并收尾。OBS 断线则恢复 WebSocket 后重试；必要时可在 OBS 人工停止推流，但仍需回到控制台确认状态。

状态页每 5 秒读取 OBS；YouTube 查询最多每 30 秒一次并显示最近确认时间，降低配额消耗。Start/Stop 自身直接读取，不用状态页缓存。时长来自 OBS 实际 outputDuration，不是模拟计时进度。页面断连会标记状态可能过期。

## 失败与恢复

单个 `.data/control.json` 保存当前场次和已执行阶段；没有 Job / Run 表、队列或后台重试器。每个外部创建请求之前先落盘创建意图，拿到 ID 立即保存。互斥锁阻止重复点击以及两个本机服务同时操作。

- **可重试的准备失败**：修复配置或网络，保留原媒体选择，点击“重试开始直播”。
- **请求超时但上游可能成功**：先按唯一标题查询原对象，不盲目再次创建；查不到时停住并要求核对。
- **创建结果始终无法确认**：到 Debug 查场次标题，在 Studio 核实没有该场次后，使用 Debug 的明确确认操作清理；服务端再次确认 OBS inactive 与原频道没有该场次。不得用它清理已有 ID 的场次。
- **StartStream 之后失败**：OBS 可能继续推流；不会擅自终止已经可能开播的 YouTube 场次。优先重试读取恢复，或点击结束按顺序收尾。
- **服务器重启**：读取持久状态；不会后台自动重新开播。点击开始恢复或结束收尾。
- **异常退出留下 control.lock**：锁文件含旧进程 PID。先确认旧 LivePilot 服务已经退出，再运行 `npm run recover:lock`。该命令只在 PID 不存在时删除锁；若 PID 已复用，请人工核对进程后处理，不强行解除。
- **状态损坏**：保留 `.data`，先到 Studio / OBS 核对当前直播并结束，再恢复备份。不要直接删除整个目录，否则会丢失归属与恢复依据。
- **外部改动**：不要在直播时并行操作 OBS/Studio；如已改动，用结束流程核对恢复，不猜测归属。

## 安全与边界

- 服务仅绑定 127.0.0.1，不公开到 LAN 或公网。不提供多用户认证；这是本人本机控制台。
- API 检查 Host；写请求检查 Origin 和专用头，拒绝跨站控制与 DNS rebinding Host。
- 服务模块使用 `server-only`，浏览器只 import shared types。
- 不记录 Stream Key、OBS 密码、OAuth Token、Client Secret；原始上游错误被替换为可操作的安全提示。
- 开发请求日志关闭，避免 OAuth callback 查询串被写入终端。
- `.env.local`、`.data`、依赖、日志、构建产物均被 Git 忽略。Windows 请确保项目和 OBS 目录仅本人可信账号可读；POSIX mode 不是 Windows ACL 的替代品。
- 本机管理员或同一用户进程属于信任边界之内，不承诺防止本机恶意进程。

## 验证

```powershell
npm run typecheck
npm run lint
npm test
npm run build
# 或
npm run verify
```

单元测试使用注入的 OBS / YouTube 适配器，验证严格顺序、live/complete 读回、各阶段失败停止、超时恢复、重启恢复、互斥、路径越界、加密和 Origin/Host 保护。**通过这些测试不代表真实开播已验收。**

真实验收必须由本人完成：

- [ ] 填好本机配置，启动/检查专用 OBS，LIVE / VIDEO / MUSIC 校验通过。
- [ ] Google OAuth 授权正确频道，显示 Connected。
- [ ] 选择真实视频和音乐，确认原声 OFF 时只有音乐；另场 ON 时听到视频原声。
- [ ] 从网页启动原本关闭的 OBS，显示 Ready。
- [ ] 从网页开始直播，OBS 自动推流，YouTube Studio 和观看页真实有音画。
- [ ] LIVE、ingest active、lifecycle live 一致；检查循环衔接。
- [ ] 从网页结束，YouTube complete、OBS inactive、OBS 程序仍运行。
- [ ] 再开一场；验证刷新/服务重启后的恢复操作。

## 历史参考与复用说明

只读查看旧仓库 commit `9231296f1a0e2405862f7fd6703bc9e2d3dfa710` 下的 `src/server/youtubeAuth.ts` 与 `src/server/youtubeApi.ts`。

**没有复制或迁移旧文件。** 新代码独立编写，仅参考值得保留的设计：OAuth 服务端边界、PKCE/一次性事务、Token 加密与刷新去重、YouTube bind / ingest / transition 后读回。旧代码的 FFmpeg Worker、Job/Run 模型、历史 UI、数据库与配置均未迁移。旧仓库不作为新项目的 Git remote。

协议依据：[OBS WebSocket v5](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)、[obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js)、[YouTube Live API](https://developers.google.com/youtube/v3/live/docs)。

## 未来路线（当前不实现）

**Phase 2**：一机多个 Portable OBS；每个对应一个 Channel；独立控制、Start All / Stop All、Media Preset 批量分发。

**长期**：中央 LivePilot → 多台电脑的 Local Agent → 各自多个 OBS。中央只发控制命令，不接收或转发媒体流；视频/音频永远由直播电脑的 OBS 直接发送 YouTube。

当前只有一个 `ObsInstance` 和 `LocalObsRuntime`。`ObsRuntime` 定义状态、就绪、媒体配置、推流配置及开始/停止控制接口；未来 `RemoteObsRuntime` 可以实现同一控制边界。当前没有 Remote Agent 的实现、路由、进程、数据库或占位 UI。
