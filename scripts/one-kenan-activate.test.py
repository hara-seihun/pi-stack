#!/usr/bin/python3
import hashlib
import http.server
import json
import pathlib
import runpy
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

module = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1]/'deploy/one-kenan-activate'))
activate, activate_rooms, prove, check, Deferred = [module[name] for name in ['activate', 'activate_rooms', 'prove', 'check', 'Deferred']]

class Host:
    expected = 'new'
    def __init__(self, *, protocol=1, busy=False, selected=False, fail=None, migration=False):
        self.protocol, self.busy, self.fail = protocol, busy, fail
        self.commits = {role: 'new' if selected else 'old' for role in ['root','memory','rooms']}
        self.calls = []
        self.gated = False
        self.migration = migration
    def command(self, *args):
        self.calls.append(args)
        if args[1] == 'show':
            return 'loaded' if 'LoadState' in args else '123'
        if args[1] == 'is-active': return 'active'
        if args[1] == 'restart':
            role = next(role for role, unit in module['UNITS'].items() if unit == args[-1])
            if self.fail == role: raise RuntimeError('failed restart')
            self.commits[role] = 'new'
        if args[1] in ['reload', 'kill']: self.commits['rooms'] = 'new'
        return ''
    def health(self, role):
        return {'ok': True, 'releaseCommit': self.commits[role], 'releaseProtocol': self.protocol}
    def http(self, role, path, method='GET'):
        self.calls.append((method, path))
        if method == 'POST':
            if self.busy: return 409, {}
            self.gated = True
        else: self.gated = False
        return 200, {}
    def ready(self, role, previous_pid=None):
        self.calls.append(('ready', role, previous_pid))
        return self.health(role)
    def install_memory_drain(self):
        self.calls.append(('memory-drain',))
    def install_room_launcher(self):
        self.calls.append(('room-launcher',))
        return 'fixture-dropin', '123' if self.migration else None
    def finish_room_migration(self, migration):
        self.calls.append(('room-migration-finished',))

class HTTPProbes(unittest.TestCase):
    def setUp(self):
        self.responses = []
        self.fallback = 'reset'
        self.requests = 0
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests += 1
                outcome = owner.responses.pop(0) if owner.responses else owner.fallback
                if outcome in ['reset', 'disconnect']:
                    if outcome == 'reset':
                        self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                    self.close_connection = True
                    self.connection.close()
                    return
                data = b'{"ok":' if outcome == 'truncated' else b'{"ok":true,"releaseCommit":"' + outcome.encode() + b'"}'
                self.send_response(200)
                self.send_header('Content-Length', str(len(data) + (10 if outcome == 'truncated' else 0)))
                self.end_headers()
                self.wfile.write(data)
            def log_message(self, *args): pass
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01))
        self.thread.start()
        self.host = module['Host']({role + 'Port': self.server.server_port for role in module['UNITS']}, 'new')
        self.host.deadline = time.monotonic() + 2
    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()
    def test_ready_survives_real_reset_disconnect_and_truncated_response(self):
        self.responses = ['reset', 'disconnect', 'truncated', 'old', 'new']
        self.assertEqual(self.host.ready('rooms')['releaseCommit'], 'new')
        self.assertEqual(self.requests, 5, 'unavailable and stale listeners must not prove readiness')
    def test_persistent_resets_defer_at_deadline_without_service_commands(self):
        self.host.deadline = time.monotonic() + .25
        with patch.object(self.host, 'command') as command:
            with self.assertRaises(Deferred): self.host.ready('rooms')
            command.assert_not_called()
        self.assertGreater(self.requests, 0)
    def test_reset_cannot_prove_a_release(self):
        with patch.object(self.host, 'command', return_value='active'):
            with self.assertRaisesRegex(RuntimeError, 'running release'): prove(self.host)
    def test_raw_urlopen_errors_are_unavailable_and_http_status_is_retained(self):
        errors = [ConnectionResetError(104, 'Connection reset by peer'),
                  http.client.RemoteDisconnected(), http.client.IncompleteRead(b'partial', 10)]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                with patch.object(module['urllib'].request, 'urlopen', side_effect=error):
                    self.assertEqual(self.host.http('rooms', '/v1/health'), (0, {}))
        error = module['urllib'].error.HTTPError('http://fixture', 409, 'busy', {}, None)
        with patch.object(module['urllib'].request, 'urlopen', side_effect=error):
            self.assertEqual(self.host.http('rooms', '/v1/health'), (409, {}))

class MigrationHost(Host):
    def __init__(self, *, evidence=None, frozen_evidence=None, **kwargs):
        super().__init__(protocol=None, **kwargs)
        self.evidence = evidence or {}
        self.frozen_evidence = frozen_evidence
        self.frozen = False
    def validate_migration(self, args):
        self.calls.append(('validate',))
        return '123'
    def fence(self): self.calls.append(('fence',))
    def unfence(self): self.calls.append(('unfence',))
    def freeze(self):
        self.calls.append(('freeze',))
        self.frozen = True
        if self.fail == 'freeze': raise RuntimeError('failed freeze')
    def thaw(self):
        self.calls.append(('thaw',))
        self.frozen = False
    def idle(self, pid):
        self.calls.append(('idle', pid))
        return self.frozen_evidence if self.frozen and self.frozen_evidence is not None else self.evidence
    def ready(self, role, previous_pid=None):
        if role == 'root': self.protocol = 1
        return super().ready(role, previous_pid)

