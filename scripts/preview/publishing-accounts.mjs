/** 账号布局的独立本地预览：编译真实界面、切换三种布局，只提供内存合成数据与受限 API。 */
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createPublishingPreview } from './publishing.mjs';
import { guardPreview, PreviewError } from './security.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.LIVENEST_PREVIEW_PORT || 3160);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
const origin = `http://127.0.0.1:${port}`;
const publishing = createPublishingPreview();
const instances = [{ id: 'main', name: 'OBS 1', agentId: 'preview_liang', agentName: '演示电脑' }];
const blockedMessage = '本地界面预览：不会连接真实频道、撤销授权或提交发布。';
const entry = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './src/app/globals.css';
import PublishingConsole from './src/app/publishing/publishing-console';
const layouts = [{ id: 'split', name: '方案一 · 列表与详情' }, { id: 'grid', name: '方案二 · 账号卡片' }, { id: 'compact', name: '方案三 · 紧凑表格' }];
/** 布局选择只属于预览外壳；切换属性时保留真实工作台中的账号与页面状态。 */
function Preview() {
  const [layout, setLayout] = useState(() => { const candidate = new URLSearchParams(location.search).get('layout'); return layouts.some(value => value.id === candidate) ? candidate : 'split'; });
  const [notice, setNotice] = useState('');
  useEffect(() => {
    /** 外部管理链接及未提供的页面仅提示，不允许从示例界面打开真实授权或服务。 */
    function stopNavigation(event) {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link) return;
      const destination = new URL(link.href, location.href);
      if (destination.origin === location.origin && ['/', '/publishing'].includes(destination.pathname)) return;
      event.preventDefault(); event.stopPropagation();
      setNotice('这是本地设计预览，外部页面与真实账号操作已关闭。');
    }
    document.addEventListener('click', stopNavigation, true); document.addEventListener('auxclick', stopNavigation, true);
    return () => { document.removeEventListener('click', stopNavigation, true); document.removeEventListener('auxclick', stopNavigation, true); };
  }, []);
  /** URL 只记录可分享的布局名称，既有组件与合成账号继续留在当前页面。 */
  function chooseLayout(value) { setLayout(value); const url = new URL(location.href); url.searchParams.set('layout', value); history.replaceState(null, '', url.pathname + url.search); }
  return <><header className="app-header preview-header"><div className="header-container"><div className="brand-section"><span className="brand-name">LiveNest</span><span className="preview-label">本地预览 · 合成数据</span></div><nav className="preview-layouts" aria-label="布局方案">{layouts.map(value => <button key={value.id} type="button" aria-pressed={layout === value.id} onClick={() => chooseLayout(value.id)}>{value.name}</button>)}</nav></div></header>{notice && <div className="preview-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice('')}>关闭</button></div>}<PublishingConsole accountsLayout={layout} initialSection="accounts" /></>;
}
createRoot(document.getElementById('root')).render(<Preview />);
`;
const compiled = await build({ stdin: { contents: entry, resolveDir: repo, loader: 'tsx' }, outfile: path.join(repo, '.data', 'publishing-accounts-preview.js'), write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(repo, 'src') }, define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' }, logLevel: 'silent' });
const javascript = compiled.outputFiles.find(file => file.path.endsWith('.js'))?.contents;
const css = compiled.outputFiles.find(file => file.path.endsWith('.css'))?.text;
if (!javascript || !css) throw new Error('Preview assets were not generated');
const previewStyles = `
.preview-header .header-container { gap: 20px; }
.preview-label { font-size: 13px; color: var(--text-muted); white-space: nowrap; }
.preview-layouts { display: flex; gap: 8px; overflow-x: auto; max-width: 100%; padding-block: 4px; }
.preview-layouts button { min-height: 40px; padding: 8px 12px; white-space: nowrap; flex-shrink: 0; font-size: 13px; }
.preview-layouts button[aria-pressed="true"] { color: var(--accent-primary); background: var(--accent-subtle); border-color: var(--accent-border); }
.preview-notice { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 24px; color: var(--text-secondary); background: var(--warning-amber-subtle); }
@media (max-width: 760px) { .preview-header .header-container { gap: 6px; } .preview-layouts { width: 100%; } .preview-label { font-size: 12px; } }
`;
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiveNest · 发布账号布局预览</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script src="/preview.js"></script></body></html>';

/** 所有响应禁用缓存；浏览器资源与连接限制在本机，表单、框架及外部脚本都不可用。 */
function headers(response, type) {
  response.setHeader('Content-Type', type);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
}
/** 合成 API 只序列化公开字段，固定错误不包含请求正文或第三方响应。 */
function json(response, status, value) { headers(response, 'application/json; charset=utf-8'); response.statusCode = status; response.end(JSON.stringify(value)); }
/** 小体积 JSON 仅用于创建合成账号；超过限额或无效 JSON 不进入模拟状态。 */
async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new PreviewError(413, '预览请求过大。'); chunks.push(chunk); }
  try { const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); return input; }
  catch { throw new PreviewError(400, '请选择有效的预览操作。'); }
}
/** 请求完全在内存中处理，不转发任意上游；唯一写入能力是固定示例设备的未连接账号。 */
async function handle(request, response) {
  try {
    guardPreview(request, port);
    const url = new URL(request.url, origin);
    if (url.origin !== origin) return json(response, 400, { error: '无效本地预览地址。' });
    if (request.method === 'GET') {
      if (url.pathname === '/api/session') return json(response, 200, { user: { username: 'Liang', role: 'customer' } });
      if (url.pathname === '/api/instances') return json(response, 200, { instances, agents: [{ id: 'preview_liang', name: '演示电脑', owner: 'Liang', online: true, maintenance: false, revoked: false, paired: true, instances }] });
      if (url.pathname === '/api/publishing') return json(response, 200, publishing.view);
      if (['/', '/publishing'].includes(url.pathname)) { headers(response, 'text/html; charset=utf-8'); response.end(html); return; }
      if (url.pathname === '/preview.js') { headers(response, 'text/javascript; charset=utf-8'); response.end(javascript); return; }
      if (url.pathname === '/preview.css') { headers(response, 'text/css; charset=utf-8'); response.end(css + previewStyles); return; }
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    }
    if (request.method === 'POST' && url.pathname === '/api/publishing') {
      const input = await readBody(request);
      if (!['packages', 'account-create'].includes(input.action)) return json(response, 409, { error: blockedMessage });
      try { return json(response, 200, publishing.request(input)); }
      catch { return json(response, 400, { error: '请选择示例电脑，并填写 1–80 个字符的账号名称。' }); }
    }
    return json(response, url.pathname.startsWith('/api/') ? 409 : 404, { error: blockedMessage });
  } catch (error) { return json(response, error instanceof PreviewError ? error.status : 400, { error: error instanceof PreviewError ? error.message : '预览请求无法处理。' }); }
}

const server = createServer((request, response) => { void handle(request, response); });
/** 只停止此预览监听；无 Agent、桌面程序、后台 Next 服务或生产文件需要清理。 */
function stop() { server.close(); server.closeIdleConnections(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`Local publishing accounts preview ready: ${origin}/publishing`);
} catch { console.error('无法启动本地账号预览，请检查所选端口是否已被使用。'); stop(); process.exitCode = 1; }
