/** 管理员页面入口，共用登录门禁和服务端权限接口。 */
import AccessGate from "../access-gate";
import Admin from "./panel";
/** 登录身份决定页面入口。 */
export default function Page() { return <AccessGate><Admin /></AccessGate>; }
