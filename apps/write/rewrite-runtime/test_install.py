import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('rewrite_install', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.previous_umask = os.umask(0o077)

    def tearDown(self):
        os.umask(self.previous_umask)

    def fixture(self, root):
        cache = root / 'cache'
        cache.mkdir()
        manifests = root / 'manifests'
        manifests.mkdir()
        archive = cache / 'fixture.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('build/bin/llama-server', '#!/bin/sh\necho "fixture version"\n')
            bundle.writestr('build/bin/LICENSE', 'MIT fixture')
        runtime = {'sha256': installer.digest(archive), 'size': archive.stat().st_size,
                   'url': 'https://invalid.example/never-download', 'archive_prefix': 'build/bin/',
                   'files': ['llama-server', 'LICENSE'], 'minimum_glibc': '2.34', 'cpu_flags': []}
        (manifests / 'runtime.json').write_text(json.dumps(runtime))
        model = cache / 'model.gguf'
        model.write_bytes(b'GGUFfixture')
        (manifests / 'model.json').write_text(json.dumps({
            'sha256': installer.digest(model), 'size': model.stat().st_size,
            'url': 'https://invalid.example/never-download'}))
        return cache, manifests, runtime

    def test_cache_install_check_repair_and_changed_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache, manifests, runtime = self.fixture(root)
            store = root / 'public'
            with patch.object(installer, 'compatible'), patch.object(installer.subprocess, 'run') as run:
                paths = installer.install(store, manifests, cache=cache)
                self.assertEqual(run.call_count, 1)  # only --version, never a download
                self.assertEqual(installer.install(store, manifests, 'check'), paths)
                for directory in paths:
                    for path in [directory, *directory.rglob('*')]:
                        self.assertTrue(path.stat().st_mode & stat.S_IROTH)
                (paths[0] / 'bin/llama-server').write_text('corrupt')
                with self.assertRaisesRegex(ValueError, 'missing or corrupt'):
                    installer.install(store, manifests, 'check')
                installer.install(store, manifests, cache=cache)
                self.assertIn('fixture version', (paths[0] / 'bin/llama-server').read_text())
                runtime['release'] = 'changed-input'
                (manifests / 'runtime.json').write_text(json.dumps(runtime))
                # New preparation identity reuses the verified archive in the public store.
                new_paths = installer.install(store, manifests)
                self.assertNotEqual(paths[0], new_paths[0])
                self.assertEqual(paths[1], new_paths[1])

    def test_download_uses_callers_budget_and_verifies_completion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache, manifests, _ = self.fixture(root)
            manifest = installer.load(manifests / 'model.json')
            content = (cache / 'model.gguf').read_bytes()
            store = root / 'store'
            store.mkdir()
            destination = store / 'model.gguf'

            def download(command, **kwargs):
                # Preparation's owner may allow more than 45 seconds. An inner
                # deadline must not kill its shell and leave curl unowned.
                self.assertNotIn('timeout', kwargs)
                self.assertTrue(kwargs['check'])
                self.assertEqual(command[-3:], [manifest['url'], str(destination), manifest['sha256']])
                destination.write_bytes(content)

            with patch.object(installer.subprocess, 'run', side_effect=download) as run:
                installer.fetch(manifest, destination, store, None)
                self.assertTrue(installer.verified(destination, manifest))
                installer.fetch(manifest, destination, store, None)
                self.assertEqual(run.call_count, 1)

    def test_completed_partial_is_promoted_without_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache, manifests, _ = self.fixture(root)
            manifest = installer.load(manifests / 'model.json')
            store = root / 'store'
            store.mkdir()
            model_dir = store / 'rewrite-model-fixture'
            model_dir.mkdir()
            destination = model_dir / 'model.gguf'
            partial = model_dir / 'model.gguf.part'
            partial.write_bytes((cache / 'model.gguf').read_bytes())
            # The reuse glob includes our own partial: promote it before scanning
            # candidates, rather than trying to copy the file over itself.
            with patch.object(installer.subprocess, 'run') as run:
                installer.fetch(manifest, destination, store, None)
                run.assert_not_called()
            self.assertTrue(installer.verified(destination, manifest))
            self.assertFalse(partial.exists())

    def test_rejects_traversal_and_symlink_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, mode in [('../escape', stat.S_IFREG), ('build/bin/link', stat.S_IFLNK)]:
                archive = root / 'unsafe.zip'
                with zipfile.ZipFile(archive, 'w') as bundle:
                    member = zipfile.ZipInfo(name)
                    member.external_attr = (mode | 0o777) << 16
                    bundle.writestr(member, 'target')
                with self.assertRaisesRegex(ValueError, 'unsafe archive member'):
                    installer.extract(archive, {'archive_prefix': 'build/bin/', 'files': ['llama-server']}, root)
            self.assertFalse((root.parent / 'escape').exists())

    def test_incompatible_glibc_rejected_before_download(self):
        with patch.object(installer.platform, 'system', return_value='Linux'), \
                patch.object(installer.platform, 'machine', return_value='x86_64'), \
                patch.object(installer.os, 'confstr', return_value='glibc 2.31'):
            with self.assertRaisesRegex(ValueError, 'glibc >= 2.34'):
                installer.compatible({'minimum_glibc': '2.34', 'cpu_flags': []})

    def test_corrupt_same_size_cache_is_not_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache, manifests, _ = self.fixture(root)
            manifest = installer.load(manifests / 'model.json')
            (cache / 'model.gguf').write_bytes(b'BADUfixture')
            store = root / 'store'
            store.mkdir()
            with patch.object(installer.subprocess, 'run'):
                with self.assertRaisesRegex(ValueError, 'size/checksum mismatch'):
                    installer.fetch(manifest, store / 'model.gguf', store, cache)


if __name__ == '__main__':
    unittest.main()