class Migration(unittest.TestCase):
    def migrate(self, host): return module['migrate'](host, types.SimpleNamespace())
    def test_nonzero_evidence_never_freezes_or_restarts(self):
        for key in ['rootSessions', 'pendingConsents', 'listenerConnections', 'runtimeConnections', 'childProcesses']:
            host = MigrationHost(evidence={key: 1})
            with self.assertRaisesRegex(Deferred, key): self.migrate(host)
            self.assertNotIn(('freeze',), host.calls)
            self.assertFalse(any(call[:2] == ('systemctl', 'restart') for call in host.calls))
            self.assertEqual(host.calls[-1], ('unfence',))
    def test_work_racing_the_freeze_is_preserved_and_gate_removed(self):
        host = MigrationHost(frozen_evidence={'rootSessions': 1})
        with self.assertRaisesRegex(Deferred, 'before freeze'): self.migrate(host)
        self.assertEqual(host.calls[-2:], [('thaw',), ('unfence',)])
        self.assertFalse(any(call[:2] == ('systemctl', 'restart') for call in host.calls))
    def test_frozen_idle_migration_preserves_dependency_order_and_proves(self):
        host = MigrationHost()
        result = self.migrate(host)
        self.assertTrue(result['enabled'])
        self.assertEqual([c[-1] for c in host.calls if c[:2] == ('systemctl','restart')], ['pi-kenan-memory.service','pi-kenan-root.service'])
        self.assertLess(host.calls.index(('freeze',)), host.calls.index(('memory-drain',)))
        self.assertLess(host.calls.index(('ready','memory','123')), host.calls.index(('thaw',)))
        self.assertEqual(host.calls[-1], ('unfence',))
        self.assertFalse(any('custody' in ' '.join(map(str, c)) for c in host.calls))
    def test_failed_activation_always_thaws_and_unfences_without_success(self):
        for failure in ['freeze', 'memory', 'root']:
            host = MigrationHost(fail=failure)
            with self.assertRaisesRegex(RuntimeError, 'failed'): self.migrate(host)
            self.assertFalse(host.frozen)
            self.assertIn(('thaw',), host.calls)
            self.assertEqual(host.calls[-1], ('unfence',))
    def test_source_validation_follows_release_root_not_shared_package_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            commit = module['MIGRATION_SOURCE']
            for role in ['remote', 'runtime']:
                (base/role/'selected').mkdir(parents=True)
                (base/role/commit).mkdir()
                (base/('current-' + role)).symlink_to(base/role/'selected', target_is_directory=True)
            relative = 'kenan-root/src/main.ts'
            source = base/'remote'/commit/relative
            source.parent.mkdir(parents=True); source.write_text('public source')
            dependency = base/'dependencies/kenan-memory'; dependency.mkdir(parents=True)
            (dependency/'src').mkdir(); (dependency/'src/main.ts').write_text('public source')
            for release in [commit, 'selected']:
                modules = base/'runtime'/release/'node_modules'; modules.mkdir()
                (modules/'kenan-memory').symlink_to(dependency, target_is_directory=True)
            class InspectHost(module['Host']):
                def command(self, *args): return '123'
                def health(self, role): return {'ok': True}
            host = InspectHost({'remoteRoot': str(base/'current-remote'), 'memoryRuntime': str(base/'current-runtime/node_modules/kenan-memory')}, 'new')
            args = types.SimpleNamespace(preprotocol_commit=commit, preprotocol_pid=123)
            digest = hashlib.sha256(b'public source').hexdigest()
            with patch.dict(InspectHost.validate_migration.__globals__, {'MIGRATION_HASHES': {'remote/' + relative: digest, 'runtime/src/main.ts': digest}}):
                self.assertEqual(host.validate_migration(args), '123')
                args.preprotocol_pid = 124
                with self.assertRaisesRegex(Deferred, 'PID changed'): host.validate_migration(args)
                args.preprotocol_pid = 123; source.write_text('different contract')
                with self.assertRaisesRegex(RuntimeError, 'idle contract'): host.validate_migration(args)

    def test_sqlite_probe_returns_only_counts_and_never_creates_missing_store(self):
        with tempfile.TemporaryDirectory() as directory:
            memory, consent = [str(pathlib.Path(directory)/name) for name in ['memory.db', 'consent.db']]
            for path, sql in [(memory, "CREATE TABLE sessions(role TEXT, token TEXT); INSERT INTO sessions VALUES('root','not-for-output')"), (consent, "CREATE TABLE root_consent(state TEXT, data TEXT); INSERT INTO root_consent VALUES('waiting','not-for-output')")]:
                with sqlite3.connect(path) as db: db.executescript(sql)
            result = subprocess.run([sys.executable, '-c', module['IDLE_QUERY'], memory, consent], capture_output=True, text=True, timeout=2, check=True)
            self.assertEqual(json.loads(result.stdout), {'rootSessions': 1, 'pendingConsents': 1})
            self.assertNotIn('not-for-output', result.stdout)
            missing = str(pathlib.Path(directory)/'missing.db')
            result = subprocess.run([sys.executable, '-c', module['IDLE_QUERY'], memory, missing], capture_output=True, text=True, timeout=2)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout), {'error': 'Idle metadata unavailable'})
            self.assertFalse(pathlib.Path(missing).exists())

