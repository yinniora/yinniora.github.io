const { Arch, Platform, build } = require('electron-builder');
const path = require('node:path');
const fs = require('node:fs');
const { build: client } = require('./package.json');
const { version } = require('../../package.json');

async function main() {
  const [os, arch, input] = process.argv.slice(2);
  if (!['linux', 'win32'].includes(os) || !['arm64', 'x64'].includes(arch) || !input) {
    throw new Error('Usage: node package-host.js <linux|win32> <x64|arm64> <staged runtime>');
  }
  const runtime = path.resolve(input);
  const linux = os === 'linux';
  if (!fs.existsSync(path.join(runtime, os === 'win32' ? 'pi-web.exe' : 'pi-web'))) {
    throw new Error('The staged host executable is missing.');
  }
  const policy = path.resolve(__dirname, '../../init/org.yugopi.approve-pairing.policy');
  const config = {
    appId: 'io.github.yinniora.yugopi.host',
    productName: 'YuGo Pi Host',
    extraMetadata: {
      name: 'yugo-pi-host',
      productName: 'YuGo Pi Host',
      desktopName: 'io.github.yinniora.yugopi.host.desktop',
      description: 'YuGo Pi desktop window and local host',
      version,
    },
    artifactName: 'yugo-pi-host-${version}-${os}-${arch}.${ext}',
    copyright: client.copyright,
    files: client.files,
    afterPack: async ({ appOutDir }) => {
      const destination = path.join(appOutDir, 'resources', 'host');
      // Electron's file filters are for its own dependencies. Copy the
      // separate Node runtime and Pi's complete dependency tree as-is.
      await fs.promises.cp(runtime, destination, { recursive: true, verbatimSymlinks: true });
      const pi = path.join(destination, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
      if (!fs.existsSync(pi)) throw new Error('The package is missing its Pi runtime.');
    },
    directories: { ...client.directories, output: 'dist/host' },
    win: { target: [{ target: 'nsis', arch: [arch] }], signAndEditExecutable: true },
    nsis: {
      oneClick: true,
      perMachine: false,
      runAfterFinish: true,
      artifactName: 'yugo-pi-host-${version}-windows-${arch}-setup.${ext}',
    },
    linux: {
      target: [{ target: 'deb', arch: [arch] }],
      category: client.linux.category,
      maintainer: client.linux.maintainer,
      synopsis: 'YuGo Pi desktop window and local host',
      syncDesktopName: true,
    },
  };
  if (linux && fs.existsSync(policy)) {
    config.deb = { fpm: ['--depends', 'polkitd', policy + '=/usr/share/polkit-1/actions/' + path.basename(policy)] };
  }
  const platform = linux ? Platform.LINUX : Platform.WINDOWS;
  const target = linux ? 'deb' : 'nsis';
  await build({ config, targets: platform.createTarget(target, Arch[arch]), publish: 'never' });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
