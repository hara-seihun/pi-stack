#!/usr/bin/python3
import pathlib
import runpy
import unittest

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

if __name__ == '__main__': unittest.main()
