#!/usr/bin/env python3
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
epoch = SourceFileLoader('epoch', str(Path(__file__).resolve().parents[1] / 'deploy/core-capability-epoch.py')).load_module()
adopt = SourceFileLoader('adopt', str(Path(__file__).resolve().parents[1] / 'deploy/core-adopt')).load_module()


class Epoch(unittest.TestCase):
    def execute(self, program, value):
        return subprocess.run([sys.executable, '-c', program, json.dumps(value)], text=True, capture_output=True, timeout=3)

    def test_unsettled_execution_is_not_an_epoch_proof(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, 'threads.sqlite3'); db = sqlite3.connect(path)
            db.executescript("CREATE TABLE thread_execution(id,thread_id,ended_at,outcome); CREATE TABLE thread(id,metadata); INSERT INTO thread_execution VALUES('execution','thread',NULL,NULL);"); db.close()
            result = self.execute(epoch.SNAPSHOT, {'databasePath': str(path)})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('has not settled', result.stderr)

    def test_positive_native_close_and_foreign_thread_rejection(self):
        for foreign in [False, True]:
            with tempfile.TemporaryDirectory() as root:
                base = Path(root); (base/'thread-runners').mkdir(); (base/'thread-sockets').mkdir()
                control = base/'thread-runners'/('a'*16+'.sock'); server = socket.socket(socket.AF_UNIX); server.bind(str(control)); server.listen()
                state = {'threads': ['foreign' if foreign else 'thread'], 'commands': []}; stopped = threading.Event()
                def serve():
                    while not stopped.is_set():
                        server.settimeout(0.2)
                        try: connection, _ = server.accept()
                        except socket.timeout: continue
                        with connection:
                            raw = b''
                            while b'\n' not in raw: raw += connection.recv(4096)
                            value = json.loads(raw); state['commands'].append(value['type'])
                            if value['type'] == 'close': state['threads'] = []
                            response = {'ok': True, 'pid': os.getpid()}
                            if value['type'] == 'status': response.update(sessions=len(state['threads']), activeSessions=0, threadIds=state['threads'])
                            connection.sendall((json.dumps(response)+'\n').encode())
                worker = threading.Thread(target=serve); worker.start()
                try:
                    result = self.execute(epoch.RELEASE, {'socketDir': root, 'keyPath': root+'/key', 'threads': [{'id': 'thread', 'reference': None}]})
                    if foreign:
                        self.assertNotEqual(result.returncode, 0); self.assertEqual(state['commands'], ['status'])
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(state['commands'], ['status','close','status'])
                        self.assertEqual(json.loads(result.stdout)['generations'][0]['after']['sessions'], 0)
                finally: stopped.set(); worker.join(); server.close()

    def test_existing_key_never_replaced_and_owner_parent_is_registered(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root); database = base/'threads.sqlite3'; database.touch(); key = base/'state'/'pi-stack'/'key'
            command = [sys.executable, '-c', adopt.KEY_INITIALIZATION, str(key), 'create', str(database), str(base)]
            first = subprocess.run(command, capture_output=True, text=True, timeout=3)
            self.assertEqual(first.returncode, 0, first.stderr); original = key.read_bytes()
            second = subprocess.run(command, capture_output=True, text=True, timeout=3)
            self.assertNotEqual(second.returncode, 0); self.assertEqual(key.read_bytes(), original)
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)
            self.assertEqual(key.parent.stat().st_mode & 0o777, 0o700)

    def test_epoch_identity_and_full_owner_cohort_are_mandatory(self):
        proof = {'version': 1, 'protocol': 'pi-core-capability-epoch-drained-v1', 'state': 'drained', 'uid': 1007, 'gid': 1010, 'priorKeyPath': '/registered/key', 'owners': [{'scopeId': 'person'}]}
        for change in [{'uid': 1008}, {'keyPath': '/elsewhere/key'}, {'ownerScopeIds': ['person','fleet']}]:
            plan = {'uid': 1007, 'gid': 1010, 'keyPath': '/registered/key', 'ownerScopeIds': ['person'], **change}
            with self.assertRaises(ValueError): epoch.validate(proof, plan)


if __name__ == '__main__': unittest.main()
