const { app, BrowserWindow, Menu, Tray, clipboard, dialog, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const host = require('./host');
const { checkClientUpdate, downloadClientUpdate, RELEASES } = require('./client-update');
const { TRUSTED_VIEWER, connectViewerLAN } = require('./lan-signal');

const HOST_APP = fs.existsSync(host.BINARY);
const CLIENT_URL = HOST_APP ? `${TRUSTED_VIEWER}/` : process.env.YUGO_PI_CLIENT_URL || `${TRUSTED_VIEWER}/`;
const CLIENT_ORIGIN = new URL(CLIENT_URL).origin;
const PICKER = path.join(__dirname, 'workspace-mode.html');
const PICKER_URL = pathToFileURL(PICKER).href;
const APP_DATA = app.getPath('appData');
if (HOST_APP) {
  // Preserve the host profile and its existing safeStorage identity.
  app.setName('YuGo Pi Host');
  app.setPath('userData', path.join(APP_DATA, 'YuGo Pi Host'));
}
const ALLOWED_PERMISSIONS = new Set([
  'media', // camera for scanning the pairing QR code
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'fullscreen',
]);

let win = null;
let tray = null;
let quitting = false;
let hostProcess = null;
let updatingClient = false;
let workspaceMode = null;
let choosingMode = false;
let hostReady = null;
let viewerSession;

function modeFile() {
  return path.join(app.getPath('userData'), 'workspace-mode');
}

function savedMode() {
  try {
    const mode = fs.readFileSync(modeFile(), 'utf8').trim();
    return ['local', 'remote'].includes(mode) ? mode : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const profile = app.getPath('userData');
    return ['host-token.encrypted', 'host-token'].some((name) => fs.existsSync(path.join(profile, name)))
      ? 'local' : null;
  }
}

function switchMode(mode) {
  if (workspaceMode === mode) return;
  const file = modeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID();
  fs.writeFileSync(temporary, mode + '\n', { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  const old = win;
  createWindow(mode, undefined, old?.getBounds());
  workspaceMode = mode;
  if (old && !old.isDestroyed()) old.destroy();
}

async function showModeSettings() {
  if (!HOST_APP || choosingMode || !win || win.isDestroyed()) return;
  choosingMode = true;
  const chinese = app.getLocale().toLowerCase().startsWith('zh');
  const buttons = chinese
    ? ['在这台电脑运行 Pi', '连接另一台电脑', '取消']
    : ['Run Pi on this computer', 'Connect to another computer', 'Cancel'];
  try {
    const current = workspaceMode === 'local' ? 0 : workspaceMode === 'remote' ? 1 : 2;
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'YuGo Pi',
      message: chinese ? '桌面模式' : 'Desktop mode',
      detail: current === 2 ? '' : (chinese ? '当前使用：' : 'Current mode: ') + buttons[current],
      buttons,
      defaultId: current,
      cancelId: 2,
      noLink: true,
    });
    if (response < 2 && !quitting) switchMode(response === 0 ? 'local' : 'remote');
  } catch (error) {
    dialog.showErrorBox('YuGo Pi', error.message);
  } finally {
    choosingMode = false;
  }
}

async function updateClient() {
  if (updatingClient || !app.isPackaged) return;
  updatingClient = true;
  const parent = win;
  const message = (options) => parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  const progress = (value) => {
    if (parent && !parent.isDestroyed()) parent.setProgressBar(value);
  };
  const { platform, arch } = process;
  const portable = !HOST_APP && (platform === 'linux' ? !!process.env.APPIMAGE : !!process.env.PORTABLE_EXECUTABLE_FILE);
  try {
    const update = await checkClientUpdate(app.getVersion(), { platform, arch, portable, unified: HOST_APP });
    if (!update) {
      await message({ type: 'info', message: 'YuGo Pi 已是最新版本。' });
      return;
    }
    const { response } = await message({
      type: 'info',
      message: `YuGo Pi ${update.version} 可用`,
      detail: `${(update.size / 1024 ** 2).toFixed(1)} MB`,
      buttons: ['下载更新', '稍后'],
      cancelId: 1,
    });
    if (response !== 0) return;
    progress(0);
    const file = await downloadClientUpdate(update, app.getPath('userData'), {
      platform, arch, portable, unified: HOST_APP, progress,
    });
    if (portable || (await shell.openPath(file))) shell.showItemInFolder(file);
  } catch (error) {
    const { response } = await message({
      type: 'warning',
      message: '暂时无法安装 YuGo Pi 更新',
      detail: error.message,
      buttons: ['关闭', '查看发布页'],
      cancelId: 0,
    });
    if (response === 1) openExternal(RELEASES);
  } finally {
    progress(-1);
    updatingClient = false;
  }
}

const updateMenuItem = {
  label: '检查更新…',
  click: () => {
    if (!app.isPackaged || workspaceMode === 'local' || hostReady) openExternal(RELEASES);
    else void updateClient();
  },
};

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') shell.openExternal(url);
  } catch {
    // ignore malformed URLs
  }
}

