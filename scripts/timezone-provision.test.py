#!/usr/bin/python3
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

path = Path(__file__).parent.parent / 'apps/remote/server/pi-timezone-provision'
loader = importlib.machinery.SourceFileLoader('provisioner', str(path))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class ProvisionTests(unittest.TestCase):
    def test_directory_does_not_invent_a_timezone(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'person'
            module.provision(directory, os.getuid(), os.getgid())
            self.assertEqual(directory.stat().st_mode & 0o7777, 0o2750)
            self.assertFalse((directory / 'timezone.json').exists())

    def test_updating_or_missing_is_not_ready_unknown(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with self.assertRaises(FileNotFoundError):
                module.verify('person', directory, os.getuid(), os.getgid())
            path = directory / 'timezone.json'
            path.write_text(json.dumps({'version': 1, 'state': 'updating'}))
            path.chmod(0o640)
            with self.assertRaisesRegex(RuntimeError, 'not_ready'):
                module.verify('person', directory, os.getuid(), os.getgid())
            path.write_text(json.dumps({'version': 1, 'state': 'ready', 'timezone': None}))
            self.assertTrue(module.verify('person', directory, os.getuid(), os.getgid())['ready'])

    def test_projection_with_private_extra_fields_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'timezone.json'
            path.write_text(json.dumps({'version': 1, 'state': 'ready', 'timezone': None, 'privateData': 'never a timezone'}))
            path.chmod(0o640)
            with self.assertRaisesRegex(RuntimeError, 'not_ready'):
                module.verify('person', Path(root), os.getuid(), os.getgid())


if __name__ == '__main__':
    unittest.main()
