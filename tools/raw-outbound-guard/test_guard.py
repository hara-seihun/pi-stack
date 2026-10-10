import contextlib
import io
import json
import os
import pathlib
import runpy
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
guard = runpy.run_path(str(ROOT / 'tools/raw-outbound-guard/main'))
deployment = runpy.run_path(str(ROOT / 'deploy/outbound-transports'))


class GuardContract(unittest.TestCase):
    def invoke(self, name, args):
        effect = Mock()
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            code = guard['main'](name, args, {name: '/fixture/provider'}, effect)
        return code, effect, output.getvalue()

    def test_outbound_never_executes_provider(self):
        signal = ['send', 'sendReaction', 'sendReceipt', 'sendTyping', 'remoteDelete',
                  'updateGroup', 'startCall', 'link', 'jsonRpc', 'daemon', 'futureMethod']
        for command in signal:
            with self.subTest(command=command):
                code, effect, output = self.invoke('signal-cli', ['-a', '+15550000000', command, '--help'])
                self.assertEqual(code, 77)
                effect.assert_not_called()
                value = json.loads(output)
                self.assertEqual(value['error'], 'canonical-action-required')
                self.assertEqual(value['effect'], 'not-dispatched')
                self.assertNotIn('+1555', output)
        for name, args in [('msmtp', ['-t']), ('msmtp', ['recipient@example.test']),
                           ('msmtp', ['--serverinfo', '--rmqs=queue']),
                           ('msmtp', ['--auth', '--rmqs=queue', '--serverinfo']),
                           ('msmtp', ['--serverinfo', '--passwordeval=anything']),
                           ('sendmail', ['-t']), ('sendmail', ['-bv', 'recipient']),
                           ('sendmail', ['-bp', 'recipient'])]:
            with self.subTest(name=name, args=args):
                code, effect, _ = self.invoke(name, args)
                self.assertEqual(code, 77)
                effect.assert_not_called()

    def test_read_paths_preserve_exact_arguments(self):
        for name, args in [('signal-cli', ['--help']),
                           ('signal-cli', ['--data-dir', '/fixture/state', 'listAccounts']),
                           ('signal-cli', ['--account=+15550000000', 'receive', '--timeout', '1']),
                           ('msmtp', ['--serverinfo', '--host=127.0.0.1', '--port=1025']),
                           ('msmtp', ['-C', '/fixture/config', '--pretend']),
                           ('msmtp', ['--version']), ('sendmail', ['-bp'])]:
            with self.subTest(name=name, args=args):
                code, effect, _ = self.invoke(name, args)
                self.assertEqual(code, 0)
                effect.assert_called_once_with('/fixture/provider', ['/fixture/provider', *args])

    def test_unset_provider_and_exec_failure_are_typed(self):
        for providers, effect in [({}, Mock()), ({'signal-cli': 'relative'}, Mock()),
                                   ({'signal-cli': '/missing'}, Mock(side_effect=FileNotFoundError()))]:
            with contextlib.redirect_stderr(io.StringIO()) as output:
                code = guard['main']('signal-cli', ['listAccounts'], providers, effect)
            self.assertEqual(code, 77)
            self.assertEqual(json.loads(output.getvalue())['error'], 'transport-unavailable')

    def test_guard_has_no_environment_bypass(self):
        with unittest.mock.patch.dict(os.environ, {'PI_ACTION_APPROVED': '1', 'PI_SIGNAL_PROVIDER_BINARY': '/bypass'}):
            code, effect, _ = self.invoke('signal-cli', ['jsonRpc'])
        self.assertEqual(code, 77)
        effect.assert_not_called()


class DeploymentContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.tools = '/srv/pi/tools'
        self.create('/srv/pi/tools/raw-outbound-guard/main', 'guard')
        self.diverted = False
        self.calls = []

    def create(self, name, contents):
        path = self.root / name.lstrip('/')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        return path

    def dpkg(self, argv, **options):
        self.calls.append(argv)
        if argv[1] == '--listpackage':
            output = 'LOCAL\n' if self.diverted else ''
        elif argv[1] == '--truename':
            output = '/usr/lib/pi-stack/providers/msmtp\n'
        else:
            self.assertEqual(argv[1:5], ['--local', '--add', '--rename', '--divert'])
            source = self.root / 'usr/bin/msmtp'
            destination = self.root / 'usr/lib/pi-stack/providers/msmtp'
            shutil.move(source, destination)
            self.diverted = True
            output = ''
        return subprocess.CompletedProcess(argv, 0, output, '')

    def test_absolute_msmtp_signal_and_path_routes_fenced_idempotently(self):
        self.create('/usr/bin/msmtp', 'smtp provider')
        signal = self.create('/opt/signal-fixture/bin/signal-cli', 'signal provider')
        global_signal = self.root / 'usr/local/bin/signal-cli'
        global_signal.parent.mkdir(parents=True)
        global_signal.symlink_to('/opt/signal-fixture/bin/signal-cli')
        system_sendmail = self.create('/usr/sbin/sendmail', 'postfix local provider')
        providers = deployment['install'](self.root, self.tools, self.dpkg)
        guard_path = '/srv/pi/tools/raw-outbound-guard/main'
        self.assertEqual(os.readlink(signal), guard_path)
        self.assertEqual(os.readlink(self.root / 'usr/bin/msmtp'), guard_path)
        self.assertEqual((signal.parent / 'signal-cli-provider').read_text(), 'signal provider')
        self.assertEqual(system_sendmail.read_text(), 'postfix local provider')
        self.assertEqual(os.readlink(self.root / 'usr/local/sbin/sendmail'), guard_path)
        self.assertEqual(providers['signal-cli'], '/opt/signal-fixture/bin/signal-cli-provider')
        again = deployment['install'](self.root, self.tools, self.dpkg)
        self.assertEqual(again, providers)
        self.assertEqual(sum('--add' in call for call in self.calls), 1)
        self.assertEqual(json.loads((self.root / 'etc/pi-stack/raw-outbound-transports.json').read_text()), providers)

    def test_interrupted_cutover_recovers_without_losing_previous_evidence(self):
        phases = ['boundary-persisted', 'msmtp-diverted', 'signal-provider-retained',
                  'declaration-persisted', 'signal-original-guarded', 'entrypoints-guarded']
        class Interrupted(BaseException):
            pass
        for phase in phases:
            with self.subTest(phase=phase):
                self.diverted = False
                self.calls.clear()
                with tempfile.TemporaryDirectory() as temporary:
                    self.root = pathlib.Path(temporary)
                    self.create('/srv/pi/tools/raw-outbound-guard/main', 'guard')
                    self.create('/usr/bin/msmtp', 'smtp provider')
                    self.create('/opt/signal-fixture/bin/signal-cli', 'signal provider')
                    route = self.root / 'usr/local/bin/signal-cli'
                    route.parent.mkdir(parents=True)
                    route.symlink_to('/opt/signal-fixture/bin/signal-cli')
                    previous = '{ "sendmail": "/usr/sbin/sendmail" }\n'
                    self.create('/etc/pi-stack/raw-outbound-transports.json', previous)
                    self.create('/usr/sbin/sendmail', 'system local mail')
                    def crash(point):
                        if point == phase:
                            raise Interrupted()
                    with self.assertRaises(Interrupted):
                        deployment['install'](self.root, self.tools, self.dpkg, crash)
                    state_file = self.root / 'etc/pi-stack/outbound-transport-transition.json'
                    pending = json.loads(state_file.read_text())
                    self.assertEqual(pending['phase'], 'installing')
                    self.assertEqual(pending['boundary'], 'host-declared-provider-v1')
                    self.assertEqual(pending['previous']['declaration'], {'state': 'set', 'text': previous})
                    self.assertEqual(pending['previous']['routes']['/usr/local/bin/signal-cli'],
                                     {'kind': 'symlink', 'target': '/opt/signal-fixture/bin/signal-cli'})
                    recovered = deployment['install'](self.root, self.tools, self.dpkg)
                    complete = json.loads(state_file.read_text())
                    self.assertEqual(complete['phase'], 'installed')
                    self.assertEqual(complete['previous'], pending['previous'])
                    self.assertEqual(sum('--add' in call for call in self.calls), 1)
                    self.assertEqual(recovered['signal-cli'], '/opt/signal-fixture/bin/signal-cli-provider')
                    self.assertEqual(os.readlink(self.root / 'opt/signal-fixture/bin/signal-cli'),
                                     '/srv/pi/tools/raw-outbound-guard/main')
                    self.assertEqual((self.root / 'usr/sbin/sendmail').read_text(), 'system local mail')

    def test_malformed_boundary_does_not_reconstruct_permission(self):
        self.create('/etc/pi-stack/outbound-transport-transition.json', '{"version":2}')
        with self.assertRaises(deployment['InstallationError']):
            deployment['install'](self.root, self.tools, self.dpkg)
        self.assertFalse(self.calls)

    def test_host_without_transports_gets_explicit_empty_declaration(self):
        self.assertEqual(deployment['install'](self.root, self.tools, self.dpkg), {})
        self.assertFalse(self.calls)

    def test_unrelated_package_diversion_is_refused(self):
        self.create('/usr/bin/msmtp', 'other owner')
        def other(argv, **options):
            return subprocess.CompletedProcess(argv, 0, 'other-package' if argv[1] == '--listpackage' else '/somewhere', '')
        with self.assertRaises(deployment['InstallationError']):
            deployment['install'](self.root, self.tools, other)
        self.assertEqual((self.root / 'usr/bin/msmtp').read_text(), 'other owner')


if __name__ == '__main__':
    unittest.main()
