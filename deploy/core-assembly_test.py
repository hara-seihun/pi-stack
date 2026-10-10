import copy
import hashlib
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

    def test_related_callback_preserves_original_owner_and_gateway_floor(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)/'server.ts'; source.write_text('new ThreadDirectory(person, fleet)')
            resource = {'owner':'person','subjects':['person'],'privacy':'private'}
            target = {'id':'remote:person','principalId':'person','resource':resource,'custody':{'uid':10,'gid':10}}
            fleet = {**target,'id':'fleet:person'}
            binding = {'custody':{'uid':10,'gid':10},'callbackGateway':{'kind':'shared-remote-callback','targetScopeId':target['id'],'peerUid':10},'callbackEvidence':{'kind':'original-related-thread-directory','sourcePath':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'targetScopeId':target['id']}}
            self.assertEqual(assembly.related_callback(binding, fleet, target),binding['callbackGateway'])
            original = [{'gatewayId':'person','peerUid':10,'scopeIds':[target['id']],'routeCeiling':[]}]
            overlay=copy.deepcopy(original);overlay[0]['scopeIds'].append(fleet['id']);overlay[0]['routeCeiling'].append({'method':'GET','kind':'exact','path':'/v1/scopes/fleet:person/projection'})
            self.assertEqual(assembly.gateway_overlay(original,{'version':1,'gatewayBindings':overlay},{fleet['id']:binding},{fleet['id']:fleet,target['id']:target}),overlay)
            overlay[0]['routeCeiling'].append({'method':'POST','kind':'prefix','path':'/v1/root/'})
            with self.assertRaises(ValueError):assembly.gateway_overlay(original,{'version':1,'gatewayBindings':overlay},{fleet['id']:binding},{fleet['id']:fleet,target['id']:target})
            with self.assertRaises(ValueError):assembly.related_callback(binding,fleet,{**target,'principalId':'other'})
            source.write_text('changed')
            with self.assertRaises(ValueError):assembly.related_callback(binding,fleet,target)

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
