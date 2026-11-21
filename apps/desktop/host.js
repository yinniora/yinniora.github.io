const { execFileSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const HOST_ORIGIN = 'http://127.0.0.1:31415';
const RUNTIME = path.join(process.resourcesPath || __dirname, 'host');
const EXT = process.platform === 'win32' ? '.exe' : '';
const BINARY = path.join(RUNTIME, 'pi-web' + EXT);

function backendVersion(file) {
  const version = execFileSync(file, ['-version'], { encoding: 'utf8', timeout: 2500, windowsHide: true }).trim();
  const parts = /^(\d+)\.(\d+)\.(\d+)-yugo\.(\d+)$/.exec(version);
  if (!parts) throw new Error('The local backend version is invalid.');
  return parts.slice(1).map(Number);
}

function backendPath(profile) {
  if (process.platform !== 'linux') return BINARY;
  const directory = path.join(profile, 'runtime');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'pi-web');
  if (fs.existsSync(target)) {
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022)) {
      throw new Error('The local backend is not in a private location.');
    }
    const current = backendVersion(target);
    const bundled = backendVersion(BINARY);
    const difference = current.findIndex((value, index) => value !== bundled[index]);
    if (difference < 0 || current[difference] > bundled[difference]) return target;
  }
  const next = path.join(directory, '.pi-web-' + randomBytes(8).toString('hex'));
  try {
    fs.copyFileSync(BINARY, next, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(next, 0o755);
    fs.renameSync(next, target);
  } finally {
    fs.rmSync(next, { force: true });
  }
  return target;
}

function windowsBash() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);
  const candidates = roots.map((root) => path.join(root, 'Git', 'bin'));
  candidates.push(...(process.env.PATH || '').split(path.delimiter).filter(Boolean));
  return candidates.find((directory) => fs.existsSync(path.join(directory, 'bash.exe')));
}

async function prepareShell({ dialog, home }) {
  if (process.platform !== 'win32' || windowsBash()) return;
  const override = process.env.PI_CODING_AGENT_DIR || legacySetting(home, 'PI_CODING_AGENT_DIR');
  const agentDir = override && path.isAbsolute(override) ? override : path.join(home, '.pi', 'agent');
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    if (typeof saved.shellPath === 'string' && fs.existsSync(saved.shellPath)) return;
  } catch {
    // A fresh Pi installation needs the supported shell.
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'YuGo Pi 主机设置',
    message: '安装 Git Bash 以使用 Pi 的命令行工具',
    detail: 'YuGo Pi 会通过 Windows 程序包管理器安装 Git for Windows。',
    buttons: ['安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  const installed = await new Promise((resolve) => {
    const installer = spawn('winget.exe', [
      'install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--scope', 'user',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
    ], { stdio: 'ignore', windowsHide: true });
    installer.on('error', () => resolve(false));
    installer.on('exit', (code) => resolve(code === 0 && Boolean(windowsBash())));
  });
  if (!installed) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'YuGo Pi',
      message: 'Git Bash 安装未完成',
      detail: '现在可以使用 YuGo Pi 对话。命令行工具会在 Git Bash 安装后启用。',
    });
  }
}

function privateToken({ profile, safeStorage }) {
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const encrypted = safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  const encryptedFile = path.join(profile, 'host-token.encrypted');
  const tokenFile = path.join(profile, 'host-token');
  if (fs.existsSync(encryptedFile)) {
    if (!encrypted) throw new Error('Unlock the system keyring and try again.');
    return { token: safeStorage.decryptString(fs.readFileSync(encryptedFile)), previouslyCreated: true };
  }
  if (process.platform !== 'win32' && fs.existsSync(tokenFile)) {
    const info = fs.lstatSync(tokenFile);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Error('The local host credentials are not private.');
    }
    return { token: fs.readFileSync(tokenFile, 'utf8'), previouslyCreated: true };
  }
  const token = randomBytes(32).toString('hex');
  if (encrypted) {
    fs.writeFileSync(encryptedFile, safeStorage.encryptString(token), { flag: 'wx', mode: 0o600 });
  } else if (process.platform !== 'win32') {
    fs.writeFileSync(tokenFile, token, { flag: 'wx', mode: 0o600 });
  } else {
    throw new Error('Windows could not protect the local host credentials.');
  }
  return { token, previouslyCreated: false };
}

function legacySetting(home, name) {
  try {
    const env = fs.readFileSync(path.join(home, '.config', 'pi-web', 'env'), 'utf8');
    const entry = env.split(/\r?\n/).find((line) => line.startsWith(name + '='));
    return entry?.slice(name.length + 1).replace(/^(["'])(.*)\1$/, '$2');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function hostStatus(token) {
  const response = await fetch(HOST_ORIGIN + '/api/version', {
    headers: token ? { Authorization: 'Bearer ' + token, Accept: 'application/json' } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(600),
  }).catch(() => null);
  if (response?.ok) {
    const body = await response.json().catch(() => null);
    if (typeof body?.current === 'string') return 'ready';
  }
  return response ? 'taken' : 'unavailable';
}

async function startHost({ home, profile, safeStorage }) {
  const previousToken = legacySetting(home, 'PI_WEB_TOKEN');
  const { token, previouslyCreated } = previousToken
    ? { token: previousToken, previouslyCreated: true }
    : privateToken({ profile, safeStorage });
  if (!/^[\x21-\x7e]{16,512}$/.test(token)) throw new Error('The local host credentials are invalid.');
  if (await hostStatus() !== 'unavailable') {
    if (previouslyCreated && await hostStatus(token) === 'ready') return { token, child: null };
    throw new Error('Another local service is using port 31415.');
  }

  const override = process.env.PI_CODING_AGENT_DIR || legacySetting(home, 'PI_CODING_AGENT_DIR');
  const agentDir = override && path.isAbsolute(override) ? override : path.join(home, '.pi', 'agent');
  const workspace = path.join(home, 'Pi Projects');
  for (const directory of [path.join(agentDir, 'sessions'), workspace]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const nodeDir = process.platform === 'win32' ? RUNTIME : path.join(RUNTIME, 'bin');
  const shellDir = process.platform === 'win32' ? windowsBash() : '';
  const approval = path.join(RUNTIME, 'approve-device' + EXT);
  const hasApproval = fs.existsSync(approval);
  const backend = backendPath(profile);
  const log = fs.openSync(path.join(profile, 'host.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(backend, ['--host', '127.0.0.1'], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: [nodeDir, shellDir, process.env.PATH].filter(Boolean).join(path.delimiter),
        PI_CODING_AGENT_DIR: agentDir,
        PI_WEB_TOKEN: token,
        PI_WEB_PI_NODE: path.join(nodeDir, 'node' + EXT),
        PI_WEB_PI_SCRIPT: path.join(RUNTIME, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
        PI_WEB_DEVICE_AUTH: hasApproval ? '1' : '0',
        PI_WEB_PAIR_APPROVER: hasApproval ? approval : '',
        PI_WEB_DEFAULT_WORKSPACE: workspace,
        PI_WEB_PROTECTED_PATHS: [RUNTIME, path.dirname(backend)].join(path.delimiter),
      },
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(log);
  }

  let failed;
  child.on('error', (error) => { failed = error; });
  try {
    const deadline = Date.now() + 12_000;
    do {
      if (failed || child.exitCode !== null) throw failed || new Error('The local host exited.');
      if (await hostStatus(token) === 'ready') return { token, child };
      await delay(200);
    } while (Date.now() <= deadline);
    throw new Error('The local host did not become ready.');
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }
}

module.exports = { BINARY, HOST_ORIGIN, prepareShell, startHost };
