from importlib.machinery import SourceFileLoader
from pathlib import Path
import copy
import os
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
bindings = SourceFileLoader('writer_bindings_test', str(Path(__file__).resolve().parents[1] / 'deploy/core-bindings')).load_module()
capture = SourceFileLoader('writer_capture_test', str(Path(__file__).resolve().parents[1] / 'deploy/core-aux-run')).load_module()


class WriterBindings(unittest.TestCase):
    def fixture(self):
        scopes = [{'id': name, 'custody': {'uid': uid, 'gid': uid, 'dataDir': data}, 'environment': {}, 'resources': []}
                  for name, uid, data in [('remote:first', 1001, '/private/first'), ('fleet:first', 1001, '/home/first/state'), ('root:existing', 974, '/private/root')]]
        return scopes, {'scopes': copy.deepcopy(scopes), 'root': {'kind': 'configured', 'consultationScopeId': 'root:existing', 'consultationOwners': []}}

    def test_source_scope_identity_and_physical_fences_are_distinct(self):
        scopes, config = self.fixture()
        result = bindings.writer_bindings(scopes, config)
        self.assertEqual(result[0]['environment']['PI_SESSION_WRITER_DIRECTORY'], '/run/pi-stack/session-writers/1001')
        self.assertEqual(result[0]['environment']['PI_SESSION_WRITER_SCOPE'], 'remote:first')
        self.assertEqual(result[1]['environment']['PI_SESSION_WRITER_SCOPE'], 'fleet:first')
        self.assertEqual(result[2]['environment']['PI_SESSION_WRITER_DIRECTORY'], '/run/pi-stack/session-writers/0')
        self.assertEqual(result[2]['environment']['PI_NATIVE_RUNNER_UID'], '0')
        self.assertEqual(result[0]['environment']['PI_NATIVE_RUNNER_DATA_DIR'], '/private/first')
        self.assertIn({'path': '/run/pi-stack/native-runner-locks/1001', 'kind': 'directory'}, result[0]['resources'])
        self.assertEqual(bindings.writer_bindings(copy.deepcopy(result), config), result)

    def test_binding_never_guesses_or_replaces_storage_or_uid(self):
        for change in ['uid', 'dataDir']:
            scopes, config = self.fixture()
            scopes[0]['custody'][change] = 0 if change == 'uid' else '/other/storage'
            with self.assertRaises(ValueError):bindings.writer_bindings(scopes, config)
        scopes, config = self.fixture()
        scopes[0]['resources'] = [{'path': '/run/pi-stack/session-writers/1001', 'kind': 'file'}]
        with self.assertRaises(ValueError):bindings.writer_bindings(scopes, config)

    def test_readonly_multi_scope_capture_does_not_inherit_a_session_writer(self):
        poison = {'PI_SESSION_WRITER_SCOPE': 'other-private-scope', 'PI_SESSION_WRITER_DIRECTORY': '/other', 'PI_THREAD_TOKEN': 'secret'}
        env = capture.capture_environment(os.getuid(), poison)
        self.assertEqual(set(env), {'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG'})
        self.assertFalse(any(key.startswith('PI_') for key in env))


if __name__ == '__main__':unittest.main()
