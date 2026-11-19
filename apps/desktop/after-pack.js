// Unsigned macOS builds: re-apply an ad-hoc signature after packaging so Apple
// Silicon does not report the app as damaged. No Apple Developer ID is used;
// first launch needs right-click → Open (see apps/README.md).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
