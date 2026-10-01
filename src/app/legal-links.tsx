/** 所有页面持续提供产品隐私政策和服务条款入口。 */
import Link from "next/link";
/** 法律入口在登录前也可访问，不加载频道或授权数据。 */
export default function LegalLinks() { return <footer style={{ padding: "16px 24px", display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}><Link href="/privacy">隐私政策</Link><Link href="/terms">服务条款</Link></footer>; }
