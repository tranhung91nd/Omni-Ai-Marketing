const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { fork } = require('child_process');

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const config = require('./config');

let mainWindow = null;
let serverProc = null;
let localUrl = '';
let updateFeedConfigured = false;
let serverRunningInMainProcess = false;
let pendingUpdateInfo = null;
let showingUpdateError = false;

function getFreePort(startPort) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(getFreePort(startPort + 1)));
    srv.listen(startPort, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function requestHealth(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${url}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if (await requestHealth(url)) return;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('Không khởi động được server nội bộ');
}

function getZaloAgentBin() {
  const exeName = process.platform === 'win32' ? 'zalo-agent.exe' : 'zalo-agent';
  const packagedBin = path.join(process.resourcesPath || '', 'bin', exeName);
  if (fs.existsSync(packagedBin)) return packagedBin;
  return process.env.ZALO_AGENT_BIN || exeName;
}

function getServerPaths() {
  const appRoot = path.join(__dirname, '..');
  if (!app.isPackaged) {
    return {
      serverPath: path.join(appRoot, 'server.js'),
      cwd: appRoot,
    };
  }

  return {
    serverPath: path.join(process.resourcesPath, 'app.asar', 'server.js'),
    cwd: process.resourcesPath,
  };
}

function startServerInMainProcess(serverPath, env) {
  if (serverRunningInMainProcess) return;
  serverRunningInMainProcess = true;
  Object.assign(process.env, env);
  require(serverPath);
}

async function startServer() {
  const port = await getFreePort(Number(process.env.PORT || 3333));
  const qrPort = await getFreePort(Number(process.env.QR_PORT || 18927));
  const userData = app.getPath('userData');
  const uploadsDir = path.join(userData, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const env = {
    ...process.env,
    DESKTOP_MODE: '1',
    ELECTRON_RUN_AS_NODE: '1',
    HOST: '127.0.0.1',
    PORT: String(port),
    QR_PORT: String(qrPort),
    LICENSE_ENFORCE: '1',
    LICENSE_APP_ID: process.env.LICENSE_APP_ID || config.appId || 'hc-zalo-agent',
    LICENSE_APP_VERSION: app.getVersion(),
    LICENSE_SERVER_URL: process.env.LICENSE_SERVER_URL || config.licenseServerUrl || '',
    UPDATE_CHECK_URL: process.env.UPDATE_CHECK_URL || config.updateCheckUrl || '',
    UPDATE_FEED_URL: process.env.UPDATE_FEED_URL || config.updateFeedUrl || '',
    ZALO_DATA_DIR: userData,
    ZALO_UPLOADS_DIR: uploadsDir,
    ZALO_AGENT_BIN: getZaloAgentBin(),
  };

  localUrl = `http://127.0.0.1:${port}`;
  const { serverPath, cwd } = getServerPaths();
  serverProc = fork(serverPath, [], {
    cwd,
    env,
    execPath: app.getPath('exe'),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  serverProc.stdout?.on('data', d => console.log(`[server] ${String(d).trim()}`));
  serverProc.stderr?.on('data', d => console.error(`[server] ${String(d).trim()}`));
  serverProc.on('error', (e) => {
    if (!app.isQuitting) {
      console.warn('[server] child process failed; falling back to in-process server:', e.message);
      serverProc = null;
      startServerInMainProcess(serverPath, env);
    }
  });
  serverProc.on('exit', (code) => {
    if (!app.isQuitting && !serverRunningInMainProcess) {
      dialog.showErrorBox('Server đã dừng', `Server nội bộ thoát với mã ${code ?? 'unknown'}.`);
      app.quit();
    }
  });

  localUrl = `http://127.0.0.1:${port}`;
  await waitForServer(localUrl);
  return localUrl;
}

function createMenu() {
  const template = [
    {
      label: 'Ứng dụng',
      submenu: [
        { label: 'Kiểm tra cập nhật', click: () => checkForUpdates(true) },
        { label: 'Mở thư mục dữ liệu', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { role: 'reload', label: 'Tải lại' },
        { role: 'quit', label: 'Thoát' },
      ],
    },
    {
      label: 'Sửa',
      submenu: [
        { role: 'undo', label: 'Hoàn tác' },
        { role: 'redo', label: 'Làm lại' },
        { type: 'separator' },
        { role: 'cut', label: 'Cắt' },
        { role: 'copy', label: 'Sao chép' },
        { role: 'paste', label: 'Dán' },
        { role: 'pasteAndMatchStyle', label: 'Dán không định dạng' },
        { role: 'delete', label: 'Xóa' },
        { type: 'separator' },
        { role: 'selectAll', label: 'Chọn tất cả' },
      ],
    },
    {
      label: 'Cửa sổ',
      submenu: [
        { role: 'minimize', label: 'Thu nhỏ' },
        { role: 'togglefullscreen', label: 'Toàn màn hình' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function attachEditableContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const flags = params.editFlags || {};
    Menu.buildFromTemplate([
      { role: 'undo', label: 'Hoàn tác', enabled: Boolean(flags.canUndo) },
      { role: 'redo', label: 'Làm lại', enabled: Boolean(flags.canRedo) },
      { type: 'separator' },
      { role: 'cut', label: 'Cắt', enabled: Boolean(flags.canCut) },
      { role: 'copy', label: 'Sao chép', enabled: Boolean(flags.canCopy) },
      { role: 'paste', label: 'Dán', enabled: Boolean(flags.canPaste) },
      { type: 'separator' },
      { role: 'selectAll', label: 'Chọn tất cả', enabled: Boolean(flags.canSelectAll) },
    ]).popup({ window: win });
  });
}

function updateFeedUrl() {
  return process.env.UPDATE_FEED_URL || config.updateFeedUrl || '';
}

function updateDownloadUrl(info, preferredExt = '') {
  const feedUrl = updateFeedUrl();
  const baseUrl = feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`;
  const files = Array.isArray(info?.files) ? info.files : [];
  const preferredFile = preferredExt ? files.find(f => String(f.url || '').toLowerCase().endsWith(preferredExt)) : null;
  const filePath = preferredFile?.url || files.find(f => f.url)?.url || info?.path || '';
  if (!filePath) return baseUrl || '';
  try {
    return new URL(filePath, baseUrl).toString();
  } catch {
    return filePath;
  }
}

async function openUpdateDownload(info, preferredExt = '') {
  const url = updateDownloadUrl(info, preferredExt);
  if (!url) {
    dialog.showErrorBox('Lỗi cập nhật', 'Không tìm thấy link tải bản cập nhật.');
    return;
  }
  await shell.openExternal(url);
}

async function downloadUpdateWithFallback(info) {
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Mở link tải', 'Đóng'],
      defaultId: 0,
      cancelId: 1,
      title: 'Không tải tự động được',
      message: `Không tải tự động được bản cập nhật: ${e.message}`,
    });
    if (result.response === 0) await openUpdateDownload(info, process.platform === 'darwin' ? '.dmg' : '');
  }
}

function setupUpdater() {
  const feedUrl = updateFeedUrl();
  updateFeedConfigured = Boolean(feedUrl);
  if (updateFeedConfigured) autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', async (info) => {
    pendingUpdateInfo = info;
    const isMac = process.platform === 'darwin';
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: isMac ? ['Tải DMG trực tiếp', 'Thử tải tự động', 'Để sau'] : ['Tải bản mới', 'Để sau'],
      defaultId: 0,
      cancelId: isMac ? 2 : 1,
      title: 'Có bản cập nhật',
      message: `Có phiên bản ${info.version}. Bạn muốn tải ngay không?`,
    });
    if (isMac && result.response === 0) await openUpdateDownload(info, '.dmg');
    else if (result.response === 0 || (isMac && result.response === 1)) await downloadUpdateWithFallback(info);
  });
  autoUpdater.on('update-downloaded', async () => {
    pendingUpdateInfo = null;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Cài và mở lại', 'Để sau'],
      defaultId: 0,
      cancelId: 1,
      title: 'Đã tải cập nhật',
      message: 'Bản cập nhật đã sẵn sàng.',
    });
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', async (e) => {
    console.warn('[updater]', e.message);
    if (!pendingUpdateInfo || showingUpdateError) return;
    showingUpdateError = true;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Mở link tải', 'Đóng'],
      defaultId: 0,
      cancelId: 1,
      title: 'Không tải tự động được',
      message: `Không tải tự động được bản cập nhật: ${e.message}`,
    });
    showingUpdateError = false;
    if (result.response === 0) await openUpdateDownload(pendingUpdateInfo, process.platform === 'darwin' ? '.dmg' : '');
  });
}

async function checkForUpdates(showNoUpdate = false) {
  if (!app.isPackaged) {
    if (showNoUpdate) dialog.showMessageBox(mainWindow, { message: 'Chế độ dev không kiểm tra auto update.' });
    return;
  }
  if (!updateFeedConfigured) {
    if (showNoUpdate) dialog.showMessageBox(mainWindow, { message: 'Chưa cấu hình updateFeedUrl trong desktop/config.js.' });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (showNoUpdate && !result?.updateInfo?.version) {
      dialog.showMessageBox(mainWindow, { message: 'Chưa có bản cập nhật mới.' });
    }
  } catch (e) {
    if (showNoUpdate) dialog.showErrorBox('Lỗi cập nhật', e.message);
  }
}

function openMainWindow(url) {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: 'HC Zalo Agent',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`${url}/chat.html`);
  attachEditableContextMenu(mainWindow);
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function createWindow() {
  const url = localUrl || await startServer();
  openMainWindow(url);
}

app.whenReady().then(async () => {
  setupUpdater();
  createMenu();
  try {
    await createWindow();
    checkForUpdates(false);
  } catch (e) {
    dialog.showErrorBox('Không mở được ứng dụng', e.message);
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProc && !serverProc.killed) serverProc.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
