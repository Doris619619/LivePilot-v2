/** 仅由本地预览 HTTP 服务注入；模拟桌面桥，不读取或操作本机 OBS、磁盘、凭据。 */
(() => {
  const scenario = new URLSearchParams(location.search).get('scene') || 'second';
  let authenticated = scenario !== 'login';
  const instance = id => ({ id, name: id === 'main' ? '第一路 · 视频直播' : '第二路 · 音乐直播', managed: true, initialized: true, exe: `D:\\LiveNest\\obs\\${id}\\bin\\64bit\\obs64.exe`, port: id === 'main' ? 4455 : 4456 });
  const state = { version: '0.1.2', dataRoot: 'D:\\LiveNest', paired: scenario !== 'first', agentRunning: scenario !== 'first', online: scenario !== 'first', autoStart: false, busy: false, instances: scenario === 'first' ? [] : [instance('main')], candidates: [], checks: [], snapshots: [], update: { status: 'idle', message: '本地预览，发布等待确认' } };
  /** 演示正常状态及截图中的未启动问题，可通过真实页面按钮切换。 */
  function refresh() {
    state.checks = ['Windows x64', '数据目录', '磁盘空间', '内置 Node 与 Agent', 'Agent 程序', '内置 OBS', '网页服务'].map((label, n) => ({ id: n === 6 ? 'cloud' : 'base_' + n, label, status: 'ready' }));
    for (const i of state.instances) state.checks.push({ id: i.id + '_network', label: i.name + ' · 连接检查', status: state.diagnostic ? 'pending' : 'ready', instanceId: i.id, code: state.diagnostic ? 'OBS_NOT_RUNNING' : 'READY', checkedAt: Date.now(), message: state.diagnostic ? '此 OBS 尚未启动。点击“启动并检查”，无需自己查找防火墙设置。' : 'WebSocket 连接正常，监听仅限本机。', action: state.diagnostic ? 'launch' : undefined });
    state.snapshots = state.instances.map(i => ({ instance: { id: i.id, name: i.name }, observedAt: Date.now(), dashboard: { busy: false, state: { phase: 'idle', stage: '等待开始', updatedAt: new Date().toISOString() }, obs: { ready: !state.diagnostic, running: !state.diagnostic, streaming: false }, youtube: { connected: i.id === 'main', channel: i.id === 'main' ? '演示 · Ocean Studio' : undefined }, media: { videos: i.id === 'main' ? ['海边日落.mp4'] : [], music: i.id === 'main' ? ['夜晚钢琴.mp3'] : [] }, configuration: { missing: [], privacy: 'unlisted', madeForKids: false } } }));
    return structuredClone(state);
  }
  state.diagnostic = scenario === 'diagnostic';
  /** 配置交互只在当前标签内模拟，刷新可恢复，不访问生产服务。 */
  window.liveNest = {
    session: async () => ({ authenticated, username: authenticated ? 'Liang' : undefined }),
    login: async username => { if (['Do', 'ULiang', 'UDo'].includes(username)) return { ok: false, message: '管理员请使用管理员网页端。' }; authenticated = true; return { ok: true }; },
    logout: async () => { authenticated = false; },
    state: async () => refresh(),
    act: async (action, input = {}) => {
      state.message = ''; state.activity = undefined;
      if (action === 'web') { window.open('http://127.0.0.1:3021/workspace', '_blank'); return refresh(); }
      if (action === 'scan') state.scan = { running: false, canceled: false, deep: !!input.deep, drives: ['C:\\', 'D:\\', 'E:\\'], completedDrives: ['C:\\', 'D:\\', 'E:\\'], visited: 248, inaccessible: ['E:\\受保护目录（无权访问，演示）'], results: [{ exe: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', version: '32.2.2', running: false, attached: false }, { exe: 'D:\\直播工具\\OBS\\bin\\64bit\\obs64.exe', version: '32.2.2', running: false, attached: false }, { exe: 'E:\\便携OBS\\bin\\64bit\\obs64.exe', version: '27.2.4', running: false, attached: false, error: '版本较旧，请使用 OBS 28 或以上版本。' }] };
      if (action === 'scan-cancel' && state.scan) state.scan.canceled = true;
      if (['prepare', 'add', 'import-obs'].includes(action) && (action !== 'prepare' || !state.instances.length)) { const id = state.instances.length ? 'obs_' + (state.instances.length + 1) : 'main'; state.instances.push({ ...instance(id), ...(input.name ? { name: input.name } : {}) }); state.message = id === 'main' ? '演示：OBS 已准备，可以继续配对。' : '演示：第二路已准备。电脑无需重新配对，只需连接新频道并选择素材。'; }
      if (['diagnose-obs', 'repair-managed', 'check', 'prepare'].includes(action)) state.diagnostic = false;
      if (['pair', 'start'].includes(action)) { state.paired = state.agentRunning = state.online = true; }
      if (action === 'rename') { const i = state.instances.find(i => i.id === input.id); if (i) i.name = input.name; }
      if (action === 'directory') { state.dataRoot = state.dataRoot === 'D:\\LiveNest' ? 'E:\\我的直播数据' : 'D:\\LiveNest'; state.dataNotice = '演示：已选择新目录；预览没有移动本机文件。'; }
      if (action === 'autostart') state.autoStart = !!input.enabled;
      if (['open-data', 'firewall'].includes(action)) state.message = '这是浏览器预览；安装版会打开对应的 Windows 窗口。';
      if (action.startsWith('update-')) state.message = '发布已暂停，等待界面确认。';
      return refresh();
    },
  };
})();
