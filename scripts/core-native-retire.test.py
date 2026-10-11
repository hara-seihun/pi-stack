#!/usr/bin/python3 -B
from importlib.machinery import SourceFileLoader
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy'))
retirement = SourceFileLoader('native_retirement', str(ROOT / 'deploy/core-native-retire')).load_module()


class NativeRetirement(unittest.TestCase):
    def test_actual_installed_idle_guard_is_required_before_halt(self):
        root = Path('/srv/pi/.pi-stack-releases/orchestrator/9cb7a562eae743da73c2fdfd0d1ac02422600b31/dist/threads')
        if not root.exists():
            self.skipTest('original installed source not present on fixture host')
        host = (root / 'runner-host.js').read_text()
        adapter = (root / 'pi-session.js').read_text()
        retirement.source_guard(host, adapter)
        for invalid in [adapter.replace('execution.blocked', 'false'), adapter.replace('runtime.session.isBashRunning', 'false'), adapter.replace('close: () => piEnvironmentScope.run(env, async () => {', 'close: () => piEnvironmentScope.run(env, async () => { await halt();')]:
            with self.assertRaises(ValueError):
                retirement.source_guard(host, invalid)

    def test_self_exit_requires_every_original_close_ack_and_kernel_success(self):
        before = {'pid': 44, 'threadIds': ['original']}
        closes = [{'threadId': 'original', 'acknowledgement': {'ok': True, 'pid': 44}}]
        trace = 'exit_group(0) = ?\n+++ exited with 0 +++\n'
        self.assertTrue(retirement.acknowledged_self_exit(before, closes, trace))
        for changed in [[], [{'threadId': 'original', 'acknowledgement': {'ok': True, 'pid': 45}}], [{'threadId': 'other', 'acknowledgement': {'ok': True, 'pid': 44}}]]:
            self.assertFalse(retirement.acknowledged_self_exit(before, changed, trace))
        self.assertFalse(retirement.acknowledged_self_exit(before, closes, ''))

    def test_launcher_argv_is_not_a_second_native_controller(self):
        control='/data/thread-runners/abcdef0123456789.sock'
        args=[b'/usr/local/bin/node',b'/release/dist/threads/runner-host.js',control.encode()]
        self.assertTrue(retirement.native_owner_command(args,'/usr/local/bin/node',control))
        for launcher in ('/usr/bin/systemd-run','/usr/bin/bash','/usr/bin/flock'):
            self.assertFalse(retirement.native_owner_command(args,launcher,control))
        self.assertFalse(retirement.native_owner_command(args,'/usr/local/bin/node',control+'.other'))

    def test_missing_pid_or_trace_is_not_a_positive_exit(self):
        self.assertTrue(retirement.normal_exit('exit_group(0) = ?\n+++ exited with 0 +++\n'))
        for trace in ['', '+++ exited with 0 +++', 'exit_group(0) = ?\n+++ killed by SIGTERM +++', 'exit_group(1) = ?\n+++ exited with 1 +++']:
            self.assertFalse(retirement.normal_exit(trace))


if __name__ == '__main__':
    unittest.main()
