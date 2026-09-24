/** 真实桌面与双 OBS 控制验收；客户认证为模拟服务，禁止访问生产云端或开播。 */
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const base = path.resolve('.data'); const data = await mkdtemp(path.join(base, 'two-obs-016-'));
const output = path.resolve('docs/desktop/screenshots/binding'); await mkdir(output, { recursive: true });
const env = { ...process.env, LIVENEST_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const application = await _electron.launch({ executablePath: require('electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
try {
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), data);
  // 只替代此隔离进程的云端认证，真实 IPC、Manager、磁盘、OBS 进程和 WebSocket 均不替代。
  await application.evaluate(({ net }) => { net.fetch = async url => {
    if (String(url).includes('/api/desktop/session')) return Response.json({ token: 'a'.repeat(64), user: { username: 'fixture', role: 'customer' }, expires: Date.now() + 3600000 });
    if (String(url).endsWith('/api/health')) return Response.json({ ok: true });
    throw new Error('Production access prohibited in isolated acceptance');
  }; });
  const page = await application.firstWindow(); await page.getByRole('heading', { name: '登录 LiveNest' }).waitFor();
  await page.getByLabel('账号', { exact: true }).fill('fixture'); await page.getByLabel('密码', { exact: true }).fill('fixture-only'); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '设备配置', exact: true }).waitFor();
  await page.waitForFunction(async () => !(await window.liveNest.readState()).state?.busy, null, { timeout: 120000 });
  const initial = await page.evaluate(() => window.liveNest.readState()); assert.equal(initial.ok, true); assert.equal(initial.state.paired, false); assert.equal(initial.state.instances.length, 0);
  for (let i = 0; i < 2; i++) {
    const result = await page.evaluate(() => window.liveNest.act('add'));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.state.instances.length, i + 1); assert.equal(result.state.instances[i].initialized, true);
  }
  const ready = (await page.evaluate(() => window.liveNest.readState())).state;
  assert.equal(new Set(ready.instances.map(i => i.port)).size, 2); assert.equal(new Set(ready.instances.map(i => i.exe)).size, 2);
  for (const instance of ready.instances) {
    assert.ok(path.resolve(instance.exe).startsWith(data + path.sep));
    const checked = await page.evaluate(id => window.liveNest.act('diagnose-obs', { id }), instance.id);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    const check = checked.state.checks.find(c => c.id === 'network-' + instance.id);
    assert.ok(check && !['not-running', 'not-listening', 'auth', 'port-conflict'].includes(check.code), JSON.stringify(check));
    const repeated = await page.evaluate(id => window.liveNest.act('prepare', { id }), instance.id);
    assert.equal(repeated.ok, true, JSON.stringify(repeated)); assert.equal(repeated.state.instances.length, 2);
  }
  await page.getByRole('button', { name: '本机 OBS', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.desktop-instance').length === 2);
  await page.evaluate(() => { const note = document.createElement('div'); note.textContent = '隔离验收 · 真实双 OBS 控制连接 · 模拟客户认证 · 未配对生产云端 / 未开播'; note.style.cssText = 'padding:8px;background:#254131;color:white'; document.body.prepend(note); });
  await page.screenshot({ path: path.join(output, 'two-real-obs.png'), fullPage: true });
  await writeFile(path.join(data, 'acceptance.json'), JSON.stringify({ passed: true, instances: ready.instances.map(({ id, name, port, initialized }) => ({ id, name, port, initialized })), productionPairing: false, streaming: false }, null, 2));
  console.log(JSON.stringify({ passed: true, data, instances: ready.instances.map(({ name, port }) => ({ name, port })), realObs: true, productionPairing: false }));
} finally {
  if (path.dirname(data) !== base || !path.basename(data).startsWith('two-obs-016-')) throw new Error('Unsafe cleanup');
  // 仅清理本次隔离目录内的测试 OBS；正常关闭超时后结束测试进程，绝不操作用户原 OBS。
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$target=[IO.Path]::GetFullPath($env:LN_OBS_TEST_ROOT); Get-CimInstance Win32_Process -Filter "Name = \'obs64.exe\'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($target+"\\",[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $owned=Get-Process -Id $_.ProcessId; [void]$owned.CloseMainWindow(); if (!$owned.WaitForExit(10000)) { $owned.Kill(); [void]$owned.WaitForExit(3000) } }'], { windowsHide: true, env: { ...process.env, LN_OBS_TEST_ROOT: data }, stdio: 'ignore' });
  await application.evaluate(({ app, BrowserWindow }) => { app.removeAllListeners('before-quit'); for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('close'); });
  await application.close();
}
