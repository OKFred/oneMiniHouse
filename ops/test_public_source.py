import importlib.util
import json
import tempfile
import unittest
import tarfile
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('public_source', Path(__file__).with_name('public_source.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class PublicSourceTests(unittest.TestCase):
    def test_private_paths_are_not_exportable(self):
        for path in ['.env', 'src/.env.production', 'src/.local/file.ts', 'sql/test.local.sql', 'secrets/key',
                     'config/test.local.json', '../escape', 'data/test.sqlite', 'project.private.config.json']:
            self.assertTrue(release.unsafe_path(path), path)
        self.assertFalse(release.unsafe_path('.env.example'))

    def test_missing_or_invalid_private_rules_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'rules.json'
            with self.assertRaises(FileNotFoundError):
                release.private_rules(p)
            for obj in [{}, {'literals': []}, {'literals': ['']}, {'literals': 'string'}]:
                p.write_text(json.dumps(obj))
                with self.assertRaises(ValueError):
                    release.private_rules(p)

    def test_snapshot_preserves_spaces_and_unicode_without_history(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'source'
            root.mkdir()
            (root / '示例 file.ts').write_text('export const value = 42;', encoding='utf-8')
            target = Path(d) / 'output'
            result = release.export(root, target, ['示例 file.ts'], ['private-marker'])
            self.assertEqual(result['files'], 1)
            self.assertFalse((target / '.git').exists())
            with self.assertRaises(ValueError):
                release.export(root, target, ['示例 file.ts'], ['private-marker'])

    def test_private_literal_blocks_export_without_echoing_value(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'src.ts').write_text('private-marker')
            findings = release.scan(root, ['src.ts'], ['private-marker'])
            self.assertEqual(findings[0]['rule'], 'private-literal-1')
            self.assertNotIn('private-marker', json.dumps(findings))
            with self.assertRaises(ValueError):
                release.export(root, root / 'export', ['src.ts'], ['private-marker'])
            self.assertFalse((root / 'export').exists())

    def test_private_filename_is_blocked_and_redacted(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'private-marker.ts').write_text('private-marker')
            findings = release.scan(root, ['private-marker.ts'], ['private-marker'])
            self.assertTrue(findings)
            self.assertNotIn('private-marker', json.dumps(findings))

    def test_generic_rules_also_block_private_filename(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            address = '.'.join(['192', '168', '1', '2'])
            name = 'config-' + address + '.json'
            (root / name).write_text('{}')
            findings = release.scan(root, [name], [])
            self.assertEqual(findings[0]['rule'], 'path-private-ip')
            self.assertNotIn(address, json.dumps(findings))

    def test_packaging_uses_exact_scanned_bytes_after_source_change(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            names = ['gateway/safe.ts', 'ingestor/safe.ts']
            for n in names:
                (root / n).parent.mkdir()
                (root / n).write_text('safe')
            original = release.scan
            def change_after_scan(*args, **kwargs):
                findings = original(*args, **kwargs)
                (root / names[0]).write_text('private-marker')
                return findings
            with patch.object(release, 'scan', side_effect=change_after_scan):
                release.package(root, root / 'out', names, ['private-marker'])
            with tarfile.open(root / 'out/gateway.tgz') as archive:
                self.assertEqual(archive.extractfile('safe.ts').read(), b'safe')

if __name__ == '__main__':
    unittest.main()
