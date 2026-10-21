/** 旧发布集成测试显式提供合成历史基线；生产未知基线仍严格关闭准入。 */
import { updateYouTubePolicy } from "@/cloud/youtube-usage";
import { quotaDay } from "@/core/publishing/schedule";
/** 在测试专属数据目录声明本PT日已知零历史消耗，不接触Google监控。 */
export async function seedTestYouTubeBaseline() { await updateYouTubePolicy({ baseline: { day: quotaDay(), units: 0, uploads: 0, source: "conservative-estimate" } }, "synthetic-admin"); }
