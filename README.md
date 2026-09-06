# LivePilot v2

OBS + YouTube 的本机直播控制台。全新独立项目，不继承旧 LivePilot 的架构或 Git 历史。

## MVP 边界
一台 Windows、一个 Portable OBS、一个 YouTube Channel。每场直播固定一个循环视频、一段循环音乐，可开关视频原声。浏览器通过本机 Node.js 服务控制 OBS WebSocket v5，OBS 直接推流到 YouTube。

## 架构基线
- Browser → Next.js Server → LocalObsRuntime → ObsController / ObsProcessManager → OBS。
- Server → Google OAuth / YouTube Live API。密钥只在服务端。
- 本地媒体由 MEDIA_ROOT/videos 和 MEDIA_ROOT/music 扫描；客户端仅使用相对文件名。
- 固定 LIVE 场景、VIDEO / MUSIC 媒体源；校验结构后设置媒体。
- 单个互斥操作与一个持久化控制状态，不引入 Job / Run 系统。
- Start：授权检查 → OBS ready → 场景与媒体 → Broadcast/Stream/bind → 配置 OBS ingest → StartStream → ingest active → transition live → 读取确认。
- Stop：transition complete → 读取确认 → StopStream → 读取确认。结束直播不关闭 OBS。
- 操作失败停止后续动作；保留 Broadcast/Stream 标识和实际阶段，以便结束/恢复。
- 缺失 Secret、用户 OAuth、真实媒体和真实开播验证由用户完成，不猜测配置。

## 未来（不实现）
Phase 2：多个 Portable OBS，各自对应 Channel，独立控制、Start All / Stop All、Media Preset 分发。
长期：中央控制台 → Local Agent → 多个 OBS。仅传控制命令，媒体始终 OBS → YouTube，中央服务器不转发媒体。当前保留 ObsRuntime 接口；未来 RemoteObsRuntime 实现同一边界。

## 实施状态
此提交固定架构和范围；运行说明、实现和验证记录随后补齐。
