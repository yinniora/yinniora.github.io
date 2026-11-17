import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sync_upstream', Path(__file__).with_name('sync_upstream.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class UpstreamReviewTests(unittest.TestCase):
    def test_conflict_never_changes_main_or_local_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'source'
            root.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
            git('init', '-b', 'main')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            target = root / 'feature.txt'
            target.write_text('base\n')
            git('add', '.')
            git('commit', '-m', 'base')
            git('checkout', '-b', 'official')
            target.write_text('official change\n')
            git('commit', '-am', 'official')
            git('checkout', 'main')
            target.write_text('YuGo change\n')
            git('commit', '-am', 'variant')
            before = git('rev-parse', 'HEAD')
            result = sync.prepare(root, 'official', Path(temp) / 'review')
            self.assertEqual(result['status'], 'conflicts')
            self.assertEqual(result['conflicts'], ['feature.txt'])
            self.assertEqual(git('rev-parse', 'HEAD'), before)
            self.assertEqual(target.read_text(), 'YuGo change\n')
            self.assertEqual(git('status', '--porcelain'), '')
            with self.assertRaises(ValueError):
                sync.prepare(root, 'official', Path(temp) / 'review')

    def test_dirty_main_is_not_used_or_modified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            subprocess.run(['git', 'init', '-b', 'main', str(root)], check=True, capture_output=True)
            (root / 'uncommitted').write_text('keep')
            with self.assertRaises(ValueError):
                sync.prepare(root, 'unused', root / 'review')
            self.assertEqual((root / 'uncommitted').read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
