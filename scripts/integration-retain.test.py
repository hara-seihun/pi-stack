import importlib.util
from pathlib import Path
import subprocess
import tempfile
import json
import unittest

spec = importlib.util.spec_from_file_location('integration_retain', Path(__file__).resolve().parents[1] / 'deploy/integration-retain.py')
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class Retention(unittest.TestCase):
    def fixture(self, state):
        root = state / 'integrations' / ('a' * 40)
        root.mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(root)], check=True)
        (root / '.gitignore').write_text('node_modules/\n')
        target = root / 'node_modules'
        target.mkdir()
        (target / 'cache').write_text('rebuildable')
        (state / 'requests').mkdir()
        receipt = state / 'requests/one.json'
        receipt.write_text(json.dumps({'integrationSha': root.name, 'status': 'published'}))
        return root, target, receipt

    def test_published_dependencies_only_and_live_consumers_preserved(self):
        with tempfile.TemporaryDirectory() as scratch:
            state = Path(scratch)
            root, target, receipt = self.fixture(state)
            live = owner.collect(state, True, lambda: [str(root).encode()])
            self.assertEqual(live['value']['results'][0]['state'], 'referenced')
            pending = state / 'requests/two.json'
            pending.write_text(json.dumps({'integrationSha': root.name, 'status': 'queued'}))
            self.assertEqual(owner.collect(state, True, lambda: [])['value']['results'], [])
            pending.unlink()
            removed = owner.collect(state, True, lambda: [])
            self.assertEqual(removed['value']['results'][0]['state'], 'removed')
            self.assertFalse(target.exists())
            self.assertTrue(root.exists())
            self.assertTrue(receipt.exists())
            self.assertEqual(json.loads((state / 'dependency-retention.jsonl').read_text())['state'], 'removed')

    def test_inaccessible_process_census_refuses_before_mutation(self):
        with tempfile.TemporaryDirectory() as scratch:
            state = Path(scratch)
            _, target, _ = self.fixture(state)
            def unavailable():
                raise PermissionError('inaccessible process')
            with self.assertRaises(PermissionError):
                owner.collect(state, True, unavailable)
            self.assertTrue(target.exists())


if __name__ == '__main__':
    unittest.main()
