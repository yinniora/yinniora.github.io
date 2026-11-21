import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

import install_relay as installer


class RelayInstallTest(unittest.TestCase):
    def archive(self, tag, _arch):
        data = io.BytesIO()
        files = {
            'pi-relay': tag.encode(),
            'yugo-pi-relay-install.py': b'installer ' + tag.encode(),
            'generate_relay_config.py': Path(installer.__file__).with_name('generate_relay_config.py').read_bytes(),
            'LICENSE': b'license',
            'NOTICE': b'notice',
            'THIRD_PARTY_NOTICES': b'third-party notices',
        }
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name, content in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
        data.seek(0)
        return tarfile.open(fileobj=data, mode='r:gz')

    def test_secure_profile_upgrade_and_failed_upgrade_rollback(self):
        running = set()
        commands = []

        def fake_run(*arguments, **kwargs):
            if arguments[0] == 'python3':
                previous = os.umask(0o077)
                try:
                    return subprocess.run(arguments, check=True, **kwargs)
                finally:
                    os.umask(previous)
            commands.append(arguments)
            if len(arguments) >= 3:
                if arguments[1] in ('start', 'restart'):
                    running.add(arguments[2])
                elif arguments[1] == 'stop':
                    running.discard(arguments[2])
            return SimpleNamespace(returncode=0)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'units').mkdir()
            (root / 'setup').mkdir(mode=0o700)
            paths = dict(STATE=root / 'state', CONF=root / 'config', BIN=root / 'bin', UNITS=root / 'units',
                         RUNTIME=root / 'setup', INSTALLED_TOOL=root / 'yugo-pi-relay-setup')
            with patch.multiple(installer, **paths, run=fake_run, install_coturn=lambda: None,
                                online=running.__contains__, release_archive=self.archive,
                                active_ports=lambda: {3478, 43120} if running else set()), redirect_stdout(io.StringIO()) as output:
                args = SimpleNamespace(external_proxy=True)
                url = 'https://relay.example.com'
                client = 'https://client.example.com'
                with patch.object(installer, 'verify_relay', return_value=True):
                    installer.setup(args, 'yugo-v0.1.0-yugo.61', 'arm64', None, url, client, '')
                    before = installer.read_profile()
                    self.assertEqual(0o600, (paths['STATE'] / 'private/connection.json').stat().st_mode & 0o777)
                    self.assertIn('yugopi-relay:', output.getvalue())
                    self.assertNotIn(before['hostToken'], output.getvalue())
                    first_marker = list(paths['RUNTIME'].iterdir())
                    self.assertEqual(len(first_marker), 1)
                    installer.setup(args, 'yugo-v0.1.0-yugo.62', 'arm64', before, url, client, '')
                self.assertEqual(before, installer.read_profile())
                self.assertEqual(running, {installer.BROKER, installer.TURN})
                self.assertEqual((paths['BIN'] / 'pi-relay').read_text(), 'yugo-v0.1.0-yugo.62')
                self.assertNotEqual(list(paths['RUNTIME'].iterdir()), first_marker)
                with patch.object(installer, 'verify_relay', return_value=False), patch.object(installer.time, 'monotonic', side_effect=[0, 100]):
                    with self.assertRaisesRegex(ValueError, 'Public HTTPS'):
                        installer.setup(args, 'yugo-v0.1.0-yugo.63', 'arm64', before, url, client, '')
                self.assertEqual((paths['BIN'] / 'pi-relay').read_text(), 'yugo-v0.1.0-yugo.62')
                self.assertEqual(paths['INSTALLED_TOOL'].read_text(), 'installer yugo-v0.1.0-yugo.62')
                self.assertEqual(json.loads((paths['STATE'] / 'installation.json').read_text())['tag'], 'yugo-v0.1.0-yugo.62')
                self.assertEqual(before, installer.read_profile())
                self.assertEqual(running, {installer.BROKER, installer.TURN})
                self.assertIn(('systemctl', 'restart', installer.BROKER), commands)

    def test_public_proxy_has_only_relay_paths_and_selects_a_public_ip_certificate(self):
        address = installer.public_origin('8.8.8.8')
        caddyfile = installer.caddyfile(address).decode()
        self.assertIn('issuer acme https://acme-v02.api.letsencrypt.org/directory', caddyfile)
        self.assertIn('profile shortlived', caddyfile)
        self.assertIn('default_sni 8.8.8.8', caddyfile)
        self.assertIn('@relay path /signal /ice /verify /setup', caddyfile)
        self.assertIn('reverse_proxy 127.0.0.1:43120', caddyfile)
        self.assertIn('respond 404', caddyfile)
        self.assertNotIn('shortlived', installer.caddyfile('https://relay.example.com').decode())
        for address in ('https://relay.example.com\nmalicious', 'http://relay.example.com',
                        'https://relay.example.com/#token', '192.168.0.4', 'https://relay.example.com:8443'):
            with self.assertRaises(ValueError):
                installer.public_origin(address)


if __name__ == '__main__':
    unittest.main()
