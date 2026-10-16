#!/usr/bin/python3 -B
"""Real kernel socket errors preserve absence without erasing custody failures."""
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

BRIDGE = Path(__file__).resolve().parents[1] / 'src/core/custody-bridge.py'


class SocketAbsence(unittest.TestCase):
    def invoke(self, operation, target):
        return subprocess.run([sys.executable, '-B', str(BRIDGE), operation, str(target)],
                              input='', capture_output=True, text=True, timeout=2)

    def error_code(self, target):
        result = self.invoke('socket', target)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        return json.loads(result.stderr)['code']

    def test_absent_path_is_enoent_but_observations_keep_their_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / 'absent.sock'
            self.assertEqual(self.error_code(missing), 'ENOENT')
            self.assertEqual(json.loads(self.invoke('stat', missing).stdout), None)
            self.assertEqual(json.loads(self.invoke('entries', missing).stdout), [])

    def test_closed_socket_is_connection_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'closed.sock'
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                peer.bind(str(target))
            self.assertEqual(self.error_code(target), 'ECONNREFUSED')

    def test_existing_wrong_type_and_alias_are_not_absence(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'file'
            target.write_text('retained')
            self.assertEqual(self.error_code(target), 'ENOTSOCK')
            alias = Path(directory) / 'alias'
            alias.symlink_to(Path(directory) / 'absent.sock')
            self.assertEqual(self.error_code(alias), 'RESOURCE_UNAVAILABLE')
            self.assertEqual(target.read_text(), 'retained')

    def test_connected_socket_retains_handshake_and_clean_eof(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'live.sock'
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                peer.bind(str(target))
                peer.listen(1)
                result = self.invoke('socket', target)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout), {'connected': True})
                self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
