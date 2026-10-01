/** 无需登录的产品隐私政策，说明真实数据分工、期限和可执行删除入口。 */
import Link from "next/link";
import { publishingPrivacyContact } from "@/cloud/publishing";
import { PRIVACY_VERSION } from "@/shared/publishing";
export const dynamic = "force-dynamic";
/** 联系信息由运营者配置，公开页面不返回任何客户的频道或发布状态。 */
export default async function PrivacyPage() {
  const contact = await publishingPrivacyContact();
  return <main style={{ maxWidth: 860, margin: "auto", padding: "48px 24px", lineHeight: 1.85 }}><Link href="/workspace">返回工作台</Link><h1>LiveNest 隐私政策</h1><p>版本：{PRIVACY_VERSION}。运营者隐私联系地址：{contact}</p>
    <h2>我们处理的信息</h2><p>Cloud 保存账号和设备归属、用户确认的发布配置与不可变批次、排期、配额使用、频道标识和 Agent 回报的必要视频状态。Cloud 不接收 Google Token、上传 session URI 或本地视频字节。Windows Agent 加密保存 Google 授权、上传会话和恢复检查点，读取您选定的源视频与缩略图并直接发送给 YouTube。</p>
    <p>Google / YouTube 接收授权请求、视频、缩略图、元数据与发布设置，按其政策处理。AI 默认关闭；明确启用后，DeepSeek 接收您配置的 Prompt、素材文件名主题、语言和模板以生成标题与说明，不接收视频字节或 Google 授权。您可关闭 AI、填写人工文案或在确认页逐项覆盖。故障时仅使用预先同意的兜底文案。</p>
    <h2>使用、共享和安全</h2><p>这些信息仅用于身份与设备权限管理、执行用户确认的上传与排期、恢复中断任务及反馈结果。仅当前设备所属用户与获准管理员可访问，管理员操作留有审计。必要数据只发送给承担上述服务的 Google / YouTube 或您启用的 DeepSeek。我们不出售 API 数据，不用于广告投放，不训练模型；密钥不进入浏览器或日志。</p>
    <h2>保存和删除</h2><p>计划与配置在您删除前保存；API 返回的频道和视频数据须在 30 天内刷新或删除。Cloud 清除过期观察数据；Agent 无法核对时停止自动执行并清除过期 API 数据，保留禁止重复上传的本地执行标记。源视频属于您提供的本地文件，不随撤销自动删除。</p>
    <p>在<Link href="/publishing">视频发布 → 授权与数据</Link>可撤销授权并删除 Cloud / Agent 保存的 YouTube 数据。Cloud 立即停止新派发并删除相关发布记录；Agent 清除检查点、停用本地 Token，调用 Google 撤销接口。客户端请求尽快处理，最迟七日；离线设备显示“等待设备清理”，运营者应联系设备负责人在期限内上线。仅设备清理和 Google 撤销确认后才显示完成。联系上述地址可提出隐私、删除或更正请求。</p>
    <p>撤销该实例的授权会影响其直播 API 控制。已经提交给 YouTube 的定时视频仍可能公开；撤销不会自动删除视频或取消远端排期。需要停止公开时，请先在设备在线时取消任务并核对，或到 YouTube Studio 管理。</p>
    <h2>第三方条款与控制入口</h2><ul><li><a href="https://www.google.com/policies/privacy/">Google Privacy Policy</a></li><li><a href="https://policies.google.com/terms">Google Terms</a></li><li><a href="https://www.youtube.com/t/terms">YouTube Terms</a></li><li><a href="https://www.youtube.com/howyoutubeworks/policies/community-guidelines/">YouTube Community Guidelines</a></li><li><a href="https://security.google.com/settings/security/permissions">Google 授权管理与撤销</a></li><li><a href="https://www.deepseek.com/en">DeepSeek 服务与隐私说明</a></li></ul><p>本产品使用 YouTube API Services；使用前请阅读 Google 隐私政策。政策发生变化时，使用发布功能前需重新同意当前版本。</p></main>;
}
