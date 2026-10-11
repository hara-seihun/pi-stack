#!/usr/bin/python3 -B
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ImmutableHelpers(unittest.TestCase):
    def test_plain_interpreter_and_direct_entry_never_add_artifact_caches(self):
        names = ['core-runtime', 'core-custody', 'core-person-activate', 'core-plan', 'core-drain',
                 'core-root-census', 'core-native-census', 'core-remote-witness', 'core-meet-drain', 'core-adopt-batch',
                 'core-bindings', 'core-assemble', 'core-aux-plan', 'core-aux-run',
                 'core-image-handoff', 'core-provider-adopt', 'core-adopt', 'core-capability-epoch.py']
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            for name in [*names, 'core_namespace.py']:
                shutil.copyfile(ROOT / 'deploy' / name, folder / name)
            environment = {key: value for key, value in os.environ.items() if key not in ('PYTHONDONTWRITEBYTECODE', 'PYTHONPATH', 'PYTHONPYCACHEPREFIX')}
            for name in names:
                subprocess.run(['/usr/bin/python3', '-c', 'import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2])', str(folder), str(folder / name)],
                               env=environment, check=True, capture_output=True, timeout=2)
            runtime = folder / 'core-runtime'
            runtime.chmod(0o755)
            result = subprocess.run([str(runtime)], env=environment, capture_output=True, timeout=2)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sorted(path.name for path in folder.iterdir()), sorted([*names, 'core_namespace.py']))


if __name__ == '__main__':
    unittest.main()
