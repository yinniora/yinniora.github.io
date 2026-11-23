const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream, promises: fs } = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const API = 'https://api.github.com/repositories/1461162242/releases?per_page=10';
const RELEASES = 'https://github.com/yinniora/yugo-pi/releases';
const VERSION = /^(\d{1,7})\.(\d{1,7})\.(\d{1,7})-yugo\.(\d{1,7})$/;
const MAX_ASSET_SIZE = 1024 ** 3;
const DOWNLOAD_HOSTS = new Set([
  'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com',
]);

function versionParts(version) {
  return VERSION.exec(version)?.slice(1).map(Number);
}

function compareVersions(left, right) {
  return left.map((part, index) => part - right[index]).find(Boolean) || 0;
}

function assetName(version, platform, arch, portable) {
  if (arch !== 'x64' && arch !== 'arm64') return '';
  const prefix = `yugo-pi-client-${version}-`;
  if (platform === 'darwin') return `${prefix}mac-${arch}.dmg`;
  if (platform === 'win32' && portable) return arch === 'x64' ? `${prefix}windows-x64-portable.exe` : '';
  if (platform === 'win32') return `${prefix}windows-${arch}-setup.exe`;
  if (platform === 'linux' && portable) return `${prefix}linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`;
  if (platform === 'linux') return `${prefix}linux-${arch === 'x64' ? 'amd64' : arch}.deb`;
  return '';
}

async function checkClientUpdate(current, { platform, arch, portable, fetchImpl = fetch }) {
  const installed = versionParts(current);
  if (!installed) throw new Error('无法识别当前客户端版本。');
  const response = await fetchImpl(API, {
    headers: { Accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw new Error('暂时无法获取 YuGo Pi 版本信息。');
  const chunks = [];
  let length = 0;
  for await (const bytes of response.body) {
    length += bytes.length;
    if (length > 2 * 1024 * 1024) throw new Error('发行信息过大。');
    chunks.push(bytes);
  }
  const releases = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(releases)) throw new Error('无法验证 YuGo Pi 的发行版本。');
  let selected;
  for (const release of releases) {
    if (!release || release.draft || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('yugo-v')) continue;
    const version = release.tag_name.slice(6);
    const parts = versionParts(version);
    if (parts && (!selected || compareVersions(parts, selected.parts) > 0)) {
      selected = { version, parts, assets: release.assets };
    }
  }
  if (!selected) throw new Error('无法验证 YuGo Pi 的发行版本。');
  if (compareVersions(selected.parts, installed) <= 0) return null;
  const { version, assets } = selected;
  const name = assetName(version, platform, arch, portable);
  const matching = (Array.isArray(assets) ? assets : []).filter((asset) => asset?.name === name);
  const [asset] = matching;
  if (!name || matching.length !== 1 || asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_SIZE ||
      typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('这个平台的新版本暂未提供可校验的安装包。');
  }
  return { version, name, size: asset.size, sha256: asset.digest.slice(7) };
}

async function downloadClientUpdate(update, profile, { platform, arch, portable, progress, fetchImpl = fetch }) {
  const name = versionParts(update.version) && assetName(update.version, platform, arch, portable);
  if (!name || update.name !== name) throw new Error('安装包与此客户端不匹配。');
  const source = new URL(`${RELEASES}/download/yugo-v${update.version}/${name}`);
  const signal = AbortSignal.timeout(5 * 60 * 1000);
  let url = source;
  let response;
  for (let count = 0; count < 5; count++) {
    response = await fetchImpl(url, { redirect: 'manual', signal });
    if (response.status === 200) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
    url = new URL(location, url);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !DOWNLOAD_HOSTS.has(url.hostname)) {
      throw new Error('安装包下载跳转到了未受信任的地址。');
    }
  }
  const length = response.headers.get('content-length');
  if (response.status !== 200 || !response.body || (length !== null && Number(length) !== update.size)) {
    await response.body?.cancel();
    throw new Error('安装包下载失败或文件大小不符。');
  }

  let directory;
  try {
    directory = await fs.mkdtemp(path.join(profile, 'client-update-'));
  } catch (error) {
    await response.body.cancel();
    throw error;
  }
  const partial = path.join(directory, '.download');
  const file = path.join(directory, name);
  try {
    const digest = createHash('sha256');
    let written = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length;
        if (written > update.size) return callback(new Error('安装包文件大小不符。'));
        digest.update(chunk);
        progress?.(written / update.size);
        callback(null, chunk);
      },
    }), createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal });
    if (written !== update.size || digest.digest('hex') !== update.sha256) {
      throw new Error('安装包未通过大小或 SHA-256 校验。');
    }
    if (platform === 'darwin') {
      const seconds = Math.floor(Date.now() / 1000).toString(16);
      await promisify(execFile)('/usr/bin/xattr', [
        '-w', 'com.apple.quarantine', `0081;${seconds};YuGo Pi Client;${randomUUID()}`, partial,
      ], { timeout: 5000 });
    }
    if (platform === 'win32') {
      await fs.writeFile(`${partial}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${source.href}\r\n`);
    }
    if (platform === 'linux' && portable) await fs.chmod(partial, 0o700);
    await fs.rename(partial, file);
    return file;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { checkClientUpdate, downloadClientUpdate, RELEASES };
