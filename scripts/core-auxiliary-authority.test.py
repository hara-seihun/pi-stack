#!/usr/bin/env python3
from importlib.machinery import SourceFileLoader
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
assembly = SourceFileLoader('authority_assembly', str(Path(__file__).resolve().parents[1] / 'deploy/core-assemble')).load_module()


class AuxiliaryAuthority(unittest.TestCase):
    def fixture(self):
        directory = Path('/custody'); fragments = directory/'activation/final-schema'; overlay = fragments/'images-duties-authority-e4b3609f'
        scope = {'id': 'remote:person', 'principalId': 'person', 'resource': {'id': 'threads'}, 'availability': {'kind': 'adopt'}}
        values = {
            directory/'activation/core-config.projection.json': {'config': {'scopes': [scope]}},
            Path('/inputs'): {'version': 1, 'host': '127.0.0.1', 'port': 19181, 'statePath': '/state', 'releaseCommit': 'commit', 'runtimePath': '/runtime', 'scopeBindingsPath': '/bindings', 'auxiliaryPath': '/auxiliary'},
            fragments/'principals.json': [], fragments/'credentials.json': [],
            fragments/'policy.json': {'revision': 7, 'grants': [], 'consents': []},
            fragments/'gateway.fragment.json': {}, fragments/'callbacks.fragment.json': {'kind': 'none'},
            fragments/'provider.fragment.json': {'kind': 'configured'}, fragments/'root.fragment.json': {'kind': 'disabled'}, fragments/'memory.fragment.json': {'kind': 'disabled'},
            fragments/'scope-authority.json': {'scopes': [scope]}, fragments/'remote-bindings.json': {'scopeCallbackPatches': []},
            overlay/'image-authority.grants.json': {'newAuthorityGranted': False, 'grants': [{'id': 'images-original', 'principal': 'person', 'resource': {'kind': 'exact', 'id': 'images:person'}, 'actions': ['read','execute','use'], 'effect': 'allow'}], 'consents': []},
            overlay/'per-scope.fragment.json': {'scopes': [{'id': scope['id'], 'resourceDeclarationsToMerge': [{'path': '/registered/duties.md', 'kind': 'file'}]}]},
            Path('/runtime'): {'version': 1, 'uid': 0, 'gid': 0},
            Path('/bindings'): {'version': 1, 'scopes': [{'id': scope['id'], 'custody': {}, 'storage': {}, 'environment': {}, 'resources': []}]},
            Path('/auxiliary'): {'version': 1, 'scopes': [{'id': scope['id'], 'manager': {'kind': 'none'}, 'managerRouting': {'kind': 'none'}}], 'images': {'kind': 'configured', 'registries': ['actual']}, 'duties': {'kind': 'configured', 'entries': ['actual']}},
        }
        return directory, overlay, values

    def test_original_image_grants_and_duty_paths_reach_actual_config(self):
        directory, _, values = self.fixture(); captured = []
        with patch.object(assembly, 'read', side_effect=lambda path: values[Path(path)]), patch.object(assembly, 'publish', side_effect=lambda path, value: captured.append(value)):
            result = assembly.assemble(directory, Path('/inputs'), Path('/output'))
        self.assertEqual(result['state'], 'assembled'); config = captured[0]
        self.assertEqual(config['policy']['revision'], 7)
        self.assertEqual(config['policy']['grants'][0]['resource']['id'], 'images:person')
        self.assertEqual(config['scopes'][0]['resources'], [{'path': '/registered/duties.md', 'kind': 'file'}])
        self.assertEqual(values[Path('/bindings')]['scopes'][0]['resources'], [])

    def test_new_authority_and_path_kind_conflicts_never_publish(self):
        for variant in ['new-grant', 'path-conflict']:
            directory, overlay, values = self.fixture()
            if variant == 'new-grant': values[overlay/'image-authority.grants.json']['newAuthorityGranted'] = True
            else: values[Path('/bindings')]['scopes'][0]['resources'] = [{'path': '/registered/duties.md', 'kind': 'directory'}]
            with patch.object(assembly, 'read', side_effect=lambda path: values[Path(path)]), patch.object(assembly, 'publish') as publish:
                with self.assertRaises(ValueError): assembly.assemble(directory, Path('/inputs'), Path('/output'))
                publish.assert_not_called()


if __name__ == '__main__': unittest.main()
