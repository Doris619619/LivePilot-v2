/** 文件用途：复用 Threadline 的 Windows x64 NSIS 发布链，安装资源只按白名单打包。 */
module.exports = {
  appId: 'com.doris619619.livenest', productName: 'LiveNest', electronVersion: '44.0.0',
  directories: { app: 'build/desktop-app', output: 'release', buildResources: 'desktop-resources' },
  files: ['package.json', 'dist-electron/**/*', 'desktop/out/**/*'], asar: true,
  extraResources: [
    { from: 'scripts/desktop/obs-firewall.ps1', to: 'helpers/obs-firewall.ps1' },
    { from: 'desktop-resources/agent', to: 'agent' },
    { from: 'desktop-resources/vendor', to: 'vendor', filter: ['node.exe', 'obs.zip', 'manifest.json', 'NODE-LICENSE.txt', 'OBS-COPYING.txt'] },
    { from: 'desktop-resources/icon.png', to: 'icon.png' },
    { from: 'desktop-resources/THIRD-PARTY.txt', to: 'THIRD-PARTY.txt' },
    { from: 'desktop-resources/FONT-OFL.txt', to: 'FONT-OFL.txt' },
  ],
  afterPack: './scripts/desktop/after-pack.cjs',
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'desktop-resources/icon.ico' },
  nsis: { include: 'scripts/desktop/installer.nsh', oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'LiveNest', deleteAppDataOnUninstall: false },
  publish: { provider: 'github', owner: 'Doris619619', repo: 'LiveNest-Releases', releaseType: 'draft' },
  artifactName: 'LiveNest_${version}_${arch}-setup.${ext}',
};
