#!/usr/bin/env python3
import importlib.machinery
import importlib.util
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

root = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(root/'deploy'))
loader = importlib.machinery.SourceFileLoader('witness', str(root/'deploy/core-remote-witness'))
spec = importlib.util.spec_from_loader(loader.name, loader)
witness = importlib.util.module_from_spec(spec)
loader.exec_module(witness)


class WitnessTests(unittest.TestCase):
    def test_exact_native_child_positive_exit(self):
        text = 'wait4(-1, {WIFEXITED(s) && WEXITSTATUS(s) == 0}, WNOHANG, NULL) = 417\n'
        self.assertEqual(witness.wait4_exit(text,417), {'kind':'normal','code':0})
        with self.assertRaises(ValueError):witness.wait4_exit(text,418)

    def test_child_failure_cannot_be_masked_by_wrapper_exit0(self):
        text = 'wait4(-1, {WIFEXITED(s) && WEXITSTATUS(s) == 1}, WNOHANG, NULL) = 417\n+++ exited with 0 +++\n'
        with self.assertRaises(ValueError):witness.wait4_exit(text,417)
        with self.assertRaises(ValueError):witness.wait4_exit('+++ exited with 0 +++',417)

    def test_signalled_or_conflicting_native_exit_refused(self):
        text = 'wait4(-1, {WIFSIGNALED(s) && WTERMSIG(s) == SIGKILL}, 0, NULL) = 417\n'
        with self.assertRaises(ValueError):witness.wait4_exit(text,417)
        text = 'wait4(-1, {WIFEXITED(s) && WEXITSTATUS(s) == 0}, 0, NULL) = 417\n'
        with self.assertRaises(ValueError):witness.wait4_exit(text+text,417)

    def test_actual_kernel_wait4_format(self):
        if not Path('/usr/bin/strace').exists():self.skipTest('strace missing')
        with tempfile.TemporaryDirectory() as folder:
            trace = Path(folder)/'wait4.txt'
            result = subprocess.run(['/usr/bin/strace','-qq','-e','trace=wait4','-e','signal=none','-o',str(trace),'/bin/bash','-c','/bin/sleep 0.02 & wait'], capture_output=True,timeout=3)
            self.assertEqual(result.returncode,0,result.stderr)
            text = trace.read_text()
            child = int(re.search(r'WEXITSTATUS\(s\) == 0.*= ([0-9]+)',text)[1])
            self.assertEqual(witness.wait4_exit(text,child),{'kind':'normal','code':0})


if __name__ == '__main__':unittest.main()
