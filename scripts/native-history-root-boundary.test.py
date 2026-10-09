#!/usr/bin/python3
import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('boundary', str(Path(__file__).parent.parent / 'deploy/native-history-root-boundary'))
spec = importlib.util.spec_from_loader(loader.name, loader)
boundary = importlib.util.module_from_spec(spec)
loader.exec_module(boundary)


class Host:
    pid = '1234'
    source = 'a' * 40
    evidence = {'childProcesses': 0}

    def __init__(self):
        self.calls = []

    def command(self, *args):
        self.calls.append(args)
        return self.pid if 'MainPID' in args else 'active'

    def health(self, role):
        return {'ok': True, 'releaseProtocol': 1, 'releaseCommit': self.source}

    def http(self, *args):
        raise AssertionError('Observation cannot change Root release state')

    def idle(self, pid):
        return self.evidence


class Tests(unittest.TestCase):
    def test_protocol_identity_and_durable_receipts_do_not_invent_an_admission_gate(self):
        host = Host()
        host.evidence = dict(host.evidence, rootSessions=7, pendingConsents=3, runtimeConnections=6)
        with patch.object(boundary, 'escaped_native_count', return_value=0):
            result = boundary.observe(host)
        self.assertTrue(result['ready'])
        self.assertFalse(result['admissionGated'])
        self.assertEqual(result['state'], 'observed-idle')
        self.assertEqual(result['executorState'], 'unobservable-readonly')
        self.assertFalse(any(call[:2] != ('systemctl', 'show') for call in host.calls))

    def test_native_or_declared_execution_activity_waits_without_mutating_root(self):
        for child, escaped, executing, consent in [(1, 0, 0, False), (0, 1, 0, False), (0, 0, 1, False), (0, 0, 0, True)]:
            with self.subTest(child=child, escaped=escaped, executing=executing, consent=consent):
                host = Host()
                host.evidence = {'childProcesses': child}
                host.health = lambda role: {'ok': True, 'releaseCommit': host.source, 'activeExecutions': executing, 'consentActive': consent}
                with patch.object(boundary, 'escaped_native_count', return_value=escaped):
                    result = boundary.observe(host)
                self.assertFalse(result['ready'])
                self.assertFalse(result['admissionGated'])
                self.assertEqual(result['state'], 'writers-retained')

    def test_partial_counters_are_an_explicit_error_not_idle(self):
        host = Host()
        host.health = lambda role: {'ok': True, 'releaseCommit': host.source, 'activeExecutions': 0}
        with patch.object(boundary, 'escaped_native_count', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'counters'):
                boundary.observe(host)


if __name__ == '__main__':
    unittest.main()
