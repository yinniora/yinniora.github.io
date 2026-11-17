import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
import tarfile

spec = importlib.util.spec_from_file_location('package_release', Path(__file__).with_name('package_release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseNoticesTests(unittest.TestCase):
    def test_every_archive_contains_original_license_and_provenance(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / 'binary'
            binary.write_bytes(b'fixture')
            for name in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']:
                (root / name).write_text(name)
            for target in ['darwin', 'linux', 'windows']:
                archive = release.package_release(binary, target, 'arm64', root / 'dist', root)
                if target == 'windows':
                    with zipfile.ZipFile(archive) as stream:
                        names = stream.namelist()
                else:
                    with tarfile.open(archive) as stream:
                        names = stream.getnames()
                self.assertTrue({'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES'}.issubset(names))
            (root / 'NOTICE').unlink()
            with self.assertRaises(ValueError):
                release.package_release(binary, 'darwin', 'arm64', root / 'dist', root)


if __name__ == '__main__':
    unittest.main()
