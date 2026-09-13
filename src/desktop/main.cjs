const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
if (process.env.CODEX_WORKSPACE_DATA_DIR) app.setPath('userData', path.join(process.env.CODEX_WORKSPACE_DATA_DIR, 'ui'));

let window, client;
const allowed = new Set(['snapshot','session.create','session.delete','session.switch','session.pin','session.review','session.read','session.cancelRecovery','terminal.attach','terminal.input','terminal.resize','workspace.save','accounts.discover','accounts.refresh','runtime.shutdown']);
allowed.add('terminal.snapshot');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connectRuntime() {
  const { runtimePaths } = await import('../runtime/paths.mjs');
  const { connectIpc } = await import('../runtime/ipc.mjs');
  const paths = runtimePaths();
  const event = value => { for (const view of BrowserWindow.getAllWindows()) if (!view.isDestroyed() && !view.webContents.isDestroyed()) view.webContents.send('workspace:event', value); };
  async function connect() {
    const token = (await fs.readFile(paths.token, 'utf8')).trim();
    const candidate = await connectIpc(paths.pipe, token, event);
    try {
      const snapshot = await candidate.invoke('snapshot');
      if (snapshot.runtime.protocol !== 2) throw new Error('실행 중인 백그라운드 버전과 호환되지 않습니다. 세션을 종료하고 다시 실행하세요.');
      return candidate;
    } catch (error) { candidate.close(); throw error; }
  }
  try { return await connect(); } catch (error) { if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error; }
  await fs.mkdir(paths.dataDir, { recursive: true });
  const log = await fs.open(path.join(paths.dataDir, 'runtime.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, '../runtime/boot.mjs')], {
    detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  let startupError; child.on('error', error => { startupError = error; }); child.unref(); await log.close();
  for (let i = 0; i < 80; i++) {
    if (startupError) throw startupError;
    await delay(250);
    try { return await connect(); } catch (error) { if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error; }
  }
  throw new Error('백그라운드 실행부 시작에 실패했습니다. 데이터 폴더의 runtime.log를 확인하세요.');
}

function createWindow() {
  window = new BrowserWindow({ width: 1520, height: 960, minWidth: 850, minHeight: 550, backgroundColor: '#14191f', title: 'Codex Workspace',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.loadFile(path.join(__dirname, '../../dist/index.html'));
  window.on('closed', () => { window = null; });
}
const primaryUi = app.requestSingleInstanceLock();
if (!primaryUi) app.quit();
app.on('second-instance', () => {
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing) { if (existing.isMinimized()) existing.restore(); existing.focus(); }
  else if (app.isReady()) createWindow();
});
if (primaryUi) app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '작업 공간', submenu: [{ label: '새 창', click: () => createWindow() }, { label: '데이터 폴더 열기', click: async () => { const { runtimePaths } = await import('../runtime/paths.mjs'); require('electron').shell.openPath(runtimePaths().dataDir); } }, { label: '백그라운드 실행부 종료', click: async () => { try { await (await runtime()).invoke('runtime.shutdown'); app.quit(); } catch (error) { dialog.showErrorBox('실행부 종료', error.message); } } }, { type: 'separator' }, { label: '창 닫기 · 세션 유지', role: 'close' }] },
    { label: '편집', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '보기', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ]));
  ipcMain.handle('workspace:invoke', async (event, method, params = {}) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const expected = pathToFileURL(path.join(__dirname, '../../dist/index.html')).href;
    if (!sender || event.senderFrame.url !== expected) throw new Error('허용되지 않은 화면 요청입니다.');
    if (method === 'clipboard.readText') return require('electron').clipboard.readText();
    if (method === 'clipboard.writeText') {
      if (typeof params.text !== 'string' || params.text.length > 1024 * 1024) throw new Error('복사할 텍스트가 너무 큽니다.');
      require('electron').clipboard.writeText(params.text); return true;
    }
    if (method === 'folder.pick') {
      const result = await dialog.showOpenDialog(sender, { properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    }
    if (method === 'accounts.repair') {
      const result = await dialog.showOpenDialog(sender, { title: '새로 로그인한 계정의 auth.json 선택', filters: [{ name: 'Codex 인증', extensions: ['json'] }], properties: ['openFile'] });
      if (result.canceled) return null;
      return (await runtime()).invoke('accounts.import', { path: result.filePaths[0] });
    }
    if (!allowed.has(method)) throw new Error('지원하지 않는 명령입니다.');
    return (await runtime()).invoke(method, params);
  });
  createWindow();
}).catch(error => { dialog.showErrorBox('Codex Workspace', error.message); app.quit(); });
let connection;
async function runtime() {
  if (client) return client;
  if (!connection) connection = connectRuntime().then(value => { client = value; return value; }).finally(() => { connection = null; });
  return connection;
}
// All live work and acknowledged state belong to the detached runtime. Once no
// windows remain, do not keep this UI alive waiting for background child handles.
app.on('window-all-closed', () => { client?.close(); app.exit(0); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
