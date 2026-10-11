#!/usr/bin/python3 -B
from importlib.machinery import SourceFileLoader
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy'))
census = SourceFileLoader('native_census', str(ROOT / 'deploy/core-native-census')).load_module()


class NativeCensus(unittest.TestCase):
    def test_only_exact_uid_and_control_directory_bind_registered_storage(self):
        scope = {'id': 'fleet:owner', 'custody': {'uid': 1001, 'socketDir': '/registered', 'dataDir': '/data'}}
        self.assertEqual(census.match_scopes([scope], '/registered/thread-runners/original.sock', 1001), [scope])
        for control, uid in [('/registered-alias/thread-runners/original.sock', 1001), ('/registered/thread-runners/nested/other.sock', 1001), ('/registered/thread-runners/original.sock', 1002)]:
            self.assertEqual(census.match_scopes([scope], control, uid), [])

    def test_existing_status_is_read_only_and_never_exports_payload_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = str(Path(temporary) / 'control.sock')
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(path)
            listener.listen()
            requests = []
            def response():
                connection, _ = listener.accept()
                with connection:
                    requests.append(connection.recv(65536))
                    connection.sendall(json.dumps({'ok': True, 'pid': 44, 'sessions': 1, 'activeSessions': 1, 'threadIds': ['kept'], 'prompt': 'not metadata'}).encode()+b'\n')
            worker = threading.Thread(target=response)
            worker.start()
            result = subprocess.run(['/usr/bin/python3', '-B', '-c', census.STATUS, path], check=True, capture_output=True, text=True, timeout=2)
            worker.join(timeout=1)
            listener.close()
            self.assertEqual(requests, [b'{"type":"status"}\n'])
            self.assertEqual(json.loads(result.stdout), {'pid': 44, 'sessions': 1, 'activeSessions': 1, 'threadIds': ['kept']})


if __name__ == '__main__':
    unittest.main()
