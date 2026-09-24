/** 跨端公开问题契约与客户操作目录；不包含凭据、绝对路径或任意执行指令。 */
import { z } from "zod";
export const problemSchema = z.object({
  version: z.literal(1), source:z.enum(["core","agent","cloud","http","desktop","browser"]), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  domain: z.enum(["account", "device", "obs", "youtube", "media", "storage", "update", "operation"]),
  target: z.object({ agentId: z.string().max(64).optional(), instanceId: z.string().max(64).optional(), uploadId: z.string().uuid().optional() }).strict(),
  severity: z.enum(["info", "warning", "error"]), stage: z.string().max(160),
  outcome: z.enum(["not-sent", "rejected", "accepted", "completed", "partial", "unknown"]),
  observedAt: z.number(), attemptId: z.string().max(80).optional(), message: z.string().max(500),
  actions: z.array(z.enum(["refresh", "settings", "help", "login", "authorize", "resume-upload", "support"])).max(4),
  context: z.object({ port: z.number().int().min(1).max(65535).optional(), retryAt: z.number().optional() }).strict().optional(),
}).strict();
export type Problem = z.infer<typeof problemSchema>;
export type ProblemAction = Problem["actions"][number];
export type ProblemMeta = Partial<Pick<Problem, "source" | "target" | "stage" | "outcome" | "attemptId" | "context" | "domain">>;
type Guidance = { title: string; steps: string[]; actions: ProblemAction[] };
const obsSettings = "在对应直播电脑的 OBS 中打开“工具 → WebSocket 服务器设置”，核对启用状态、端口和密码，再重新检查。";
const network = "在直播电脑检查系统网络与代理是否能访问该服务；网页能打开不代表直播电脑能访问。处理后重新查询。";
const catalog: Record<string, Guidance> = {
  AUTH: {title:"需要重新登录",steps:["使用客户账号重新登录。登录状态变化不会停止 OBS。"],actions:["login"]},
  FORBIDDEN: {title:"当前账号无权访问这台电脑",steps:["核对当前登录账号。仍绑定其他客户的设备需要使用对应客户账号，或由管理员确认归属。"],actions:["login","refresh"]},
  AGENT_DELETED: {title:"设备已删除，需要重新配对",steps:["在网页添加直播电脑并生成新配对码，然后在本机粘贴连接。"],actions:["refresh"]},
  DESKTOP_IPC: {title:"本机状态暂未读取",steps:["点击重新读取；仍失败时正常退出并重新打开客户端。不能据此判断云端或 OBS 故障。"],actions:["refresh","help"]},
  DESKTOP_BUSY: {title:"正在等待当前操作结束",steps:["当前操作结束后重新读取，程序不会强行停止 OBS。"],actions:["refresh"]},
  CONFIG: {title:"配置尚未完成",steps:["在对应直播电脑检查客户端的数据位置和 OBS 连接设置。频道应用配置缺失时联系管理员；不要在安装目录修改源码或密钥。"],actions:["refresh","help","support"]},
  PAIR_CODE: {title:"配对码不可用",steps:["在网页为当前客户生成新配对码，回到原电脑粘贴；保留原设备身份。"],actions:["help"]},
  PAIR_IDENTITY: {title:"原电脑身份未确认",steps:["请使用原电脑的原 Windows 账户打开客户端。原身份仍无法确认时联系管理员，保留数据目录。"],actions:["support"]},
  OBS_NOT_RUNNING: {title:"OBS 尚未运行",steps:["在对应实例旁点击“启动并检查”，只启动程序，不会开始直播。"],actions:["refresh","settings"]},
  CHANNEL_IN_USE: {title:"频道已被其他实例使用",steps:["选择另一个独立频道，或联系管理员核对原实例归属；无需移除整台电脑。"],actions:["support"]},
  HOST_BUSY: {title:"原数据正被其他客户端使用",steps:["在对应电脑退出经确认使用同一数据的旧客户端，再重新连接。无法确认时请管理员核对；不要删除锁或授权文件。"],actions:["support","help"]},
  FIREWALL_UNCONFIRMED: {title:"OBS 入站隔离尚未确认",steps:["控制服务已经响应；请在对应电脑打开 Windows 防火墙设置，检查此 OBS 的入站限制。不要开放公网端口；确认后重新检查。"],actions:["settings","refresh"]},
  INSPECTION_UNAVAILABLE: {title:"本机诊断暂不可用",steps:["请在对应电脑重新检查；权限不足时联系管理员核对，当前无法确认运行或隔离状态。"],actions:["refresh","help"]},
  OBS_NOT_LISTENING: { title: "控制连接尚未建立", steps: [obsSettings, "当前无法控制 OBS，不能据此判断是否正在推流；防火墙尚未检查。"], actions: ["refresh", "settings"] },
  OBS_PORT: { title: "控制端口被其他程序占用", steps: ["在对应电脑核对 OBS 的控制端口。托管 OBS 可在确认已结束推流和录制并关闭后修复连接；不要结束其他程序。"], actions: ["refresh", "settings"] },
  OBS_AUTH: { title: "OBS 控制密码不匹配", steps: [obsSettings], actions: ["settings", "refresh"] },
  OBS_READ: { title: "暂时无法读取 OBS", steps: [obsSettings, "重新读取不会结束直播。"], actions: ["refresh", "settings"] },
  OBS_REQUEST: { title: "OBS 操作结果待核对", steps: ["先查询本次操作和实际 OBS 状态；不要重复开始直播。"], actions: ["refresh", "help"] },
  GOOGLE_AUTH: { title: "频道授权已失效", steps: ["在对应 OBS 卡片重新连接原 YouTube 频道；有未结束场次时不要更换频道。"], actions: ["authorize", "help"] },
  YOUTUBE_AUTH: { title: "频道授权已失效", steps: ["重新授权原频道，然后重新查询。"], actions: ["authorize", "help"] },
  GOOGLE_CONFIG: { title: "频道连接配置需要管理员处理", steps: ["联系管理员核对 Google 应用配置。重新输入客户密码不能解决此问题。"], actions: ["support"] },
  YOUTUBE_QUOTA: { title: "YouTube 请求额度暂不可用", steps: ["等待额度恢复；持续失败请联系管理员核对配额，不需要反复授权。"], actions: ["refresh", "support"] },
  STORAGE_PERMISSION: { title: "本机文件访问被拒绝", steps: ["在直播电脑使用原 Windows 账户，检查数据目录的读写权限；保留原文件。"], actions: ["refresh", "support"] },
  STORAGE_SPACE: { title: "存储空间不足", steps: ["在对应电脑检查数据盘剩余空间；整理与本应用无关的文件后重试，不要删除授权或直播状态。"], actions: ["refresh", "support"] },
  STORAGE_MISSING: { title: "所需文件暂不可访问", steps: ["连接原数据盘并核对对应目录是否存在；不要以新目录代替原身份。"], actions: ["refresh", "support"] },
  SNAPSHOT_READ: { title: "此实例状态读取失败", steps: ["在直播电脑检查数据盘、原 Windows 账户与目录权限。当前推流状态未知，旧快照仅供参考。"], actions: ["refresh", "support"] },
  RESULT_SAVE: { title: "操作结果未能保存", steps: ["操作可能已经生效。核对 OBS 和 YouTube 的实际状态，并检查直播电脑磁盘与权限；不要重复发起开播。"], actions: ["refresh", "support"] },
  CANCELLED: { title: "本次操作已取消", steps: ["可以保留当前输入，准备好后继续。"], actions: [] },
  UPDATE_INTEGRITY: { title: "更新文件校验未通过", steps: ["保留当前版本，联系管理员检查官方发行文件；不要绕过校验安装。"], actions: ["support"] },
  UPDATE_INSTALL: { title: "安装程序尚未启动", steps: ["点击“重试重启更新”。仍失败时从官方发行页下载安装包，在确认客户端正常退出后安装，保留原数据目录。"], actions: ["support"] },
  UPDATE_STATE: { title: "更新状态已变化", steps: ["查看软件更新区域的当前阶段，下载完成后再确认重启。"], actions: [] },
  AGENT_AUTH: { title: "设备配对已失效", steps: ["在网页为原客户获取新配对码，回到原电脑重新连接。软件更新无需重新配对。"], actions: ["help", "support"] },
  AGENT_CONNECTION: { title: "设备连接尚未确认", steps: ["等待已接收任务完成；需要恢复控制连接时，在设备配置中重新连接。不要强行结束 Agent 或 OBS。"], actions: ["help", "support"] },
  OBS_MAINTENANCE: { title: "本机 OBS 暂不满足维护条件", steps: ["在对应 OBS 核对实际推流、录制与控制连接。准备好后重试原操作；程序不会自动停播或结束录制。"], actions: ["help", "support"] },
};
/** 未知原因仍提供对象相关的核对步骤，不根据中文消息猜测可执行动作。 */
export function guidance(problem: Pick<Problem, "code" | "domain" | "outcome">): Guidance {
  if (catalog[problem.code]) return catalog[problem.code];
  if (/NETWORK|UNAVAILABLE|TIMEOUT/.test(problem.code)) return { title: "连接或服务暂不可用", steps: [network, ...(problem.outcome === "unknown" ? ["请求可能已经生效，先查询原操作结果。"] : [])], actions: ["refresh", "help"] };
  if (["CONTROL","UNCERTAIN","STOP_YOUTUBE","OBS_STOP","AGENT_TIMEOUT"].includes(problem.code)) return {title:"直播操作需要核对",steps:["先查询本次操作，并在对应电脑的 OBS 和原频道 YouTube Studio 核对推流与场次状态。","结束部分完成时使用原场次的结束操作；创建结果未知时先查询，不再次创建直播。"],actions:["refresh","help"]};
  if (problem.domain === "obs") return { title: "OBS 需要检查", steps: [obsSettings], actions: ["refresh", "settings"] };
  if (problem.domain === "youtube") return { title: "频道状态需要核对", steps: ["在对应频道的 YouTube Studio 核对直播权限与当前场次，再刷新本实例状态。"], actions: ["refresh", "help"] };
  if (problem.domain === "media") return { title: "素材操作需要处理", steps: ["查询原文件的上传或读取状态，在对应直播电脑检查目录和磁盘。结果未知时不要重新上传。"], actions: ["refresh", "help"] };
  if (problem.domain === "storage") return { title: "本机数据需要检查", steps: ["保留原数据，检查原磁盘、Windows 账户及目录权限；仍失败时复制摘要联系管理员。"], actions: ["support", "help"] };
  return { title: "当前步骤需要处理", steps: ["先重新读取当前对象的状态；若仍不能完成，复制诊断摘要交给管理员核对。"], actions: ["refresh", "support"] };
}
/** 只接收应用构造的安全说明；调用方负责在边界过滤第三方异常。 */
export function makeProblem(code: string, message: string, meta: ProblemMeta = {}): Problem {
  meta = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
  const domain = meta.domain || (/^OBS/.test(code) ? "obs" : /^(GOOGLE|YOUTUBE|CHANNEL|OAUTH)/.test(code) ? "youtube" : /^(MEDIA|UPLOAD|HASH|OFFSET)/.test(code) ? "media" : /^(STORAGE|HOST_BUSY|DATA|RESULT_SAVE|SNAPSHOT)/.test(code) ? "storage" : /^(AUTH|LOGIN|FORBIDDEN|OWNER)/.test(code) ? "account" : /^UPDATE/.test(code) ? "update" : /^(AGENT|CLOUD|PAIR)/.test(code) ? "device" : "operation");
  const base = { version: 1 as const, source: "core" as const, code, domain, target: meta.target || {}, severity: ["CANCELLED","OBS_NOT_RUNNING","DESKTOP_BUSY","AGENT_DELETED"].includes(code) ? "info" as const : "error" as const, stage: meta.stage || "读取或执行操作", outcome: meta.outcome || "unknown" as const, observedAt: Date.now(), message: message.slice(0, 500), ...meta };
  return { ...base, actions: guidance(base).actions };
}
/** 摘要仅使用公开字段，不复制表单、请求体或系统路径。 */
export function problemSummary(p: Problem) { return JSON.stringify({ code:p.code, source:p.source, target:p.target, stage:p.stage, outcome:p.outcome, observedAt:p.observedAt, attemptId:p.attemptId }); }

/** 把内部配置键映射为安装版真实设置与责任人。 */
export function configurationLabel(key:string) {
  if(key.startsWith("GOOGLE_"))return "Google 应用配置（联系管理员）";
  if(key.endsWith("OBS_EXE"))return "OBS 程序位置（在客户端检查）";
  if(key.endsWith("OBS_WS_URL"))return "OBS 控制端口（在客户端检查）";
  if(key.endsWith("OBS_WS_PASSWORD"))return "OBS 控制密码（在客户端检查）";
  if(key.endsWith("MEDIA_ROOT"))return "素材保存位置（在客户端检查）";
  if(key.endsWith("ENCRYPTION_KEY"))return "原数据身份（使用原 Windows 账户，联系管理员）";
  return "设备配置（联系管理员核对）";
}
