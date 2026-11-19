// YuGo Pi desktop client: a window around the published encrypted remote
// client. It never stores host credentials itself; pairing keys live in the
// web client's storage inside this app's profile, exactly as in a browser.
const { app, BrowserWindow, Menu, session, shell } = require('electron');
const path = require('node:path');

const CLIENT_URL = process.env.YUGO_PI_CLIENT_URL || 'https://yinniora.github.io/';
const CLIENT_ORIGIN = new URL(CLIENT_URL).origin;
const ALLOWED_PERMISSIONS = new Set([
  'media', // camera for scanning the pairing QR code
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'fullscreen',
]);

let win = null;

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
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) {
      win.loadURL(url);
    } else {
      openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url) && !url.startsWith('file:')) {
      event.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { retry: url || CLIENT_URL } });
  });

  win.loadURL(initialUrl || CLIENT_URL);
}

const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const link = pairingUrl(argv);
    if (link) win.loadURL(link);
  });

  app.whenReady().then(() => {
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
          {
            label: 'View',
            submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
          },
          { role: 'windowMenu' },
        ]),
      );
    } else {
      Menu.setApplicationMenu(null);
    }
    createWindow(pairingUrl(process.argv));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
