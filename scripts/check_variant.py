#!/usr/bin/env python3
"""Fail closed if an upstream merge drops YuGo identity or maintenance guards."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent.parent


def check(root=ROOT):
    config = json.loads((root / 'variant.json').read_text())
    package = json.loads((root / 'package.json').read_text())
    assert config['name'] == 'YuGo Pi'
    assert package['name'] == '@yinniora/yugo-pi'
    assert package['repository']['url'] == config['repository']
    assert '-yugo.' in package['version']
    license_text = (root / 'LICENSE').read_text()
    assert 'Copyright (c) 2026 Set Kyar Wa Lar (YGNCode)' in license_text
    assert 'The above copyright notice and this permission notice' in license_text
    assert 'independently maintained' in (root / 'NOTICE').read_text()
    app = (root / 'internal/app/app.go').read_text()
    assert 'updater.NewTracking(version)' in app
    assert (root / 'internal/updater/upstream-base.txt').read_text().strip().startswith(config['baseCommit'])
    assert 'return runInstall(ctx)' not in app
    extension = (root / '.pi/extensions/pi-web.ts').read_text()
    update = extension.split('if (subcommand === "update") {', 1)[1].split('if (subcommand !== "status")', 1)[0]
    assert 'pi.exec' not in update and 'reviewed releases' in update
    assert 'npm:@ygncode/pi-web' not in extension
    workflow = (root / '.github/workflows/release.yml').read_text()
    assert 'yugo-v*' in workflow and 'npm publish' not in workflow
    assert 'THIRD_PARTY_NOTICES' in workflow
    assert 'git push --follow-tags' not in (root / 'Makefile').read_text()
    for name in [
        'web/src/components/index/MobileHome.svelte',
        'web/src/components/index/HomeProject.test.js',
        'web/src/components/shared/DevicePanel.svelte',
        'web/src/components/shared/MacFolderPicker.svelte',
        'web/src/shared/visual-viewport.test.js',
        'web/src/components/session/ImageModal.test.js',
        'web/src/components/session/BtwPopup.test.js',
        'internal/server/session_files_test.go',
        'internal/server/project_delete_test.go',
        'internal/server/devices_test.go',
        'internal/relay/controller_test.go',
        'e2e/tests/mobile-workspace.spec.ts',
    ]:
        assert (root / name).is_file(), f'YuGo regression coverage missing: {name}'
    print('YuGo identity, attribution, manual-update policy and feature contracts: passed')


if __name__ == '__main__':
    check()
