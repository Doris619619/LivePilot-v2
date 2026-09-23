/** 客户工作台和管理员协助操作入口。 */
import AccessGate from "../access-gate";
import Console from "../console";
/** 设备清单由服务端按客户过滤。 */
export default function Page() { return <AccessGate><Console /></AccessGate>; }
