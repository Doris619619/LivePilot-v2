/* 文件用途：LiveNest 直播控制台主页面入口，包裹身份鉴权门禁并挂载多实例控制台中枢。 */

import Console from "./console";
import AccessGate from "./access-gate";

/**
 * 页面根组件，确保在通过身份鉴权后渲染 LiveNest 控制台，保证页面外壳无敏感凭据泄露。
 *
 * @returns 包含访问门禁与控制台的 React 元素
 */
export default function Home() {
  return (
    <AccessGate>
      <Console />
    </AccessGate>
  );
}
