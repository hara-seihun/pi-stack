#!/usr/bin/python3
import http.client
import http.server
import pathlib
import runpy
import socket
import struct
import threading
import time
import unittest
from unittest.mock import patch

module = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1]/'deploy/one-kenan-activate'))
activate, activate_rooms, prove, Deferred = [module[name] for name in ['activate', 'activate_rooms', 'prove', 'Deferred']]


class Host:
    expected = 'new'

    def __init__(self, *, protocol=2, busy=False, selected=False, fail=None, migration=False):
        self.protocol, self.busy, self.fail = protocol, busy, fail
        self.commits = {role: 'new' if selected else 'old' for role in ['root', 'memory', 'rooms']}
        self.calls = []
        self.paused = False
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
            if role == 'root': self.protocol = 2; self.paused = False
        if args[1] in ['reload', 'kill']: self.commits['rooms'] = 'new'
        return ''

    def health(self, role):
        return {'ok': True, 'releaseCommit': self.commits[role], 'releaseProtocol': self.protocol}

    def http(self, role, path, method='GET'):
        self.calls.append((method, path))
        if method == 'POST':
            if self.busy: return 409, {}
            self.paused = True
        else: self.paused = False
        return 200, {'ok': True, 'quiescing' if self.protocol == 1 else 'dispatchPaused': self.paused}

    def ready(self, role, previous_pid=None):
        self.calls.append(('ready', role, previous_pid))
        return self.health(role)

    def prepare(self, role):
        self.calls.append(('prepared', role))
        if self.fail == 'prepare': raise RuntimeError('candidate source not selected')
    def install_room_launcher(self):
        self.calls.append(('room-launcher',))
        return 'fixture-dropin', '123' if self.migration else None
    def finish_room_migration(self, migration): self.calls.append(('room-migration-finished',))


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

    def test_real_listener_losses_do_not_prove_or_cancel_a_replacement(self):
        self.responses = ['reset', 'disconnect', 'truncated', 'old', 'new']
        self.assertEqual(self.host.ready('rooms')['releaseCommit'], 'new')
        self.assertEqual(self.requests, 5)
        self.host.deadline = time.monotonic() + .15
        with patch.object(self.host, 'command') as command:
            with self.assertRaises(Deferred): self.host.ready('rooms')
            command.assert_not_called()
        with patch.object(self.host, 'command', return_value='active'):
            with self.assertRaisesRegex(RuntimeError, 'running release'): prove(self.host)


class Activation(unittest.TestCase):
    def test_busy_or_non_graceful_owner_is_preserved_without_an_admission_gate(self):
        for host in [Host(protocol=None), Host(busy=True), Host(protocol=1, busy=True)]:
            with self.assertRaises(Deferred): activate(host)
            self.assertFalse(any(call[:2] in [('systemctl', 'restart'), ('systemctl', 'reload')] for call in host.calls))
            self.assertFalse(host.paused)
            if host.protocol is None:
                self.assertNotIn(('POST', '/v1/admin/release'), host.calls)

    def test_only_stale_consumers_are_replaced_with_own_drain_and_running_proof(self):
        host = Host(migration=True)
        result = activate(host)
        self.assertTrue(result['enabled'])
        self.assertEqual([call[-1] for call in host.calls if call[:2] == ('systemctl', 'restart')], ['pi-kenan-memory.service', 'pi-kenan-root.service'])
        for role, unit in [('memory', 'pi-kenan-memory.service'), ('root', 'pi-kenan-root.service')]:
            self.assertLess(host.calls.index(('prepared', role)), host.calls.index(('POST', '/v1/admin/release')))
            self.assertLess(host.calls.index(('prepared', role)), host.calls.index(('systemctl', 'restart', '--no-block', unit)))
        self.assertIn(('ready', 'rooms', '123'), host.calls)
        self.assertFalse(host.paused)
        self.assertFalse(any('custody' in ' '.join(call) for call in host.calls))
        with self.assertRaisesRegex(RuntimeError, 'running release'): prove(Host())

    def test_prepared_protocol_one_idle_owner_is_replaced_before_memory_or_rooms(self):
        host = Host(protocol=1)
        self.assertTrue(activate(host)['enabled'])
        self.assertEqual([call[-1] for call in host.calls if call[:2] == ('systemctl', 'restart')], ['pi-kenan-root.service', 'pi-kenan-memory.service'])
        pause = host.calls.index(('POST', '/v1/admin/release'))
        restart = host.calls.index(('systemctl', 'restart', '--no-block', 'pi-kenan-root.service'))
        self.assertEqual(host.calls[pause + 1:restart], [('systemctl', 'show', 'pi-kenan-root.service', '-p', 'MainPID', '--value')])
        self.assertLess(host.calls.index(('ready', 'root', '123')), host.calls.index(('systemctl', 'restart', '--no-block', 'pi-kenan-memory.service')))
        self.assertEqual(host.protocol, 2)
        self.assertFalse(host.paused)

    def test_generation_change_after_atomic_idle_cannot_restart_a_new_owner(self):
        host = Host(protocol=1)
        original = host.command
        def changed(*args):
            result = original(*args)
            return '456' if 'MainPID' in args and ('POST', '/v1/admin/release') in host.calls else result
        host.command = changed
        with self.assertRaisesRegex(Deferred, 'generation changed'): activate(host)
        self.assertFalse(host.paused)
        self.assertFalse(any(call[:2] == ('systemctl', 'restart') for call in host.calls))

    def test_unprepared_candidate_never_closes_old_intake(self):
        host = Host(protocol=1, fail='prepare')
        with self.assertRaisesRegex(RuntimeError, 'not selected'): activate(host)
        self.assertFalse(host.paused)
        self.assertNotIn(('POST', '/v1/admin/release'), host.calls)
        self.assertFalse(any(call[:2] == ('systemctl', 'restart') for call in host.calls))

    def test_unchanged_consumers_do_not_pause_dispatch_or_restart(self):
        host = Host(selected=True)
        activate(host)
        self.assertFalse(any(call[0] in ['POST', 'DELETE'] or call[:2] in [('systemctl', 'restart'), ('systemctl', 'reload')] for call in host.calls))

    def test_failed_activation_resumes_dispatch_without_claiming_success(self):
        host = Host(fail='memory')
        with self.assertRaisesRegex(RuntimeError, 'failed restart'): activate(host)
        self.assertFalse(host.paused)
        self.assertEqual(host.calls[-1], ('DELETE', '/v1/admin/release'))
        self.assertFalse(any(call[:2] == ('systemctl', 'reload') for call in host.calls))

    def test_lost_pause_ack_resumes_dispatch_without_restart(self):
        host = Host()
        original = host.http
        def lost(role, path, method='GET'):
            result = original(role, path, method)
            return (0, {}) if method == 'POST' else result
        host.http = lost
        with self.assertRaisesRegex(Deferred, 'not confirmed'): activate(host)
        self.assertFalse(host.paused)
        self.assertEqual(host.calls[-1], ('DELETE', '/v1/admin/release'))
        self.assertFalse(any(call[:2] == ('systemctl', 'restart') for call in host.calls))

    def test_room_only_handoff_is_independent_of_root_protocol(self):
        host = Host(protocol=None)
        result = activate_rooms(host)
        self.assertEqual(list(result['consumers']), ['rooms'])
        self.assertIn(('systemctl', 'reload', '--no-block', 'pi-rooms.service'), host.calls)
        self.assertFalse(any(call[0] in ['POST', 'DELETE'] or 'pi-kenan-root.service' in call or 'pi-kenan-memory.service' in call for call in host.calls))


if __name__ == '__main__':
    unittest.main()