// A pairing link (…/#pair=…) passed on the command line or via the OS opens in the app.
function pairingUrl(argv) {
  return argv.find((arg) => typeof arg === 'string' && sameOrigin(arg, CLIENT_ORIGIN) && arg.includes('#pair='));
}

function allowPermissions(targetSession, origin) {
  const trusted = (url) => sameOrigin(url, origin);
  targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && details.isMainFrame &&
      trusted(contents.getURL()) && trusted(details.requestingUrl) &&
      (!details.securityOrigin || trusted(details.securityOrigin)));
  });
  targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!ALLOWED_PERMISSIONS.has(permission) || !trusted(requestingOrigin)) return false;
    if (!contents) return permission === 'notifications' && !details.requestingUrl;
    return details.isMainFrame && trusted(contents.getURL()) &&
      (!details.requestingUrl || trusted(details.requestingUrl)) &&
      (!details.securityOrigin || trusted(details.securityOrigin));
  });
}

function getViewerSession() {
  if (!viewerSession) {
    // The former desktop client stored non-exportable pairing keys here.
    if (HOST_APP) {
      const profile = path.join(APP_DATA, 'YuGo Pi Client');
      fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
      viewerSession = session.fromPath(profile);
    } else {
      viewerSession = session.defaultSession;
    }
    allowPermissions(viewerSession, CLIENT_ORIGIN);
  }
  return viewerSession;
}

function createWindow(mode, initialUrl, bounds) {
  const remote = mode === 'remote';
  const local = mode === 'local';
  const origin = remote ? CLIENT_ORIGIN : local ? host.HOST_ORIGIN : null;
  const target = remote ? CLIENT_URL : host.HOST_ORIGIN;
  const nativeLAN = remote && CLIENT_ORIGIN === TRUSTED_VIEWER;
  const desktop = new BrowserWindow({
    width: 1220,
    height: 820,
    ...bounds,
    minWidth: 380,
    minHeight: 480,
    title: 'YuGo Pi',
    backgroundColor: '#09090b',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      session: remote ? getViewerSession() : session.defaultSession,
      ...(nativeLAN || HOST_APP ? { preload: path.join(__dirname, 'lan-preload.js') } : {}),
      additionalArguments: HOST_APP ? ['--yugo-desktop-modes'] : [],
      spellcheck: false,
    },
  });
  win = desktop;
  const contents = desktop.webContents;
  const trusted = (url) => origin !== null && sameOrigin(url, origin);
  const fromCurrentDocument = (event) => win === desktop && event.senderFrame &&
    event.senderFrame === contents.mainFrame;

  if (remote) contents.setUserAgent(`${contents.getUserAgent()} YuGoPi-Desktop`);
  if (nativeLAN) connectViewerLAN(contents);
  if (HOST_APP) {
    contents.ipc.on('yugo:workspace:settings', (event) => {
      if (fromCurrentDocument(event) && trusted(event.senderFrame.url) &&
          (local || nativeLAN)) void showModeSettings();
    });
    contents.ipc.handle('yugo:workspace:choose', (event, next) => {
      if (mode !== null || !fromCurrentDocument(event) || event.senderFrame.url !== PICKER_URL ||
          !['local', 'remote'].includes(next)) throw new Error('Invalid desktop mode selection');
      switchMode(next);
    });
    desktop.on('close', (event) => {
      if (quitting || !tray) return;
      event.preventDefault();
      desktop.hide();
    });
  }

  contents.setWindowOpenHandler(({ url }) => {
    if (trusted(url)) desktop.loadURL(url).catch(() => {});
    else openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!trusted(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame && !trusted(event.url)) event.preventDefault();
  });
  // Right-click / long-press: link and text actions.
  contents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.linkURL && /^(https?|mailto):/i.test(params.linkURL)) {
      items.push(
        { label: '在浏览器中打开链接', click: () => openExternal(params.linkURL) },
        { label: '复制链接', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) items.push({ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' });
    else if (params.selectionText) items.push({ role: 'copy', label: '复制' });
    while (items.at(-1)?.type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: desktop });
  });
  contents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */ || !trusted(url) || desktop.isDestroyed()) return;
    desktop.loadFile(path.join(__dirname, 'offline.html'), { query: { retry: target } }).catch(() => {});
  });

  if (local) {
    desktop.loadFile(path.join(__dirname, 'starting.html')).catch(() => {});
    void startLocalView(desktop);
  } else if (remote) {
    desktop.loadURL(initialUrl || CLIENT_URL).catch(() => {});
  } else {
    desktop.loadFile(PICKER).catch(() => {});
  }
}

