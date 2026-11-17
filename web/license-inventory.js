// Build-time only. Public metadata contains package identities, never local paths.
import fs from 'node:fs';
import path from 'node:path';

export function licenseInventory() {
  return {
    name: 'yugo-runtime-license-inventory',
    generateBundle(_options, bundle) {
      const packages = new Map();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const [id, module] of Object.entries(chunk.modules || {})) {
          if (module.renderedLength === 0 || !id.includes('node_modules/')) continue;
          let directory = path.dirname(id.split('?')[0]);
          while (directory.includes('node_modules')) {
            const manifest = path.join(directory, 'package.json');
            if (fs.existsSync(manifest)) {
              const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
              if (data.name && data.version) {
                packages.set(data.name + '@' + data.version, {
                  name: data.name,
                  version: data.version,
                });
                break;
              }
            }
            const parent = path.dirname(directory);
            if (parent === directory) break;
            directory = parent;
          }
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'runtime-licenses.json',
        source:
          JSON.stringify(
            [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
            null,
            2,
          ) + '\n',
      });
    },
  };
}
