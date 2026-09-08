/** 登录后显示现有多实例控制台；API 另行验证会话。 */
import Console from "./console";
import AccessGate from "./access-gate";
/** 保持页面外壳无敏感数据。 */
export default function Home() { return <AccessGate><Console /></AccessGate>; }
