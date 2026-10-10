<!-- 文件用途：记录 21st.dev 组件来源、许可证、适配边界和本地界面验收入口。 -->
# 工作台组件与动效

## 来源与接入方式

从 [21st.dev](https://21st.dev/community/components) 选型，使用原作者公开源码，不依赖站点登录后的代码解锁。项目继续使用本地 CSS 与自托管中文字体，没有引入 Tailwind 的全局重置。

| 来源 | 当前实现 | 适配 |
| --- | --- | --- |
| [shadcn Tabs](https://21st.dev/@shadcn/components/tabs) | 直播四步、AI 互动、管理员页签 | Radix 键盘导航；隐藏面板继续挂载，保留草稿 |
| [shadcn Collapsible](https://21st.dev/@shadcn/components/collapsible) | 实例展开、上传区域、故障详情 | CSS grid 高度过渡；关闭时 inert，保留异步状态 |
| [shadcn Sheet](https://21st.dev/@shadcn/components/sheet) / [Dialog](https://21st.dev/@shadcn/components/dialog) | 窄屏导航、排期编辑、设备与批次移除确认 | 中文标题、焦点返回；提交中禁止遮罩和 Escape 关闭 |
| [shadcn Popover](https://21st.dev/@shadcn/components/popover) | 登录账户切换 | 门户防止裁切；账户隔离及重新登录逻辑不变 |
| [shadcn Progress](https://21st.dev/@shadcn/components/progress) | 素材上传、发布完成量 | 修正上游示例未传 Root value 的问题；ARIA 数值与视觉值一致，只使用真实报告 |
| [Origin UI Stepper](https://21st.dev/@originui/components/stepper/controlled-vertical) | 发布向导受控步骤导航 | 参考步骤圆点及连接线，独立实现横向布局，不将已访问误报为任务完成 |
| [Image Preview Dropzone](https://21st.dev/@uilayout.contact/components/imgpreview-dropzone) | 封面及素材拖拽选择 | 参考其 react-dropzone 交互，独立实现单文件入口；保留 2 MB 封面上限与 Agent 上传逻辑 |
| [File Upload Progress List](https://21st.dev/@sean0205/components/c-progress-5) | 文件名、进度、大小、动作分层 | 参考布局，不采用演示计时器或虚构上传速度 |

shadcn 适配源码：`src/app/components/ui/primitives.tsx`。上游路径为 `shadcn-ui/ui/apps/v4/registry/new-york-v4/ui/`，核对提交 `c2a67849be260701852b0977ba15eb5f3a0ce2a4`，MIT 许可证完整保存在 [third-party/shadcn-LICENSE.txt](third-party/shadcn-LICENSE.txt)。仅参考布局的组件不声称原样移植。

新增运行依赖为 Radix Tabs、Collapsible、Dialog、Progress、Popover 和 react-dropzone。它们只运行于展示层。身份验证、设备归属、OBS/YouTube 控制、上传确认、发布排期和令牌存储没有迁移。

## 改造前后

| 区域 | 原来 | 现在 |
| --- | --- | --- |
| 导航 | 网页和客户端各自排版，窄屏链接换行 | 共用侧栏；窄屏焦点受控抽屉；账户弹层 |
| 多实例 | 所有实例默认展开 | 每台电脑默认展开第一个；其他保留摘要和快控 |
| 离线提示 | 同一设备每个实例重复网络告警 | 设备层集中离线说明；操作结果未知及实例特有错误仍独立显示 |
| 直播配置 | 三个页签加侧栏开播区 | 四个统一编号页签，方向键导航与下一步；预览保持可见 |
| 封面 | 原生文件按钮 | 单文件拖拽、选择、替换、校验、16:9 预览 |
| 素材上传 | 文件按钮和原生进度条 | 拖拽入口、可收起面板、Radix 进度；恢复逻辑不变 |
| 故障恢复 | 长段说明和技术报告直接占据主区域 | 事实和恢复动作可见，处理说明与报告展开查看 |
| AI 互动 | 设置、计数、记录连续堆叠 | 设置 / 活动记录页签，滚动消息列表与回复气泡 |
| 视频发布 | 分散步骤外观 | 统一受控步骤；目录、批次、星期选择和表单分组统一样式 |
| 排期 | 月历下方插入编辑表单 | 点击事件打开右侧抽屉；月份、时区与计划数据保留 |
| 我的发布 | 原生进度和空白提示 | 真实完成进度条；空状态提供“发布第一批视频”入口 |
| 管理台 | 普通按钮切换页面 | Radix 页签及统一统计、表格、筛选控件样式 |
| 设备/批次移除 | 就地确认/原生对话框 | 共用受控确认框，失败保留，提交中防止误关闭 |
| 客户端 | 独立导航与公共控件视觉 | 共用导航和设计变量；保留本机配置与更新行为 |

现有可搜索时区、日期输入、表格筛选、分页、客户端更新面板以及下载页继续使用原有业务组件，公共控件视觉统一；未为替换而引入第二套调度或表格状态。公开下载页的业务入口、法务正文与安装包发布状态不变。

## 动效与可访问性

- 直播编辑面板保留单层外框、下划线页签和 AI 区块底部分隔线；AI 内容不再嵌套无内边距的圆角卡片，标题与输入对齐。
- 180–240 ms 的页签进入、折叠高度、弹层和侧栏滑入；进度只随报告变化。
- 关闭的实例内容保持挂载但设置 inert；不会让键盘进入不可见按钮。
- 弹层支持 Escape、外部点击与焦点返回；提交期间锁定关闭动作。
- `prefers-reduced-motion: reduce` 关闭动画和滚动过渡。
- 移动端使用单列编辑区和抽屉导航；月历继续使用已有日期清单。

## 本地预览

```powershell
npm run verify
npm run desktop:renderer
npm run preview:local
```

打开 `http://127.0.0.1:3020` 查看入口，客户工作台为 `http://127.0.0.1:3021/workspace`，发布页为 `http://127.0.0.1:3021/publishing`，管理员为 `http://127.0.0.1:3023/admin`。服务仅监听 loopback，数据写入本次 `.data/preview/session-*`，不覆盖日常数据。

发布示例包含当前月份草稿、已配置批次与合成进度。草稿编辑只修改内存；其他发布写操作明确拒绝。开停播只修改演示状态；没有真实 OAuth、素材传输或直播。

默认 AI 文案使用合成响应。只有主动设置 `LIVENEST_PREVIEW_REAL_AI=1` 才允许读取本机 DeepSeek 环境密钥并发起真实生成请求；密钥保存入口保持禁用。

## 本次验收记录（2026-10-10）

- 用户对照截图后的逐页复查、六处修复及边界见 [前端回归检查](前端回归检查.md)。工作台截图已更新为修复后的单层边框版本。
- `npm run verify`：类型检查、Lint、99 个测试文件 / 946 项测试、8 项部署检查、Web 与 Agent 构建全部通过。
- `npm run desktop:renderer`：客户端渲染器类型检查与静态导出通过；最终频道摘要文案及窄屏导航样式调整后重新完成 Web 构建。
- Edge 本地生产构建：四步切换、实例折叠后标题草稿保留；排期抽屉 Escape 关闭后焦点返回原事件；保存演示草稿后日历标题更新。
- 391 × 844 CSS 像素：发布页切换为日期清单，导航抽屉纵向显示且无横向溢出；已移除旧发布导航的窄屏网格规则，恢复默认视口。
- 管理员设备 / 客户页签、账户弹层、桌面客户端静态预览均可打开；工作台、发布页和客户端预览没有浏览器 error 日志。
- 截图均为隔离的示例数据：[工作台](screenshots/ui-refresh-20261010/workspace.jpg)、[排期抽屉](screenshots/ui-refresh-20261010/publishing-sheet.jpg)、[窄屏导航](screenshots/ui-refresh-20261010/publishing-mobile.jpg)、[客户端](screenshots/ui-refresh-20261010/desktop.jpg)。

浏览器模拟不等于 Windows 安装包、真实 OBS 或 YouTube 集成验收。本次 PR 不自动合并、部署或发布安装包。