class Activation(unittest.TestCase):
    def test_legacy_root_and_busy_root_never_restart(self):
        for host in [Host(protocol=None), Host(busy=True)]:
            with self.assertRaises(Deferred): activate(host)
            self.assertFalse(any(call[0] == 'systemctl' and call[1] in ['restart','reload'] for call in host.calls))
            self.assertFalse(host.gated)
    def test_stale_consumers_activate_in_dependency_order_and_prove_running_release(self):
        host = Host(migration=True)
        result = activate(host)
        self.assertTrue(result['enabled'])
        self.assertEqual([call[-1] for call in host.calls if call[:2] == ('systemctl','restart')], ['pi-kenan-memory.service','pi-kenan-root.service'])
        self.assertIn(('systemctl','kill','--kill-whom=main','--signal=SIGUSR2','pi-rooms.service'), host.calls)
        self.assertIn(('ready','rooms','123'), host.calls, 'first migration must wait for a new main PID, even when commit is unchanged')
        self.assertFalse(host.gated)
        self.assertFalse(any('custody' in ' '.join(call) for call in host.calls))
    def test_selected_markers_cannot_prove_stale_processes(self):
        host = Host()
        with self.assertRaisesRegex(RuntimeError, 'running release'): prove(host)
        self.assertFalse(any(call[0] in ['POST','DELETE'] for call in host.calls))
    def test_unchanged_consumers_do_not_restart(self):
        host = Host(selected=True)
        activate(host)
        self.assertFalse(any(call[0] == 'systemctl' and call[1] in ['restart','reload'] for call in host.calls))
    def test_supervised_room_handoff_uses_reload_not_a_service_restart(self):
        host = Host()
        activate_rooms(host)
        self.assertIn(('systemctl','reload','--no-block','pi-rooms.service'), host.calls)
        self.assertFalse(any(call[:2] in [('systemctl','restart'), ('systemctl','kill')] for call in host.calls))
    def test_first_room_wrapper_migration_waits_for_new_pid_on_unchanged_commit(self):
        host = Host(selected=True, migration=True)
        activate(host)
        self.assertIn(('ready','rooms','123'), host.calls)
    def test_room_only_handoff_does_not_touch_legacy_root_or_memory(self):
        host = Host(protocol=None, migration=True)
        result = activate_rooms(host)
        self.assertEqual(list(result['consumers']), ['rooms'])
        self.assertIn(('ready','rooms','123'), host.calls)
        self.assertFalse(any(call[0] in ['POST','DELETE'] or 'pi-kenan-root.service' in call or 'pi-kenan-memory.service' in call for call in host.calls))
    def test_failed_activation_releases_root_gate_and_never_claims_success(self):
        host = Host(fail='memory')
        with self.assertRaisesRegex(RuntimeError, 'failed restart'): activate(host)
        self.assertFalse(host.gated)
        self.assertIn(('DELETE','/v1/admin/release'), host.calls)
        self.assertFalse(any(call[:2] == ('systemctl','reload') for call in host.calls))

def network_rehearsal():
    # Run ONLY inside a disposable network namespace, never the live host network.
    if pathlib.Path('/proc/self/ns/net').stat().st_ino == pathlib.Path('/proc/1/ns/net').stat().st_ino:
        raise RuntimeError('Use sudo unshare --net -- python3 scripts/one-kenan-activate.test.py --network-rehearsal')
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True, timeout=2)
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            data = b'{"ok":true,"releaseCommit":"fixture"}'
            self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        def log_message(self, *args): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    host = module['Host']({'rootPort': port}, 'fixture')
    accepted = socket.create_connection(('127.0.0.1', port), timeout=2)
    try:
        host.fence()
        accepted.sendall(b'GET /v1/health HTTP/1.0\r\nHost: localhost\r\n\r\n')
        assert b'200' in accepted.recv(1024), 'accepted requests must survive the SYN fence'
        assert host.health('root')['releaseCommit'] == 'fixture', 'marked administrator health must pass'
        unmarked = module['Host']({'rootPort': port}, 'fixture')
        assert unmarked.health('root') == {}, 'new unmarked admission must be rejected'
        host.unfence()
        assert unmarked.health('root')['ok'] is True, 'cleanup must restore admission'
        print('Network rehearsal passed: accepted request preserved, new admission rejected, marked health admitted, cleanup restored admission')
    finally:
        accepted.close()
        if host.mark is not None: host.unfence()
        server.shutdown(); server.server_close()

if __name__ == '__main__':
    if sys.argv[1:] == ['--network-rehearsal']: network_rehearsal()
    else: unittest.main()
