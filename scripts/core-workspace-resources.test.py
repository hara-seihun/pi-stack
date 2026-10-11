from importlib.machinery import SourceFileLoader
from pathlib import Path
import copy
import errno
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
bindings = SourceFileLoader('workspace_resources_test', str(Path(__file__).resolve().parents[1] / 'deploy/core-bindings')).load_module()


class WorkspaceResources(unittest.TestCase):
    def fixture(self):
        self.parent = '/person/work'
        self.checkout = self.parent + '/clones/task'
        self.records = [{'id': 'original-workspace', 'path': self.checkout, 'state': 'released'}]
        self.scope = {'id': 'remote:person', 'custody': {'uid': 1001, 'namespace': {'kind': 'host'}},
                      'storage': {'sessionsDir': '/person/state'}, 'environment': {},
                      'resources': [{'path': self.parent, 'kind': 'directory'}, {'path': self.checkout, 'kind': 'directory'}]}
        self.config = {'scopes': [self.scope]}
        return self.config

    def observe(self, scope, path):
        return {'error': errno.ENOENT} if path == self.checkout else {'kind': 'directory'}

    def test_captured_cwd_is_not_a_second_requirement_under_an_existing_grant(self):
        self.fixture()
        resources = self.scope['resources'] + [{'path': '/different/task', 'kind': 'directory'}, {'path': self.checkout + '/key', 'kind': 'file'}]
        selected = bindings.covered_directories(resources, {self.checkout, '/different/task'})
        self.assertNotIn(self.scope['resources'][1], selected)
        self.assertIn(resources[2], selected)
        self.assertIn(resources[3], selected)
        # Explicit storage/environment directories are not merely captured cwds.
        self.assertEqual(bindings.covered_directories(resources, set()), resources)

    def test_candidate_retires_only_released_absent_covered_directory(self):
        original = self.fixture()
        candidate, evidence = bindings.retired_workspace_resources(original, self.records, 1001, self.observe)
        self.assertEqual(candidate['scopes'][0]['resources'], [self.scope['resources'][0]])
        self.assertEqual(original['scopes'][0]['resources'], self.scope['resources'])
        self.assertEqual(evidence, [{'scopeId': self.scope['id'], 'path': self.checkout, 'workspaceId': 'original-workspace', 'state': 'released-and-absent'}])
        self.assertEqual(bindings.retired_workspace_resources(candidate, self.records, 1001, self.observe), (candidate, []))

    def test_related_same_owner_scopes_retire_together_but_other_owner_reference_refuses(self):
        config = self.fixture()
        sibling = copy.deepcopy(self.scope)
        sibling['id'] = 'fleet:person'
        config['scopes'].append(sibling)
        candidate, evidence = bindings.retired_workspace_resources(config, self.records, 1001, self.observe)
        self.assertEqual(len(evidence), 2)
        self.assertTrue(all(len(scope['resources']) == 1 for scope in candidate['scopes']))
        sibling['custody']['uid'] = 1002
        with self.assertRaises(ValueError): bindings.retired_workspace_resources(config, self.records, 1001, self.observe)

    def test_current_unknown_present_or_other_owner_is_not_retired(self):
        config = self.fixture()
        for records, uid, observe in [([], 1001, self.observe), ([{**self.records[0], 'state': 'active'}], 1001, self.observe),
                                      (self.records, 1002, self.observe), (self.records, 1001, lambda *_: {'kind': 'directory'})]:
            self.assertEqual(bindings.retired_workspace_resources(config, records, uid, observe), (config, []))

    def test_missing_ancestor_or_required_consumer_is_an_error(self):
        config = self.fixture()
        cases = []
        missing_grant = copy.deepcopy(config)
        missing_grant['scopes'][0]['resources'].pop(0)
        cases.append(missing_grant)
        for field in ['storage', 'environment']:
            required = copy.deepcopy(config)
            required['scopes'][0][field]['required'] = self.checkout + '/required'
            cases.append(required)
        required_file = copy.deepcopy(config)
        required_file['scopes'][0]['resources'].append({'path': self.checkout + '/key', 'kind': 'file'})
        cases.append(required_file)
        for value in cases:
            with self.assertRaises(ValueError): bindings.retired_workspace_resources(value, self.records, 1001, self.observe)
        with self.assertRaises(ValueError):
            bindings.retired_workspace_resources(config, self.records, 1001, lambda *_: {'error': errno.ENOENT})
        with self.assertRaises(ValueError):
            bindings.retired_workspace_resources(config, self.records, 1001, lambda *_: {'error': errno.EACCES})

    def test_finite_command_reads_registry_and_writes_only_separate_candidate(self):
        config = self.fixture()
        with tempfile.TemporaryDirectory() as root:
            source, output, registry = (Path(root) / name for name in ['config.json', 'candidate.json', 'registry.sqlite3'])
            config['scopes'][0]['custody']['uid'] = os.getuid()
            source.write_text('original source fixture')
            with sqlite3.connect(registry) as database:
                database.execute('CREATE TABLE workspace(id TEXT,path TEXT,state TEXT)')
                database.execute('INSERT INTO workspace VALUES(?,?,?)', tuple(self.records[0].values()))
            registry.chmod(0o600)
            with patch.object(bindings, 'trusted', return_value=config), patch.object(bindings, 'publish') as publish, \
                 patch('core_namespace.namespace_path', return_value=Path('/proc/self/ns/mnt')), \
                 patch.object(bindings.subprocess, 'run') as run:
                import json
                run.side_effect = lambda _args, **kw: type('Response', (), {'stdout': json.dumps({path: self.observe(None, path) for path in json.loads(kw['input'])})})()
                receipt = bindings.reconcile_workspace_resources(source, registry, output)
                self.assertFalse(receipt['liveEffects'])
                self.assertEqual(len(receipt['retiredResources']), 1)
                self.assertEqual(publish.call_args.args[0], output)
                self.assertEqual(publish.call_args.args[1]['scopes'][0]['resources'], [self.scope['resources'][0]])
                with self.assertRaises(ValueError): bindings.reconcile_workspace_resources(source, registry, source)
                with self.assertRaises(ValueError): bindings.reconcile_workspace_resources(source, registry, Path('/etc/pi-stack/core.json'))
                def changed_source(_args, **kw):
                    source.write_text('changed source')
                    return type('Response', (), {'stdout': json.dumps({path: self.observe(None, path) for path in json.loads(kw['input'])})})()
                run.side_effect = changed_source
                with self.assertRaisesRegex(ValueError, 'source configuration changed'):
                    bindings.reconcile_workspace_resources(source, registry, output)
                registry.write_text('not a database')
                with self.assertRaises(sqlite3.Error): bindings.reconcile_workspace_resources(source, registry, output)


if __name__ == '__main__': unittest.main()
