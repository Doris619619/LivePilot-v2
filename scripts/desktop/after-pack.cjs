/** 文件用途：与 Threadline 相同的 Electron fuse 加固，关闭运行时注入入口。 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { flipFuses, getCurrentFuseWire, FuseV1Options: F, FuseVersion } = require('@electron/fuses');
const path = require('node:path');
/** 打包后修改并回读，验证最终 exe 确实包含所需安全选项。 */
exports.default = async function afterPack(context) {
  const executable = path.join(context.appOutDir, 'LiveNest.exe');
  const settings = { [F.RunAsNode]: false, [F.EnableCookieEncryption]: true, [F.EnableNodeOptionsEnvironmentVariable]: false, [F.EnableNodeCliInspectArguments]: false, [F.EnableEmbeddedAsarIntegrityValidation]: true, [F.OnlyLoadAppFromAsar]: true, [F.GrantFileProtocolExtraPrivileges]: false };
  await flipFuses(executable, { version: FuseVersion.V1, ...settings }); const wire = await getCurrentFuseWire(executable);
  for (const [key, enabled] of Object.entries(settings)) if (wire[Number(key)] !== (enabled ? 49 : 48)) throw new Error('Electron fuse verification failed: ' + key);
};
