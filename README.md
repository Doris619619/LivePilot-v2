<!-- 文件用途：指导新 Windows 电脑从克隆仓库到配置多个 OBS / YouTube 频道并进行真实开停播验收。 -->
# LivePilot v2

支持成员登录、异地网页操作的 OBS + YouTube 直播控制台。选择一个视频、一段音乐、设置视频原声 ON/OFF，在网页启动 OBS、开始直播、结束直播。

支持 **一台 Windows、多个独立 Portable OBS、每个 OBS 一个不同的 YouTube Channel**。实例数量通过配置扩展，不写死为两个。视频与音乐均循环播放；媒体由 OBS 直接发到 YouTube，LivePilot 只发控制命令。

全新独立仓库：[Doris619619/LivePilot-v2](https://github.com/Doris619619/LivePilot-v2)。旧 LivePilot 仅作只读历史参考。支持从操作电脑上传素材到直播电脑；不实现云存储、远程 Agent、FFmpeg Worker 或复杂 Job/Run。


## 异地操作：A 打开网页，B 负责直播

B 运行 LivePilot-v2、OBS 并保存媒体；A 只需要浏览器。素材在 B 时直接选择，在 A 时通过“上传这台电脑的素材”先传到 B。传输及校验完成后再开播；A 关闭网页不会停止 B 的直播。

每位成员独立登录，共同管理全部实例。开停播先返回受理结果，再显示 B 的实际执行状态；上传支持 8 MiB 分片、断点续传，默认单文件上限 20 GiB。成员账号与 YouTube 账号是两套不同身份。

本次代码可在本机先使用；**尚未部署公网网址、域名或 AWS**。公网入口接入、成员管理及异常恢复详见[远程控制与素材上传](docs/远程控制与素材上传.md)。

## 新电脑快速开始

需要 Windows 10/11、Node.js 22 或更新的受支持版本（本项目验证使用 Node 22）、Git、OBS Studio 28+（内置 WebSocket v5）。下载入口：[Node.js](https://nodejs.org/en/download)、[Git for Windows](https://git-scm.com/downloads/win)、[OBS 官方下载](https://obsproject.com/download)。

如果正在测试尚未合并的 PR，克隆后先切换到该 PR 的源分支，再安装启动；合并后使用 main 即可。

仓库是私有时，先用有权限的 GitHub 账号登录 Git Credential Manager，或安装 [GitHub CLI](https://cli.github.com/) 后执行 `gh auth login`。不要把 Token 写进 clone URL。

在 PowerShell 执行：

```powershell
New-Item -ItemType Directory -Force D:\Repo | Out-Null
cd D:\Repo
git clone https://github.com/Doris619619/LivePilot-v2.git
cd LivePilot-v2
npm ci
npm run setup:local
notepad .env.local
```

`setup:local` 创建本机 `.env.local` 并生成随机加密密钥；已有文件不会覆盖。下面三部分都完成后，再运行服务：

1. 准备每个 Portable OBS，记录 exe 路径、WebSocket 端口和密码。
2. 准备本机媒体目录。
3. 在 Google Cloud 配置 OAuth，把 Client ID / Secret 填入环境文件。

**克隆新电脑时不要复制另一台电脑的 .env.local、.data 或带推流密钥的 OBS 配置。** 在新电脑生成密钥、按实际路径配置，并分别重新授权。现有电脑升级本分支时则保留原来的 .env.local、加密密钥与 .data，main 会继续使用原账号。

## 1. 配置每个 Portable OBS

从 [OBS 官方发布页](https://github.com/obsproject/obs-studio/releases) 下载 Windows ZIP，分别解压到不同文件夹。例如：

```text
D:\app\obs-portable-b\bin\64bit\obs64.exe
D:\app\obs-portable-a\bin\64bit\obs64.exe
D:\app\obs-studio-c\bin\64bit\obs64.exe
```

在每份 OBS 的根目录（与 bin、data 同级）创建空的 `portable_mode.txt`，保证双击 exe 也使用独立配置。LivePilot 启动时另外传入 `--portable --multi`。[Portable mode 官方说明](https://obsproject.com/kb/portable-mode)、[启动参数说明](https://obsproject.com/kb/launch-parameters)。

第一次需要手动打开每份 OBS，完成以下初始化；以后可以直接从网页启动：

```powershell
Start-Process -FilePath "D:\app\obs-portable-a\bin\64bit\obs64.exe" -WorkingDirectory "D:\app\obs-portable-a\bin\64bit" -ArgumentList "--portable","--multi"
```

### WebSocket：每份设置不同端口

OBS 菜单 **工具 → WebSocket 服务器设置**：

- 勾选启用 WebSocket 服务器、启用身份验证。
- B 使用 4456、A 使用 4455、第三份可使用 4457；这只是示例，必须与 OBS 中实际值一致。
- 显示/生成服务器密码，把它填入对应实例的环境变量。
- 使用 `ws://127.0.0.1:端口`，浏览器只连接 LivePilot。
- 保存设置。每个 OBS 的完整 exe 路径及端口必须不同。不要让两份 OBS 共用同一个 Portable 配置目录。

入口说明：[OBS Remote Control Guide](https://obsproject.com/kb/remote-control-guide)。密码来自 **对应 OBS 的 WebSocket 设置**，不是 Google 密码或 YouTube Stream Key。

### 标准场景：每份 OBS 都要建一次

1. 创建场景 **LIVE**。
2. 在 LIVE 中添加两个 **媒体源**，严格命名 **VIDEO** 和 **MUSIC**。不是 VLC 源，注意不是 VEDIO。
3. 各选一个真实文件，勾选本地文件、循环。程序开播时会换成网页选择的文件并设置循环。
4. LIVE 只保留这两个直接媒体源；不要加入其他场景、采集源或组。
5. 设置 → 音频：禁用所有全局桌面音频、麦克风/辅助音频，防止额外声音混入。
6. 设置 → 视频 / 输出：按媒体比例设置画布和输出分辨率，配置可用编码器、码率、音频。右击 VIDEO → 变换 → 适配屏幕，检查预览不是黑屏。
7. 确认 VIDEO 和 MUSIC 可播放、有音频电平，保存配置。

LivePilot 校验场景，缺少结构时明确报错。程序不自动配置画布、编码器或改变视频缩放。多 OBS 同时编码会增加硬件和网络负荷；先用两个实例实测，再按机器容量增加。

无需手动填写 YouTube Stream Key，也无需去 OBS 点击“开始推流”。LivePilot 从 YouTube API 获取 RTMPS 参数并设置到所属 OBS。OBS 自身可能保存推流设置，请保护其本机目录。

## 2. 准备本机媒体

```powershell
New-Item -ItemType Directory -Force D:\LiveMedia\videos, D:\LiveMedia\music | Out-Null
```

自己放入至少一个真实视频和音频文件：

```text
D:\LiveMedia
├── videos
│   └── test.mp4
└── music
    └── test.mp3
```

`LIVEPILOT_MEDIA_ROOT=D:\LiveMedia`。默认所有实例共用这个媒体库，也可为某个实例单独指定 MEDIA_ROOT。文件保存在直播电脑；除了手工放入素材，也可登录网页后上传，支持分片续传。上传目录需要写权限和硬链接支持，建议使用本地 NTFS。

支持视频 mp4/mkv/mov/webm/avi/m4v，音乐 mp3/wav/flac/aac/m4a/ogg；能否解码由 OBS 实际验证。扫描直接子文件，不递归子目录。文件名可用中文；网页传文件名，服务端解析绝对路径并校验真实路径，拒绝 ../、绝对路径及越界链接。

## 3. Google / YouTube 配置：值从哪里来

每个频道先在 [YouTube Studio](https://studio.youtube.com/) 的“创建 → 开始直播”确认具备直播资格；首次启用可能需要平台审核或等待。授权成功只代表 API 可访问频道，仍需频道本身允许直播。

### 3.1 选择项目并启用 API

打开 [Google Cloud Console](https://console.cloud.google.com/)，选择或创建用于 LivePilot 的项目。后续设置全部在 **同一个项目** 中完成。

打开 [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)，点击启用。官方步骤见 [YouTube API 授权注册](https://developers.google.com/youtube/registering_an_application)。

### 3.2 配置应用与测试人员

打开 [Google Auth Platform](https://console.cloud.google.com/auth/overview)：

1. **Branding / 品牌信息**：设置应用名 LivePilot、支持邮箱、开发者邮箱。
2. **Audience / 受众**：个人 Gmail 通常选择 External；测试阶段保持 Testing。
3. **Test users / 测试用户**：添加每个准备授权的 Google 登录邮箱。两个账号都要加入；这里填登录邮箱，不是 YouTube 频道名称。
4. **Data Access / 数据访问**：配置本应用使用的 scope：`https://www.googleapis.com/auth/youtube`。

出现 **403 access_denied / 应用尚未完成验证、仅供测试人员使用**，先确认当前登录邮箱在这个项目的测试用户列表中。复制 Client ID / Secret 不会自动加入测试人员。

Google 测试状态下，此类授权及离线 refresh token 通常在授权后 7 天到期，届时需重新连接。不要将 Testing 当成长时间无人值守授权。[Google Audience 官方说明](https://support.google.com/cloud/answer/15549945?hl=en)。

### 3.3 创建 Web application OAuth 客户端

打开 [Clients / 客户端](https://console.cloud.google.com/auth/clients)，创建 OAuth 客户端：

- 类型：**Web application / Web 应用**。
- 名称：例如 LivePilot Local。
- **Authorized redirect URIs / 已获授权的重定向 URI**，精确添加：

```text
http://127.0.0.1:3010/api/youtube/callback
```

这是服务端 OAuth code 回调；不要只填首页，不要写 localhost，不要沿用旧仓库的 3000 端口或旧回调路径。

创建后将 **Client ID** 填入 `GOOGLE_CLIENT_ID`，**Client secret** 填入 `GOOGLE_CLIENT_SECRET`。妥善保存创建时的 Secret；控制台可能不再提供完整值。不要填 API Key，也不要把 OAuth Secret 当作 OBS 密码。[客户端管理说明](https://support.google.com/cloud/answer/15549257?hl=en)、[服务端 OAuth 流程](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps)。

同一 LivePilot 的多个实例可以共用这个 OAuth 客户端和回调地址。每个实例仍需在网页 **各自连接不同频道**。不要为省略授权而拷贝 .data 中的 Token。

## 4. 填写 .env.local

### 两个实例的完整配置示例

以下路径和端口是示例，密码和 Google 值由你填写。本机加密密钥保留 setup:local 自动生成的值。

```dotenv
LIVEPILOT_ORIGIN=http://127.0.0.1:3010
LIVEPILOT_INSTANCES=main,obs_a

LIVEPILOT_INSTANCE_MAIN_NAME=OBS B
LIVEPILOT_OBS_EXE=D:\app\obs-portable-b\bin\64bit\obs64.exe
LIVEPILOT_OBS_WS_URL=ws://127.0.0.1:4456
LIVEPILOT_OBS_WS_PASSWORD=填写B的WebSocket密码

LIVEPILOT_INSTANCE_OBS_A_NAME=OBS A
LIVEPILOT_INSTANCE_OBS_A_OBS_EXE=D:\app\obs-portable-a\bin\64bit\obs64.exe
LIVEPILOT_INSTANCE_OBS_A_OBS_WS_URL=ws://127.0.0.1:4455
LIVEPILOT_INSTANCE_OBS_A_OBS_WS_PASSWORD=填写A的WebSocket密码

LIVEPILOT_MEDIA_ROOT=D:\LiveMedia
GOOGLE_CLIENT_ID=填写Google的ClientID
GOOGLE_CLIENT_SECRET=填写Google的ClientSecret
LIVEPILOT_ENCRYPTION_KEY=保留本机生成的64位十六进制密钥
LIVEPILOT_PRIVACY=unlisted
LIVEPILOT_MADE_FOR_KIDS=false
```

不要把“填写…”这些提示文字作为实际值。密码若含 `#` 用引号包住；若含 `$`，按 Next.js 环境文件规则转义为 `\$`，避免被变量展开。

| 环境变量 | 填什么 / 从哪里来 |
| --- | --- |
| LIVEPILOT_ORIGIN | 默认 http://127.0.0.1:3010；公网时设为固定 HTTPS origin 并同步 Google 回调，B 内部服务仍监听 3010 |
| LIVEPILOT_INSTANCES | 自己定义的稳定 ID 列表；至少 main；不是 OBS 名称或频道 ID |
| LIVEPILOT_INSTANCE_MAIN_NAME | 网页显示名，可改；主实例 ID main 不改 |
| LIVEPILOT_OBS_EXE | 主 OBS 的真实 obs64.exe 完整路径，在资源管理器找到 |
| LIVEPILOT_OBS_WS_URL | 主 OBS 工具 → WebSocket 设置中的端口，拼成 ws://127.0.0.1:端口 |
| LIVEPILOT_OBS_WS_PASSWORD | 主 OBS 同一设置窗口的服务器密码 |
| LIVEPILOT_INSTANCE_<ID>_NAME | 新增实例显示名称 |
| LIVEPILOT_INSTANCE_<ID>_OBS_EXE | 新增实例独立 Portable 文件夹中的 obs64.exe |
| LIVEPILOT_INSTANCE_<ID>_OBS_WS_URL | 新增实例独立 WebSocket 端口 |
| LIVEPILOT_INSTANCE_<ID>_OBS_WS_PASSWORD | 新增实例自己的 WebSocket 密码，不能留空 |
| LIVEPILOT_MEDIA_ROOT | 自己创建的媒体根目录，包含 videos 和 music |
| LIVEPILOT_INSTANCE_<ID>_MEDIA_ROOT | 可选；该实例独立媒体根目录，不填则共用上面的根目录 |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | Google Auth Platform → Clients → Web application，所有实例共用 |
| LIVEPILOT_ENCRYPTION_KEY | setup:local 本机随机生成；不用去任何网站申请，已有授权时不能换 |
| LIVEPILOT_PRIVACY | unlisted 不公开列出 / private 私密 / public 公开；默认 unlisted，所有新场次共用 |
| LIVEPILOT_MADE_FOR_KIDS | true 或 false，按内容实际受众设置，默认 false |

`<ID>` 要换成清单中 ID 的大写。例如 obs_a 对应 OBS_A；main 兼容旧的无前缀 OBS 变量。配置绝不能使用 NEXT_PUBLIC_ 前缀。

### 添加第三个及更多实例

```dotenv
LIVEPILOT_INSTANCES=main,obs_a,studio_c
LIVEPILOT_INSTANCE_STUDIO_C_NAME=学习频道
LIVEPILOT_INSTANCE_STUDIO_C_OBS_EXE=D:\app\obs-studio-c\bin\64bit\obs64.exe
LIVEPILOT_INSTANCE_STUDIO_C_OBS_WS_URL=ws://127.0.0.1:4457
LIVEPILOT_INSTANCE_STUDIO_C_OBS_WS_PASSWORD=填写第三个OBS密码
```

重复配置即可增加任意数量，每个实例独立授权不同频道。ID 与状态目录绑定，改显示名只改 NAME。增删实例或改变连接配置前先结束相关直播、停止服务；不要把旧 ID 改名当作增加实例。

## 5. 启动并分别授权

保存 .env.local，关闭编辑器，然后：

```powershell
cd D:\Repo\LivePilot-v2
npm run dev
```

先在 B 的另一个终端执行 `npm run member -- create alice` 创建自己的成员账号，再打开[本机控制台](http://127.0.0.1:3010)登录。没有默认账号或密码。环境文件改动后，先在原 PowerShell 按 Ctrl+C，再重新执行 npm run dev。

每个实例有独立面板：

1. 检查显示名称、配置缺项；点击“启动 OBS”，等待 Ready。
2. 点击这个面板的“连接频道”，在 Google 页面选择对应账号及 YouTube Channel。
3. 返回后检查 **面板标题下的频道名称**。第二面板再授权第二个频道，不能把同一个频道绑定两个 OBS。
4. 选择视频、音乐和视频原声。仅有一个媒体文件时会自动选中；有多个时自行选择。按钮下会解释不能开始的原因。
5. 需要开播时，点击这个实例“开始直播”。等待真实 ingest active、lifecycle live 和 OBS 推流确认后，面板才显示 LIVE。
6. 第二个面板也点击开始，可并行准备与直播；不必等待第一个实例全部处理完成。
7. 点击指定面板“结束直播”，只结束该频道并停止所属 OBS 推流；其他面板继续直播。

场次创建成功后，开停播按钮下方出现 **“打开直播页面 ↗”**，在新标签页打开该面板对应场次的 YouTube 观看页。结束后保留最近场次的入口，下一场创建成功后自动指向新场次；回放是否可看取决于 YouTube 的处理状态、隐私设置及场次是否仍存在。尚未创建场次时不显示链接，点击链接不会开始或结束直播。

LivePilot 不替你完成 Google 本人登录或真实开播验收。保持服务窗口运行；关闭网页不会停止直播。结束后可以保持 OBS 运行。

需要使用生产服务时，先停止 dev，再执行：

```powershell
npm run verify
npm run start
```

不要同时运行 dev 和 start。默认固定监听 127.0.0.1:3010；若必须改端口，同时调整 package.json 中 dev/start 参数、LIVEPILOT_ORIGIN 和 Google redirect URI。公网访问必须经过 HTTPS 入口和成员登录；配置方式见[远程控制与素材上传](docs/远程控制与素材上传.md)。不要直接暴露 OBS WebSocket。

## 6. 双账号真实验收

单账号开停播已由用户反馈测试成功。升级后的多实例自动化测试使用模拟 OBS/YouTube；**不能代替双账号真实并发验收**。

- 两个 OBS 都 Ready、每个面板显示不同且正确的频道。
- 两边选择不同媒体或原声开关，各自开始，YouTube Studio 均显示正确音画。
- 两边同时 LIVE，观察编码负载、丢帧、网络上传。
- 只结束 A，确认 A 的 YouTube complete / OBS inactive，而 B 仍在直播。
- 再结束 B；两份 OBS 程序仍可运行。
- 重新打开 LivePilot 能读取已保存状态和各自授权。
- 增加第三个配置时出现第三面板，不能串用其他实例的密码、媒体选择和频道。
- 真实网络故障、长时间循环、并发硬件容量仍需按本机条件验收。

## 常见问题与恢复

| 现象 | 处理 |
| --- | --- |
| OBS Offline | 检查该面板对应的 exe、WebSocket 启用状态、端口、密码；用“启动 OBS”启动指定程序。进程已运行不代表 WebSocket 已 Ready |
| Windows 进程或端口查询超时 | 此时尚未启动 OBS；检查系统负载后重试。新版使用原生 netstat 读取端口 PID，避免 Get-NetTCPConnection 的慢速查询 |
| 多个实例同一路径或端口 | 每份 Portable OBS 独立目录和端口，改完 OBS 与 env 后重启服务 |
| 开始按钮不能点 | 看按钮下原因；媒体必须实际存在并选中、频道连接成功、配置齐全、状态未过期 |
| LIVE 缺少 VIDEO / MUSIC | 每份 OBS 都按标准建媒体源，检查拼写、全局音频及其他场景项 |
| 黑屏或无声 | 检查对应 OBS 预览、VIDEO 变换、音轨/混音、电平与编码配置；原声 OFF 时仍应有 MUSIC |
| OAuth 403 / access_denied | 在同一 Google 项目的 Audience → Test users 加入当前登录邮箱 |
| redirect_uri_mismatch | Web application 客户端添加完整 3010/api/youtube/callback，127.0.0.1 与 localhost 不混用 |
| 一周后需要重新连接 | Testing 的授权有效期限制；在对应面板重新授权，未结束场次只能授权原频道 |
| YouTube complete 失败 | 在对应频道的 Studio 手动核对并结束场次，再回面板重试结束。未开始的场次可能需在 Studio 删除 |
| 创建结果不确定 | 不要删除 .data，也不要重复盲建；重试会按持久化标题查找。仅确认 Studio 中不存在时用 Advanced 恢复 |
| 锁文件残留 | 先确认旧服务已退出，执行下面的锁恢复命令；程序会拒绝删除仍有存活 PID 的锁 |
| 新电脑无法解密 | 新电脑应生成自己的密钥并重新授权。现有电脑意外换密钥则恢复原密钥，不清空直播状态 |
| 第二频道授权成主频道 | 重新授权选择正确账号/品牌频道；服务端会拒绝两个实例绑定同一频道 |

锁恢复默认处理主实例 control.lock；额外锁只按错误中指示的类型处理：

```powershell
npm run recover:lock -- main
npm run recover:lock -- obs_a
npm run recover:lock -- obs_a tokens
npm run recover:lock -- main oauth-bindings
```

这不会停止 YouTube 或 OBS，也不删除控制状态或 Token。若 PID 无法验证，请人工核对，不强行删锁。

## 架构、工程和后续路线

详细模块、HTTP 契约、存储及恢复见 [架构文档](docs/ARCHITECTURE.md)；验证边界见 [验证记录](docs/VALIDATION.md)。`src/app/console.tsx` 管理实例清单，`instance-console.tsx` 展示单实例，`use-instance.ts` 管理独立状态；`src/server/service.ts` 注入对应 OBS、YouTube 和 Store，`control.ts` 执行严格开停播顺序。

main 数据仍位于 .data 根目录；其他数据位于 .data/instances/<id>。Token 使用 AES-256-GCM 加密，状态原子写入，互斥按实例生效。进程归属通过 Win32_Process 的 exe 真实路径与原生 netstat 监听 PID 交叉核对；不使用可能很慢的 Get-NetTCPConnection。浏览器只接触媒体文件名与状态 DTO；Stream Key 和密码不进入日志。OBS 本身保存的配置也应受本机权限保护。

`npm run verify` 包括 strict typecheck、ESLint、Vitest 和生产 build。next-env.d.ts 是 Next.js 生成的类型声明，package-lock.json 固定依赖，不手改生成文件。开发前阅读 [工程协作规范](docs/工程协作规范.md) 与 [PR 撰写规范](docs/PR撰写规范.md)，分支和提交按规范命名。

当前完成同机多 OBS 独立控制。后续才做 Start All / Stop All、Media Preset 批量分发。长期通过 RemoteObsRuntime / Local Agent 扩展到多电脑；当前只实现 LocalObsRuntime，中央服务器未来也只发送控制命令，永远不转发媒体流。
