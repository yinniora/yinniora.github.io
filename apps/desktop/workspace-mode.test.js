const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setImmediate: nextTick } = require('node:timers/promises');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const localOrigin = 'http://127.0.0.1:31415';
const viewerOrigin = 'https://yinniora.github.io';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yugopi-desktop-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostProfile = path.join(root, 'YuGo Pi Host');
  const modeFile = path.join(hostProfile, 'workspace-mode');
  const binary = path.join(root, 'pi-web');
  fs.writeFileSync(binary, '');
  fs.mkdirSync(hostProfile);
  const windows = [];
  const child = new EventEmitter();
  const localCookies = [];
  const makeSession = () => ({
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
  });
  const localSession = { ...makeSession(), cookies: { set: async (cookie) => localCookies.push(cookie) } };
  const remoteSession = makeSession();
  let starts = 0;
  let killed = 0;
  let prompts = 0;
  let answer = 2;
  child.kill = () => killed++;

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.session = options.webPreferences.session;
      this.webContents = new EventEmitter();
      this.webContents.ipc = new EventEmitter();
      this.webContents.ipc.handle = (name, handler) => {
        if (name === 'yugo:workspace:choose') this.choose = handler;
      };
      this.webContents.mainFrame = {};
      this.webContents.getUserAgent = () => 'Test';
      this.webContents.setUserAgent = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getURL = () => this.url;
      windows.push(this);
    }
    async loadURL(url) {
      this.url = url;
      this.webContents.mainFrame.url = url;
    }
    async loadFile(file) { await this.loadURL(pathToFileURL(file).href); }
    getBounds() { return {}; }
    destroy() { this.destroyed = true; }
    isDestroyed() { return !!this.destroyed; }
    get message() { return { senderFrame: this.webContents.mainFrame }; }
    settings() { this.webContents.ipc.emit('yugo:workspace:settings', this.message); }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    getPath: (key) => key === 'userData' ? hostProfile : root,
    getLocale: () => 'en-US',
    requestSingleInstanceLock: () => true,
    setName() {},
    setPath: (_key, value) => assert.equal(value, hostProfile),
    whenReady: async () => {},
  });
  const deps = {
    electron: {
      app, BrowserWindow,
      Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
      Menu: { setApplicationMenu() {}, buildFromTemplate() {} },
      dialog: { async showMessageBox() { prompts++; return { response: answer }; } },
      session: {
        defaultSession: localSession,
        fromPath(profile) {
          assert.equal(profile, path.join(root, 'YuGo Pi Client'));
          return remoteSession;
        },
      },
    },
    './host': {
      BINARY: binary, HOST_ORIGIN: localOrigin,
      async prepareShell() {},
      async startHost() {
        starts++;
        return { child, token: 'test-host-token' };
      },
    },
    './client-update': {},
    './lan-signal': { TRUSTED_VIEWER: viewerOrigin, connectViewerLAN() {} },
  };
  return {
    async launch() {
      vm.runInNewContext(source, {
        require: (name) => deps[name] ?? require(name),
        __dirname, URL,
        process: { platform: 'linux', env: {}, argv: [] },
      });
      await nextTick();
    },
    answerWith(response) { answer = response; },
    get view() { return windows.at(-1); },
    get launches() { return starts; },
    get killed() { return killed; },
    get prompts() { return prompts; },
    localSession, remoteSession, modeFile, localCookies, hostProfile,
  };
}

test('a first-time remote choice starts no host and switching keeps the local host and both profiles', async (t) => {
  const app = fixture(t);
  await app.launch();
  const picker = app.view;
  assert.match(picker.url, /workspace-mode\.html$/);
  assert.throws(() => picker.choose({ senderFrame: { url: picker.url } }, 'local'), /Invalid/);
  assert.throws(() => picker.choose(picker.message, 'invalid'), /Invalid/);
  picker.choose(picker.message, 'remote');
  assert.equal(app.view.url, viewerOrigin + '/');
  assert.equal(app.view.session, app.remoteSession);
  assert.equal(fs.readFileSync(app.modeFile, 'utf8').trim(), 'remote');
  assert.equal(app.launches, 0);
  assert.throws(() => app.view.choose(app.view.message, 'local'), /Invalid/);
  picker.settings();
  assert.equal(app.prompts, 0);

  app.answerWith(0);
  app.view.settings();
  await nextTick();
  assert.equal(app.view.url, localOrigin);
  assert.equal(app.view.session, app.localSession);
  assert.equal(app.localCookies[0].sameSite, 'strict');
  assert.equal(app.launches, 1);

  app.answerWith(1);
  app.view.settings();
  await nextTick();
  assert.equal(app.view.session, app.remoteSession);
  assert.equal(app.killed, 0);
  assert.equal(fs.readFileSync(app.modeFile, 'utf8').trim(), 'remote');

  app.answerWith(0);
  app.view.settings();
  await nextTick();
  assert.equal(app.view.url, localOrigin);
  assert.equal(app.launches, 1);
});

test('an upgraded host opens locally, while a saved remote choice takes precedence', async (t) => {
  const existingHost = fixture(t);
  fs.writeFileSync(path.join(existingHost.hostProfile, 'host-token.encrypted'), '');
  await existingHost.launch();
  assert.equal(existingHost.view.url, localOrigin);

  const existingRemote = fixture(t);
  fs.writeFileSync(path.join(existingRemote.hostProfile, 'host-token.encrypted'), '');
  fs.writeFileSync(existingRemote.modeFile, 'remote\n');
  await existingRemote.launch();
  assert.equal(existingRemote.view.url, viewerOrigin + '/');
  assert.equal(existingRemote.launches, 0);
});
