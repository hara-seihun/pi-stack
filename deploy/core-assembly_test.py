import json
from importlib.machinery import SourceFileLoader
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
assembly = SourceFileLoader('assembly_fixture', str(Path(__file__).with_name('core-assemble'))).load_module()
bindings = SourceFileLoader('bindings_fixture', str(Path(__file__).with_name('core-bindings'))).load_module()


class AssemblyTests(unittest.TestCase):
    def test_policy_identity_conflicts_are_not_overwritten(self):
        base = {'revision': 2, 'grants': [{'id': 'g', 'effect': 'allow'}], 'consents': []}
        self.assertEqual(assembly.merge_policy(base, base), base)
        with self.assertRaises(ValueError):
            assembly.merge_policy(base, {'revision': 3, 'grants': [{'id': 'g', 'effect': 'deny'}], 'consents': []})

    def test_unresolved_facts_never_become_activation_config(self):
        facts = assembly.unresolved({'scopes': [{'custody': {'kind': 'unresolved', 'code': 'namespace'}}]})
        self.assertEqual(facts, [{'code': 'namespace', 'field': 'config.scopes[0].custody'}])

    def test_metadata_observer_is_readonly_and_does_not_export_bodies(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'threads.sqlite3'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE thread(id TEXT,cwd TEXT,metadata TEXT,body TEXT)')
            db.execute('INSERT INTO thread VALUES(?,?,?,?)', ('manager', folder, '{"manager":true}', 'PRIVATE_PAYLOAD_MUST_NOT_APPEAR'))
            db.commit(); db.close()
            before = path.read_bytes()
            output = subprocess.check_output([sys.executable, '-c', bindings.METADATA], input=json.dumps([{'id': 'scope', 'databasePath': str(path)}]).encode())
            self.assertNotIn(b'PRIVATE_PAYLOAD', output)
            self.assertEqual(json.loads(output)[0]['managerIds'], ['manager'])
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