async function startLocalView(desktop) {
  try {
    hostReady ??= attachHost().catch((error) => {
      hostReady = null;
      throw error;
    });
    await hostReady;
    if (win === desktop && !desktop.isDestroyed() && !quitting) {
      await desktop.loadURL(host.HOST_ORIGIN).catch(() => {});
    }
  } catch (error) {
    if (win !== desktop || desktop.isDestroyed() || quitting) return;
    const { response } = await dialog.showMessageBox(desktop, {
      type: 'error',
      message: '无法启动本机 Pi',
      detail: error.message,
      buttons: ['重试', '桌面模式…', '关闭'],
      cancelId: 2,
    });
    if (response === 0 && win === desktop && !desktop.isDestroyed()) void startLocalView(desktop);
    if (response === 1 && win === desktop && !desktop.isDestroyed()) void showModeSettings();
  }
}

async function attachHost() {
  const home = app.getPath('home');
  await host.prepareShell({ dialog, home });
  const { token, child } = await host.startHost({
    home,
    profile: app.getPath('userData'),
    safeStorage,
  });
  if (quitting) {
    child?.kill();
    return;
  }
  hostProcess = child;
  child?.once('exit', () => {
    if (hostProcess === child) {
      hostProcess = null;
      hostReady = null;
    }
  });
  await session.defaultSession.cookies.set({
    url: host.HOST_ORIGIN,
    name: 'pi_token',
    value: token,
    httpOnly: true,
    sameSite: 'strict',
  });
  try {
    tray = new Tray(path.join(__dirname, 'build', 'icon.png'));
    tray.setToolTip('YuGo Pi');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 YuGo Pi', click: () => win?.show() },
      { label: '桌面模式…', click: () => { win?.show(); void showModeSettings(); } },
      updateMenuItem,
      { label: '退出', role: 'quit' },
    ]));
    tray.on('click', () => win?.show());
  } catch {
    // Linux desktops without a status tray keep the normal window lifecycle.
  }
}

const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    const link = pairingUrl(argv);
    if (link && workspaceMode === 'remote') win.loadURL(link).catch(() => {});
  });

  app.whenReady().then(async () => {
    if (HOST_APP) allowPermissions(session.defaultSession, host.HOST_ORIGIN);
    const settings = HOST_APP ? [{
      label: app.getLocale().toLowerCase().startsWith('zh') ? '桌面模式…' : 'Desktop mode…',
      accelerator: 'CmdOrCtrl+,',
      click: showModeSettings,
    }] : [];
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          { label: '帮助', submenu: [...settings, updateMenuItem] },
          {
            label: 'View',
            submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
          },
          { role: 'windowMenu' },
        ]),
      );
    } else {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'YuGo Pi', submenu: [
          ...settings,
          updateMenuItem,
          { role: 'quit' },
        ] },
      ]));
    }
    try {
      workspaceMode = HOST_APP ? savedMode() : 'remote';
      createWindow(workspaceMode, workspaceMode === 'remote' ? pairingUrl(process.argv) : undefined);
    } catch (error) {
      dialog.showErrorBox('YuGo Pi', error.message);
      app.quit();
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(workspaceMode);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    hostProcess?.kill();
  });
}
