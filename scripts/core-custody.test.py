#!/usr/bin/env python3
import copy
from importlib.machinery import SourceFileLoader
from pathlib import Path
import sys
import unittest
import stat
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
keeper = SourceFileLoader('core_keeper', str(Path(__file__).resolve().parents[1] / 'deploy/core-custody')).load_module()
activation = SourceFileLoader('core_activation', str(Path(__file__).resolve().parents[1] / 'deploy/core-person-activate')).load_module()


class ResourceAdditions(unittest.TestCase):
    def setUp(self):
        self.original = {'version': 1, 'namespaceId': 'common', 'resources': [{'path': '/registered/config', 'kind': 'file', 'namespace': {'kind': 'host'}}],
                         'generations': [{'mountpoint': '/private/first', 'user': 'first', 'keyFile': '/key/first'}]}

    def test_addition_preserves_registered_resources_and_namespace(self):
        candidate = copy.deepcopy(self.original)
        candidate['generations'].append({'mountpoint': '/private/second', 'user': 'second', 'keyFile': '/key/second'})
        result = keeper.additions(self.original, candidate)
        self.assertEqual(result['resources'], [])
        self.assertEqual(result['generations'], [candidate['generations'][1]])
        self.assertEqual(keeper.additions(candidate, candidate), {'resources': [], 'generations': []})

    def test_removal_rebinding_and_covering_existing_mount_are_rejected(self):
        candidates = []
        for key in ['resources', 'generations']:
            candidate = copy.deepcopy(self.original); candidate[key] = []; candidates.append(candidate)
        candidate = copy.deepcopy(self.original); candidate['namespaceId'] = 'replacement'; candidates.append(candidate)
        candidate = copy.deepcopy(self.original); candidate['generations'][0]['keyFile'] = '/another/key'; candidates.append(candidate)
        candidate = copy.deepcopy(self.original); candidate['generations'].append({'mountpoint': '/private', 'user': 'second'}); candidates.append(candidate)
        for candidate in candidates:
            with self.assertRaises(ValueError):
                keeper.additions(self.original, candidate)

    def test_owner_only_systemd_credential_may_have_root_group(self):
        namespace = {'kind': 'pinned', 'path': '/run/pi-stack/namespaces/source', 'mountNamespaceInode': '42'}
        generation = {'user': 'second', 'uid': 1002, 'gid': 1005, 'sourceNamespace': namespace,
                      'keySource': {'kind': 'systemd-credential', 'path': '/run/credentials/pi-remote@second.service/key', 'namespace': namespace}}
        with patch.object(keeper, 'resource_handle', return_value=(17, 0, 0)), patch.object(keeper.os, 'fstat', return_value=SimpleNamespace(st_uid=1002, st_gid=0, st_mode=stat.S_IFREG | 0o400)):
            self.assertEqual(keeper.key_handle(generation), 17)
        for uid, mode in [(1003, 0o400), (1002, 0o440), (1002, 0o404)]:
            with patch.object(keeper, 'resource_handle', return_value=(17, 0, 0)), patch.object(keeper.os, 'fstat', return_value=SimpleNamespace(st_uid=uid, st_gid=0, st_mode=stat.S_IFREG | mode)), patch.object(keeper.os, 'close'):
                with self.assertRaises(ValueError):
                    keeper.key_handle(generation)

    def test_remote_unit_identity_is_its_actual_user_not_root(self):
        class Result:
            stdout = '42\n'
        class Metadata:
            st_uid = 1002
        with patch.object(activation.subprocess, 'run', return_value=Result()), patch.object(Path, 'stat', return_value=Metadata()):
            self.assertEqual(activation.unit_pid('pi-remote@second.service', 1002), 42)
            with self.assertRaises(ValueError):
                activation.unit_pid('pi-stack-core.service')


if __name__ == '__main__':
    unittest.main()
