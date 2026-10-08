#!/usr/bin/python3
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('boundary', str(Path(__file__).parent.parent / 'deploy/native-history-root-boundary'))
spec = importlib.util.spec_from_loader(loader.name, loader)
boundary = importlib.util.module_from_spec(spec)
loader.exec_module(boundary)


class Host:
    pid = '1234'
    source = 'a' * 40
    status = 200
    evidence = {'rootSessions': 0, 'pendingConsents': 0, 'listenerConnections': 0, 'runtimeConnections': 0, 'childProcesses': 0}

    def __init__(self):
        self.calls = []

    def command(self, *args):
        return self.pid if 'MainPID' in args else 'active'

    def health(self, role):
        return {'ok': True, 'releaseProtocol': 1, 'releaseCommit': self.source}

    def http(self, role, path, method):
        self.calls.append(method)
        return self.status, {'ok': True, 'quiescing': method == 'POST'}

    def idle(self, pid):
        return self.evidence


class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        boundary.JOURNAL = Path(self.temporary.name) / 'root.json'
        self.host = Host()
        self.census = patch.object(boundary, 'escaped_native_count', return_value=0)
        self.census.start()

    def tearDown(self):
        self.census.stop()
        self.temporary.cleanup()

    def test_probe_is_readonly(self):
        result = boundary.transition(self.host, 'b' * 40, probe=True)
        self.assertTrue(result['ready'])
        self.assertTrue(result['requiresAtomicGate'])
        self.assertFalse(result['admissionGated'])
        self.assertEqual(result['state'], 'probe-atomic-gate-required')
        self.assertFalse(boundary.JOURNAL.exists())
        self.assertEqual(self.host.calls, [])

    def test_probe_does_not_wait_forever_on_durable_custody(self):
        self.host.evidence = dict(self.host.evidence, rootSessions=7, pendingConsents=3, runtimeConnections=6)
        result = boundary.transition(self.host, 'b' * 40, probe=True)
        self.assertTrue(result['ready'])
        self.assertEqual(result['executorState'], 'unobservable-readonly')
        self.assertTrue(result['requiresAtomicGate'])
        self.assertEqual(self.host.calls, [])
        self.assertFalse(boundary.JOURNAL.exists())

    def test_probe_obeys_declared_live_executor_counters(self):
        self.host.health = lambda role: {'ok': True, 'releaseProtocol': 1, 'releaseCommit': self.host.source, 'activeExecutions': 1, 'consentActive': False}
        self.assertFalse(boundary.transition(self.host, 'b' * 40, probe=True)['ready'])
        self.assertEqual(self.host.calls, [])

    def test_busy_does_not_gate_or_cancel(self):
        self.host.status = 409
        result = boundary.transition(self.host, 'b' * 40)
        self.assertFalse(result['ready'])
        self.assertEqual(self.host.calls, ['POST'])
        self.assertEqual(json.loads(boundary.JOURNAL.read_text())['phase'], 'restored')

    def test_pending_consent_and_idle_http_custody_are_preserved_not_writers(self):
        self.host.evidence = dict(self.host.evidence, rootSessions=7, pendingConsents=3, runtimeConnections=6)
        result = boundary.transition(self.host, 'b' * 40)
        self.assertTrue(result['ready'])
        self.assertTrue(result['admissionGated'])
        self.assertEqual(result['evidence']['pendingConsents'], 3)
        self.assertEqual(self.host.calls, ['POST'])

    def test_owned_gate_precedes_writers_proof_and_retains_busy_children(self):
        self.host.evidence = dict(self.host.evidence, childProcesses=1)
        def idle(pid):
            self.assertEqual(json.loads(boundary.JOURNAL.read_text())['phase'], 'gated')
            return self.host.evidence
        self.host.idle = idle
        self.assertFalse(boundary.transition(self.host, 'b' * 40)['ready'])
        self.assertEqual(self.host.calls, ['POST'])
        self.assertEqual(json.loads(boundary.JOURNAL.read_text())['phase'], 'gated')

    def test_restore_never_clears_another_generation(self):
        boundary.transition(self.host, 'b' * 40)
        self.host.pid = '5678'
        result = boundary.transition(self.host, 'b' * 40, restore=True)
        self.assertEqual(result['state'], 'old-generation-ended')
        self.assertEqual(self.host.calls, ['POST'])

    def test_other_candidate_cannot_own_existing_gate(self):
        boundary.transition(self.host, 'b' * 40)
        with self.assertRaisesRegex(RuntimeError, 'Another candidate'):
            boundary.transition(self.host, 'c' * 40)
        self.assertEqual(self.host.calls, ['POST'])


if __name__ == '__main__':
    unittest.main()
