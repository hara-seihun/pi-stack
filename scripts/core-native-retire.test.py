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

    def test_missing_pid_or_trace_is_not_a_positive_exit(self):
        self.assertTrue(retirement.normal_exit('exit_group(0) = ?\n+++ exited with 0 +++\n'))
        for trace in ['', '+++ exited with 0 +++', 'exit_group(0) = ?\n+++ killed by SIGTERM +++', 'exit_group(1) = ?\n+++ exited with 1 +++']:
            self.assertFalse(retirement.normal_exit(trace))


if __name__ == '__main__':
    unittest.main()
