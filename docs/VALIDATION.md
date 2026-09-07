<!-- 文件用途：记录可复核的自动化、本机只读检查及尚待用户完成的真实直播验收。 -->
# 验证记录 — 2026-09-07 多实例

## 本次已验证

- `npm run verify`：strict typecheck、ESLint 零警告、6 个文件 / 73 项测试、Next.js 16.3.3 生产构建全部通过。
- 原 50 项回归保留；新增三个实例并行开始、单独结束、某个 complete 失败不影响其他实例、独立媒体原声设置。
- 配置检查覆盖多个 ID、未知/越界/重复/Windows 保留 ID、重复端口与不同写法的相同 Windows 路径。
- 授权检查覆盖 main 原目录兼容、实例 Token 不复制、不同 Cookie/state、错误实例回调、重复频道拒绝、同时绑定竞争以及旧刷新不覆盖新授权。
- HTTP 路由测试验证写操作必须显式携带 instanceId，callback 只交还发起面板，多个控制器各用自己的端口和密码。
- 本机服务已恢复在 http://127.0.0.1:3010；/api/instances 返回 main / obs_a。
- 只读状态：main 的原频道仍 Connected、OBS Ready、phase stopped、OBS 未推流；原 control.json 与修改前备份哈希一致。
- obs_a 的 exe 已存在；配置中使用独立端口 4455，WebSocket 密码待填，YouTube 尚未授权。A 尚无 Portable WebSocket / scene 配置；已添加空 portable_mode.txt，首次初始化仍需用户完成。
- 浅色页面经真实浏览器截图检查：桌面两列；390px 窄屏单列，内容宽度与可用视口一致，无横向溢出；按钮高 46px、主要动作 50px。
- A 原声开关切换时 B 保持原值，检查后已恢复 A 为 OFF。未点击真实开始/结束按钮，也未进行新 OAuth 同意。
- 浏览器未记录 error / warn；服务 stderr 为空。
- .env.local、.data 与嵌套实例授权均被 Git 忽略；旧 D:\Repo\LivePilot 工作区仍干净。
- 用户提供的两份协作规范已复制到本仓库 docs，仅调整项目称谓；没有迁移旧业务代码。

## 验收边界

单账号真实直播成功来自用户本次任务前的明确反馈；本次又只读确认其结束状态与授权保留。这不等于新增多实例已经通过双账号真实推流验收。

仍待用户：

1. 首次初始化 OBS A，设置 WebSocket 4455、密码及标准 LIVE / VIDEO / MUSIC 场景。
2. 在本机 .env.local 填写 LIVEPILOT_INSTANCE_OBS_A_OBS_WS_PASSWORD；如端口不同则同步改 URL，重启服务。
3. 在 A 面板本人授权第二个不同频道。
4. 分别开播并同时确认两个真实 LIVE、音画正确；只结束一个时另一个继续直播，再结束另一个。
5. 评估本机并发编码负载、丢帧、带宽、长时间循环及真实故障恢复。

UI 截图已在当前 Codex 任务中展示并目视检查；未作为仓库图片附件保存。自动化测试全部使用模拟上游，不消耗真实创建直播资源。

## 历史基线

2026-09-06 初始独立 MVP 在提交 66c8ff9 完成 4 个文件 / 50 项测试及生产构建。当时尚未进行真实 OAuth / OBS / YouTube 验收；后续用户完成单账号测试后，才提出本次多实例扩展。旧记录中的“尚未验证”是该日期的历史状态，不代表当前主实例授权丢失。

## 启动故障修复（同日后续）

- 用户配置中的 A/B exe 均存在，WebSocket 端口和密码与各自 OBS 配置一致；未修改或重置密码。
- 故障位于启动前的 Windows 进程/端口检查。单独测量旧 Get-NetTCPConnection 查询约 11.5 秒，接近整段检查的 15 秒时限；原生 netstat 同机约 0.8 秒。
- 改用 Win32_Process 查询 exe 对应进程、原生 netstat 读取监听 PID，保留端口归属保护；路径不存在、查询超时和启动参数错误分别给出安全提示。
- 安全错误使用跨模块 WeakSet 登记，避免热更新后 instanceof 失配将具体错误变成通用 500；普通或伪造上游错误仍不向前端暴露原始消息。
- npm run verify 全部通过：8 个测试文件、80 项测试、strict typecheck、lint、生产构建。
- 通过与网页相同的 POST /api/control（action=launch，instanceId=main）真实启动 OBS B，约 17.3 秒返回成功。随后只读确认 A/B 均 Ready，scene LIVE，OBS 均未推流。
- 此次不关闭 OBS、不创建 YouTube 场次、不操作真实开始/结束直播。前文 A 尚未设置 WebSocket 的记录为本次修复前的历史状态；用户现已完成相应配置。

## 直播观看链接（同日后续）

- 每个面板在开停播按钮下显示所属场次的“打开直播页面 ↗”，使用当前 broadcastId 生成 YouTube watch URL。
- 真实浏览器核对两个面板的链接分别匹配各自场次，目标不同；均为新标签页，带 noopener noreferrer，点击区域高度 44px。已目视检查入口显示。
- 只读确认两路 OBS 均 Active、YouTube ingest active、lifecycle live。此项更新没有重启服务或执行开始/结束直播。
- npm run verify 再次全部通过：8 个文件 / 80 项测试、strict typecheck、lint、生产构建。此次为普通链接展示，未新增重复实现的单元测试。
- 代码检查确认无 broadcastId 时不显示入口，结束后保留最近场次 ID；未为验证链接而结束当前直播，也未验证结束后的实际 YouTube 回放可用性。
- 前文第二频道尚待授权及双路 LIVE 的记录为早期状态；现已只读确认两个不同频道同时 LIVE。音画、单独停止隔离及长时间并发仍需实际验收。
