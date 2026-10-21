/** 测试显式安装纯内存配额运行时；不在生产代码按环境变量放行，网络仍由各用例独立 Mock。 */
import { beforeEach } from "vitest";
import { installYouTubeRuntime } from "../src/core/youtube/usage";
import { youtubeCost } from "../src/shared/youtube-usage";
import { nextQuotaMidnight } from "../src/core/live-chat/policy";

/** 每例重置内存熔断和计量；只模拟准入，不替代具体 HTTP/gRPC 安全测试。 */
beforeEach(() => installYouTubeRuntime({
  async admit(attempt) { return { allowed: true, attemptId: attempt.attemptId, project: "synthetic-project", quotaDay: "2026-10-20", ...youtubeCost(attempt.method), remaining: 9000, backgroundRemaining: 2000, activeInstances: 1, resetAt: nextQuotaMidnight(Date.now()) }; },
  async record() { /* 独立测试可用 spy 替换并断言字段；这里绝不发请求。 */ },
}));
