import importlib.machinery
import json
import hashlib
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'deploy'))
adopt = importlib.machinery.SourceFileLoader('core_adopt_test', str(ROOT / 'deploy/core-adopt')).load_module()


class Adoption(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        folder = str(root / 'folder')
        source = {'kind': 'pinned', 'path': '/run/pi-stack/namespaces/source', 'mountNamespaceInode': '1'}
        target = {'kind': 'pinned', 'path': '/run/pi-stack/namespaces/target', 'mountNamespaceInode': '2'}
        plan = {'version': 1, 'scopeId': 'alice', 'user': 'alice', 'registryPath': str(root / 'registry.json'),
            'cipherDir': str(root / 'cipher'), 'mountpoint': folder, 'databasePath': folder + '/threads.sqlite3', 'sessionsDir': folder + '/sessions',
            'source': {'uid': 1001, 'gid': 1001, 'namespace': source}, 'target': {'uid': 0, 'gid': 0, 'namespace': target},
            'detachmentReceiptPath': str(root / 'detached.json'), 'sourceMountReceiptPath': str(root / 'retained.json'),
            'targetMountReceiptPath': str(root / 'mounted.json'), 'adoptionReceiptPath': str(root / 'adopted.json')}
        values = {
            'registry.json': {'user': 'alice', 'unlock': {'cipherDir': plan['cipherDir'], 'mountpoint': folder}},
            'detached.json': {'version': 1, 'state': 'detached', 'scopeId': 'alice', 'databasePath': plan['databasePath'], 'sessionsDir': plan['sessionsDir'],
                'databaseIdentity': {'dev': '3', 'ino': '4'}, 'previousOwner': {'identity': 'native-owner', 'detachedAt': '2026-10-10T21:00:00Z'}},
            'retained.json': {'version': 1, 'namespace': source, 'cipherDir': plan['cipherDir'], 'mountpoint': folder},
            'mounted.json': {'version': 1, 'namespace': target, 'cipherDir': plan['cipherDir'], 'mountpoint': folder, 'sharedstorage': True}}
        for name, value in values.items(): (root / name).write_text(json.dumps(value))
        files = {'database': {'sha256': 'a' * 64, 'size': 8}, 'wal': {'kind': 'present', 'sha256': 'b' * 64, 'size': 9}}
        snapshots = [{'databaseIdentity': {'dev': '3', 'ino': '4'}, 'files': files}, {'databaseIdentity': {'dev': '5', 'ino': '6'}, 'files': files}]
        return plan, snapshots

    def run_transfer(self, plan, snapshots):
        with patch.object(adopt, 'trusted', side_effect=lambda path: json.loads(path.read_text())), \
             patch.object(adopt, 'namespace_path', return_value=Path('/proc/self/ns/mnt')), \
             patch.object(adopt, 'mount_identity', return_value={'source': plan['cipherDir']}), \
             patch.object(adopt, 'verify_fuse'), \
             patch.object(adopt, 'enter', side_effect=[json.dumps(value) for value in snapshots]):
            return adopt.transfer(plan)

    def test_exact_same_cipher_changes_only_adoption_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, snapshots = self.fixture(directory)
            detached = Path(plan['detachmentReceiptPath']).read_bytes()
            result = self.run_transfer(plan, snapshots * 2)
            self.assertFalse(result['copied'])
            receipt = json.loads(Path(plan['adoptionReceiptPath']).read_text())
            self.assertEqual(receipt['databaseIdentity'], {'dev': '5', 'ino': '6'})
            self.assertEqual(receipt['generationTransfer']['retainedRunnerNamespace'], plan['source']['namespace'])
            self.assertEqual(detached, Path(plan['detachmentReceiptPath']).read_bytes())

    def test_mismatched_wal_or_changed_source_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, snapshots = self.fixture(directory)
            changed = json.loads(json.dumps(snapshots[1]))
            changed['files']['wal']['sha256'] = 'c' * 64
            with self.assertRaisesRegex(ValueError, 'identical detached'):
                self.run_transfer(plan, [snapshots[0], changed])
            changed = json.loads(json.dumps(snapshots[0]))
            changed['files']['database']['size'] += 1
            with self.assertRaisesRegex(ValueError, 'changed during generation'):
                self.run_transfer(plan, snapshots + [changed])
            self.assertFalse(Path(plan['adoptionReceiptPath']).exists())

    def test_no_prior_capability_initializes_once_without_touching_existing_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); folder = root / 'encrypted'; folder.mkdir()
            database = folder / 'threads.sqlite3'; database.write_bytes(b'existing database fixture')
            source = root / 'source.ts'; source.write_text('new ThreadService({databasePath});')
            plan = {'version': 1, 'scopeId': 'retained-root', 'priorCapability': 'none', 'uid': os.getuid(), 'gid': os.getgid(),
                    'namespace': {'kind': 'pinned'}, 'keyPath': str(folder / 'thread-capability.key'), 'databasePath': str(database),
                    'encryptedMountpoint': str(folder), 'receiptPath': str(root / 'receipt.json'),
                    'sourceProof': {'kind': 'owner-source-no-capability', 'path': str(source), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}}
            execute = lambda namespace, command, uid, gid: subprocess.run(command, check=True, capture_output=True, text=True).stdout
            with patch.object(adopt, 'trusted', side_effect=lambda path: json.loads(path.read_text())), patch.object(adopt, 'mount_identity'), patch.object(adopt, 'namespace_path', return_value=Path('/proc/self/ns/mnt')), patch.object(adopt, 'enter', side_effect=execute):
                first = adopt.initialize_capability(plan)
                second = adopt.initialize_capability(plan)
                self.assertEqual(first, second)
                self.assertEqual(len(Path(plan['keyPath']).read_bytes()), 65)
                self.assertEqual(database.read_bytes(), b'existing database fixture')
                Path(plan['keyPath']).write_bytes(b'changed unknown key')
                with self.assertRaises(subprocess.CalledProcessError):
                    adopt.initialize_capability(plan)

    def test_group_rebind_observes_actual_files_without_per_store_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); plans = []
            for n in range(2):
                database = root / f'{n}.sqlite'; database.write_bytes(b'adopted store'); Path(str(database)+'-wal').write_bytes(b'wal')
                receipt = root / f'{n}.receipt.json'; stat = database.stat()
                receipt.write_text(json.dumps({'state':'detached','scopeId':str(n),'databasePath':str(database),'databaseIdentity':{'dev':str(stat.st_dev),'ino':str(stat.st_ino)},'previousOwner':{'identity':'closed original owner'}}))
                plans.append({'version':1,'scopeId':str(n),'databasePath':str(database),'adoptionReceiptPath':str(receipt),'source':{'namespace':{'kind':'host'},'uid':os.getuid(),'gid':os.getgid()},'target':{'namespace':{'kind':'pinned','path':'declared'},'uid':os.getuid(),'gid':os.getgid()}})
            execute = lambda namespace, command, uid, gid, **kwargs: subprocess.run(command, check=True, capture_output=True, text=True).stdout
            with patch.object(adopt,'trusted',side_effect=lambda path:json.loads(path.read_text())), patch.object(adopt,'namespace_path'), patch.object(adopt,'enter',side_effect=execute) as entered:
                result = adopt.rebind_group({'version':1,'plans':plans})
                self.assertEqual(result['scopeCount'],2); self.assertEqual(entered.call_count,4)
                for plan in plans:
                    proof=json.loads(Path(plan['adoptionReceiptPath']).read_text())['namespaceRebinding']
                    self.assertEqual(proof['source']['files'],proof['target']['files'])
                    self.assertEqual(proof['retainedRunnerNamespace'],plan['source']['namespace'])
                changed={**plans[1],'source':{**plans[1]['source'],'uid':os.getuid()+1}}
                with self.assertRaisesRegex(ValueError,'share exact'):
                    adopt.rebind_many([plans[0],changed])

    def test_unregistered_cipher_is_not_an_adoption(self):
        with tempfile.TemporaryDirectory() as directory:
            plan, snapshots = self.fixture(directory)
            plan['cipherDir'] += '-different'
            with self.assertRaisesRegex(ValueError, 'owning encrypted-folder registry'):
                self.run_transfer(plan, snapshots * 2)
            self.assertFalse(Path(plan['adoptionReceiptPath']).exists())


if __name__ == '__main__': unittest.main()
