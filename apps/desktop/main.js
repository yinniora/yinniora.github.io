// YuGo Pi desktop client: a window around the published encrypted remote
// client. It never stores host credentials itself; pairing keys live in the
// web client's storage inside this app's profile, exactly as in a browser.
const { app, BrowserWindow, Menu, Tray, clipboard, dialog, safeStorage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const host = require('./host');
const { checkClientUpdate, downloadClientUpdate, RELEASES } = require('./client-update');

const HOST_APP = fs.existsSync(host.BINARY);
const CLIENT_URL = HOST_APP ? host.HOST_ORIGIN : process.env.YUGO_PI_CLIENT_URL || 'https://yinniora.github.io/';
const CLIENT_ORIGIN = new URL(CLIENT_URL).origin;
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
  const portable = platform === 'linux' ? !!process.env.APPIMAGE : !!process.env.PORTABLE_EXECUTABLE_FILE;
  try {
    const update = await checkClientUpdate(app.getVersion(), { platform, arch, portable });
    if (!update) {
      await message({ type: 'info', message: 'YuGo Pi 客户端已是最新版本。' });
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
      platform, arch, portable, progress,
    });
    if (portable || (await shell.openPath(file))) shell.showItemInFolder(file);
  } catch (error) {
    const { response } = await message({
      type: 'warning',
      message: '暂时无法安装客户端更新',
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
  label: HOST_APP ? '查看更新' : '检查客户端更新…',
  click: HOST_APP || !app.isPackaged ? () => openExternal(RELEASES) : updateClient,
};

function sameOrigin(url) {
  try {
    return new URL(url).origin === CLIENT_ORIGIN;
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
  if (HOST_APP) return undefined;
  return argv.find((arg) => typeof arg === 'string' && sameOrigin(arg) && arg.includes('#pair='));
}

function createWindow(initialUrl) {
  win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 380,
    minHeight: 480,
    title: 'YuGo Pi',
    backgroundColor: '#09090b',
    autoHideMenuBar: HOST_APP,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (HOST_APP) {
    win.on('close', (event) => {
      if (quitting || !tray) return;
      event.preventDefault();
      win.hide();
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) {
      win.loadURL(url);
    } else {
      openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url) && (HOST_APP || !url.startsWith('file:'))) {
      event.preventDefault();
      openExternal(url);
    }
  });
  // Right-click / long-press: link and text actions.
  win.webContents.on('context-menu', (_event, params) => {
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
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { retry: url || CLIENT_URL } });
  });

  if (HOST_APP && initialUrl === null) {
    win.loadFile(path.join(__dirname, 'starting.html'));
  } else {
    win.loadURL(initialUrl || CLIENT_URL);
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
  hostProcess = child;
  await session.defaultSession.cookies.set({
    url: host.HOST_ORIGIN,
    name: 'pi_token',
    value: token,
    httpOnly: true,
    sameSite: 'strict',
  });
  try {
    tray = new Tray(path.join(__dirname, 'build', 'icon.png'));
    tray.setToolTip('YuGo Pi Host');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 YuGo Pi', click: () => win?.show() },
      { label: '查看更新', click: () => openExternal(RELEASES) },
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
    if (link) win.loadURL(link);
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(sameOrigin(contents.getURL()) && ALLOWED_PERMISSIONS.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => {
      return (origin === CLIENT_ORIGIN || sameOrigin(contents?.getURL() || '')) && ALLOWED_PERMISSIONS.has(permission);
    });
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          { label: '帮助', submenu: [updateMenuItem] },
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
          updateMenuItem,
          { role: 'quit' },
        ] },
      ]));
    }
    createWindow(HOST_APP ? null : pairingUrl(process.argv));
    if (HOST_APP) {
      try {
        await attachHost();
        if (win && !win.isDestroyed() && !quitting) win.loadURL(CLIENT_URL);
      } catch (error) {
        dialog.showErrorBox('无法启动 YuGo Pi 主机', error.message);
        app.quit();
        return;
      }
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
