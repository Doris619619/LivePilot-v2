/** 管理员页面入口，共用登录门禁和服务端权限接口。 */
import type { Metadata } from "next";
import AccessGate from "../access-gate";
import Admin from "./panel";
export const metadata: Metadata = { title: "管理员总览 · LiveNest" };
/** 登录身份决定页面入口。 */
export default function Page() { return <AccessGate><Admin /></AccessGate>; }
