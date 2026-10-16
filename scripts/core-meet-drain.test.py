from importlib.machinery import SourceFileLoader
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy'))
owner=SourceFileLoader('core_meet_drain_test',str(Path(__file__).resolve().parents[1]/'deploy/core-meet-drain')).load_module()

class PositiveMeetExit(unittest.TestCase):
    def test_only_exact_normal_kernel_exit_acknowledges_database_close(self):
        self.assertTrue(owner.normal_exit('exit_group(0) = ?\n+++ exited with 0 +++\n'))
        for trace in ['','+++ exited with 0 +++\n','exit_group(1) = ?\n+++ exited with 1 +++','--- SIGTERM {si_signo=SIGTERM} ---\n+++ killed by SIGTERM +++']:
            self.assertFalse(owner.normal_exit(trace))

    def test_actual_kernel_normal_exit_trace(self):
        with tempfile.TemporaryDirectory() as folder:
            trace=Path(folder)/'exit.trace'
            subprocess.run(['/usr/bin/strace','-e','trace=exit_group','-o',str(trace),'/usr/bin/python3','-c','raise SystemExit(0)'],check=True,capture_output=True,timeout=3)
            self.assertTrue(owner.normal_exit(trace.read_text()))

if __name__=='__main__':unittest.main()
